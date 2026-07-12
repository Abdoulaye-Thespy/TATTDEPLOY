import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { Op } from 'sequelize';
import { Cron, CronExpression } from '@nestjs/schedule';
import { BadRequestException } from '@nestjs/common';
import Stripe from 'stripe';

import { User } from '../iam/entities/user.entity';
import { CommunityTier, AccountFlags } from '../iam/enums/roles.enum';

import { MailService } from '../../common/mail/mail.service';
import { NotificationsService } from '../notifications/services/notifications.service';
import { SystemSettingsService } from '../system-settings/system-settings.service';
import { NotificationType } from '../notifications/entities/notification.entity';
import { EventRegistration } from '../events/entities/event-registration.entity';
import { MembershipPlan } from '../membership/entities/membership-plan.entity';
import { Discount, DiscountType } from '../membership/entities/discount.entity';
import { Chapter } from '../chapters/entities/chapter.entity';
import { FinancialTransaction, TransactionStatus, TransactionType } from '../revenue/entities/financial-transaction.entity';
import { Order, OrderStatus } from '../store/entities/order.entity';

@Injectable()
export class BillingService {
    private readonly logger = new Logger(BillingService.name);
    private stripe: Stripe;

    constructor(
        @InjectModel(User) private userRepository: typeof User,
        @InjectModel(EventRegistration) private eventRegistrationRepo: typeof EventRegistration,
        @InjectModel(MembershipPlan) private planRepo: typeof MembershipPlan,
        @InjectModel(Discount) private discountRepo: typeof Discount,
        @InjectModel(FinancialTransaction) private transactionRepo: typeof FinancialTransaction,
        @InjectModel(Order) private orderRepo: typeof Order,
        private mailService: MailService,
        private notificationsService: NotificationsService,
        private settingsService: SystemSettingsService,
    ) { }

    private async getStripe(): Promise<Stripe> {
        return this.settingsService.getStripeInstance();
    }

    async handleStripeWebhook(payload: Buffer, signature: string) {
        const webhookSecret = await this.settingsService.getStripeWebhookSecret();

        let event: Stripe.Event;

        try {
            event = (await this.getStripe()).webhooks.constructEvent(payload, signature, webhookSecret);
        } catch (err: any) {
            this.logger.error(`Webhook signature verification failed: ${err.message}`);
            throw new Error('Webhook Signature Failed');
        }

        switch (event.type) {
            case 'customer.subscription.deleted':
            case 'customer.subscription.updated': {
                const subscription = event.data.object as Stripe.Subscription;
                if (['canceled', 'unpaid', 'past_due'].includes(subscription.status)) {
                    await this.handleSubscriptionExpiredOrFailed(subscription);
                } else {
                    await this.handleSubscriptionAutoPayStatus(subscription);
                }
                break;
            }
            case 'invoice.payment_succeeded': {
                const invoice = event.data.object as Stripe.Invoice;
                await this.handleSubscriptionRenewalSuccess(invoice);
                break;
            }
            case 'checkout.session.completed': {
                const session = event.data.object as Stripe.Checkout.Session;
                if (session.metadata?.type === 'EVENT_REGISTRATION') {
                    await this.handleEventRegistrationPayment(session);
                } else if (session.metadata?.type === 'STORE_ORDER') {
                    await this.handleStoreOrderPayment(session);
                }
                break;
            }
            default:
                this.logger.log(`Unhandled Stripe event type: ${event.type}`);
        }
    }

    private async handleEventRegistrationPayment(session: Stripe.Checkout.Session) {
        const registrationId = session.metadata?.registrationId;
        if (!registrationId) return;

        const registration = await this.eventRegistrationRepo.findByPk(registrationId);
        if (!registration) {
            this.logger.error(`Event registration not found for ID: ${registrationId}`);
            return;
        }

        registration.status = 'COMPLETED';
        registration.stripePaymentIntentId = session.payment_intent as string;
        await registration.save();

        this.logger.log(`Event registration ${registrationId} payment confirmed and status updated to COMPLETED.`);
    }

    private async handleStoreOrderPayment(session: Stripe.Checkout.Session) {
        const orderId = session.metadata?.orderId;
        if (!orderId) return;

        const order = await this.orderRepo.findByPk(orderId, { include: [{ model: User, as: 'customer' }] });
        if (!order) {
            this.logger.error(`Store order not found for ID: ${orderId}`);
            return;
        }

        order.status = OrderStatus.CONFIRMED;
        await order.save();

        // LOG REVENUE TRANSACTION
        await this.transactionRepo.create({
            userId: order.customerId,
            chapterId: order.customer?.chapterId,
            type: TransactionType.PRODUCT_SALE,
            amount: (session.amount_total || 0) / 100,
            currency: session.currency?.toUpperCase() || 'USD',
            status: TransactionStatus.COMPLETED,
            stripePaymentIntentId: session.payment_intent as string,
            referenceNumber: order.orderNumber,
            metadata: { orderId: order.id }
        } as any);

        this.logger.log(`Store order ${order.orderNumber} payment confirmed.`);
    }

    private async handleSubscriptionExpiredOrFailed(subscription: Stripe.Subscription) {
        const customerId = subscription.customer as string;

        const user = await this.userRepository.findOne({ where: { stripeCustomerId: customerId } });
        if (!user) {
            this.logger.warn(`Webhook received for unknown Stripe Customer ID: ${customerId}`);
            return;
        }

        if (subscription.status === 'canceled' || subscription.status === 'unpaid' || subscription.status === 'past_due') {
            user.communityTier = CommunityTier.FREE;
            user.subscriptionExpiresAt = null;
            await user.save();

            this.logger.log(`User ${user.email} downgraded to FREE tier`);
            // Send downgrade notification email
            await this.mailService.sendSubscriptionDowngradeNotice(user.email, user.firstName, subscription.status);

            // In-app notification
            await this.notificationsService.create(
                user.id,
                NotificationType.SUBSCRIPTION_DOWNGRADE,
                'Membership Tier Updated',
                `Your membership has been downgraded to the Free tier. Reason: ${subscription.status.replace('_', ' ')}.`,
                { status: subscription.status },
                false // Email already sent above
            );
        }
    }

    private async handleSubscriptionRenewalSuccess(invoice: Stripe.Invoice) {
        const invoiceSub = (invoice as any).subscription as string;
        if (!invoiceSub) return;

        const customerId = invoice.customer as string;
        const user = await this.userRepository.findOne({ where: { stripeCustomerId: customerId } });

        if (!user) {
            this.logger.warn(`Webhook received renewal for unknown Stripe Customer ID: ${customerId}`);
            return;
        }

        const subscriptionResp = await (await this.getStripe()).subscriptions.retrieve(invoiceSub);
        const currentPeriodEnd = (subscriptionResp as any).current_period_end;

        const expiresAt = new Date(currentPeriodEnd * 1000);
        user.subscriptionExpiresAt = expiresAt;
        await user.save();

        // LOG REVENUE TRANSACTION
        await this.transactionRepo.create({
            userId: user.id,
            chapterId: user.chapterId,
            type: TransactionType.SUBSCRIPTION,
            amount: (invoice.amount_paid || 0) / 100,
            currency: invoice.currency?.toUpperCase() || 'USD',
            status: TransactionStatus.COMPLETED,
            stripePaymentIntentId: (invoice as any).payment_intent as string,
            membershipTier: user.communityTier,
            referenceNumber: `INV-${invoice.id}`,
        } as any);

        this.logger.log(`User ${user.email} subscription automatically renewed until ${expiresAt.toISOString()}`);

        // In-app & email notification
        await this.notificationsService.create(
            user.id,
            NotificationType.SUBSCRIPTION_RENEWAL,
            'Subscription Renewed Successfully',
            `Your TATT membership has been automatically renewed until ${expiresAt.toLocaleDateString()}.`,
            { expiresAt },
            true // Notify via email as well
        );
    }

    private async handleSubscriptionAutoPayStatus(subscription: Stripe.Subscription) {
        const customerId = subscription.customer as string;
        const user = await this.userRepository.findOne({ where: { stripeCustomerId: customerId } });
        if (!user) return;

        const isAutoPayEnabled = !subscription.cancel_at_period_end;
        if (user.hasAutoPayEnabled !== isAutoPayEnabled) {
            user.hasAutoPayEnabled = isAutoPayEnabled;
            await user.save();
            this.logger.log(`User ${user.email} auto-pay status updated to: ${isAutoPayEnabled}`);
        }
    }

    // --- ADMIN SUBSCRIPTION VIEWS ---

    async getAllSubscribers() {
        return this.userRepository.findAll({
            where: {
                communityTier: { [Op.ne]: CommunityTier.FREE },
            },
            attributes: ['id', 'firstName', 'lastName', 'email', 'communityTier', 'subscriptionExpiresAt', 'billingCycle', 'hasAutoPayEnabled', 'systemRole']
        });
    }

    async getUpcomingRenewals() {
        const nextWeek = new Date();
        nextWeek.setDate(nextWeek.getDate() + 7);

        return this.userRepository.findAll({
            where: {
                communityTier: { [Op.ne]: CommunityTier.FREE },
                billingCycle: 'MONTHLY',
                hasAutoPayEnabled: false,
                subscriptionExpiresAt: {
                    [Op.and]: {
                        [Op.gte]: new Date(),
                        [Op.lte]: nextWeek
                    }
                }
            },
            attributes: ['id', 'firstName', 'lastName', 'email', 'communityTier', 'subscriptionExpiresAt']
        });
    }

    async notifyUpcomingRenewals() {
        const usersToNotify = await this.getUpcomingRenewals();

        let sentCount = 0;
        for (const user of usersToNotify) {
            await this.mailService.sendRenewalReminder(user.email, user.firstName, user.subscriptionExpiresAt);

            await this.notificationsService.create(
                user.id,
                NotificationType.SUBSCRIPTION_EXPIRING,
                'Membership Renewal Reminder',
                `Your TATT membership is expiring on ${user.subscriptionExpiresAt.toLocaleDateString()}. Please renew soon to maintain access.`,
                { expiresAt: user.subscriptionExpiresAt },
                false // Email already sent above
            );

            sentCount++;
        }

        return { message: `Notified ${sentCount} community members about upcoming renewals.` };
    }

    @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
    async handleScheduledRenewalNotifications() {
        this.logger.log('Running scheduled renewal notifications check...');

        // Notify those expiring in 7 days (standard)
        await this.notifyUpcomingRenewals();

        // Also notify those expiring in 1 day for urgency
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        const soonExpiring = await this.userRepository.findAll({
            where: {
                communityTier: { [Op.ne]: CommunityTier.FREE },
                subscriptionExpiresAt: {
                    [Op.and]: {
                        [Op.gte]: new Date(),
                        [Op.lte]: tomorrow
                    }
                }
            }
        });

        for (const user of soonExpiring) {
            await this.notificationsService.create(
                user.id,
                NotificationType.SUBSCRIPTION_EXPIRING,
                'Urgent: Membership Expiring Tomorrow',
                `Your TATT membership expires tomorrow. Renew today to avoid interruption.`,
                { expiresAt: user.subscriptionExpiresAt },
                true
            );
        }
    }

    /**
     * Periodically checks for members who upgraded to a paid plan but haven't received their ID card notification.
     * Runs every 30 minutes.
     */
    @Cron(CronExpression.EVERY_30_MINUTES)
    async handleMemberIdGenerationAndNotification() {
        this.logger.log('Running background process for Member ID card generation and notification...');

        const usersToNotify = await this.userRepository.findAll({
            where: {
                communityTier: { [Op.ne]: CommunityTier.FREE },
                [Op.not]: {
                    flags: { [Op.contains]: [AccountFlags.MEMBER_ID_NOTIFIED] }
                }
            },
            include: [{ model: Chapter, as: 'chapter' }]
        });

        if (usersToNotify.length === 0) return;

        this.logger.log(`Found ${usersToNotify.length} members eligible for ID card notification.`);

        for (const user of usersToNotify) {
            try {
                // 1. Ensure/Refresh Member ID if needed (e.g. if they just joined a chapter)
                let idChanged = false;
                if (user.chapterId && user.chapter) {
                    const expectedId = `TATT-${user.chapter.code}-${user.sequenceNumber}`;
                    if (user.tattMemberId !== expectedId) {
                        user.tattMemberId = expectedId;
                        idChanged = true;
                    }
                } else if (!user.tattMemberId) {
                    user.tattMemberId = `TATT-XXXX-${user.sequenceNumber}`;
                    idChanged = true;
                }

                if (idChanged) {
                    await user.save();
                }

                // 2. Create in-app notification
                await this.notificationsService.create(
                    user.id,
                    NotificationType.ACCOUNT,
                    'Membership ID Card Generated!',
                    `Congratulations! Your official TATT Member ID card (${user.tattMemberId}) is now available in your profile. Use it for exclusive discounts at TATT partners.`,
                    { tattMemberId: user.tattMemberId },
                    false // Don't send double email
                );

                // 3. Send notification email
                await this.mailService.sendNotificationEmail(
                    user.email,
                    user.firstName,
                    'Your TATT Member ID Card is Ready!',
                    `Congratulations on becoming a ${user.communityTier} member! Your official TATT Member ID card has been generated. You can now view and download a digital copy from your dashboard profile.\n\nYour Member ID: ${user.tattMemberId}\n\nUse this ID to unlock exclusive discounts and benefits across our global network of TATT partners and community-supported businesses.`,
                    `${process.env.FRONTEND_URL}/dashboard/network/${user.id}`,
                    'View My ID Card'
                );

                // 4. Update flags to prevent duplicate notifications
                const newFlags = [...(user.flags || []), AccountFlags.MEMBER_ID_NOTIFIED];
                user.set('flags', newFlags);
                await user.save();

                this.logger.log(`Notified user ${user.email} about their new Member ID card.`);
            } catch (err: any) {
                this.logger.error(`Failed to process ID card notification for user ${user.id}: ${err.message}`);
            }
        }
    }

    async getDefaultPaymentMethod(userId: string) {
        const user = await this.userRepository.findByPk(userId);
        if (!user || !user.stripeCustomerId) return null;

        try {
            const customer = await (await this.getStripe()).customers.retrieve(user.stripeCustomerId, {
                expand: ['invoice_settings.default_payment_method']
            }) as Stripe.Customer;

            const pm = customer.invoice_settings.default_payment_method as Stripe.PaymentMethod;
            if (!pm || pm.type !== 'card') return null;

            return {
                last4: pm.card?.last4,
                brand: pm.card?.brand,
                exp_month: pm.card?.exp_month,
                exp_year: pm.card?.exp_year,
            };
        } catch (err: any) {
            this.logger.error(`Failed to fetch payment method for user ${userId}: ${err.message}`);
            return null;
        }
    }

    async updatePaymentMethod(userId: string, paymentMethodId: string) {
        const user = await this.userRepository.findByPk(userId);
        if (!user) throw new Error('User not found');

        try {
            // 1. Ensure/Create Stripe Customer
            if (!user.stripeCustomerId) {
                const customer = await (await this.getStripe()).customers.create({
                    email: user.email,
                    name: `${user.firstName} ${user.lastName}`,
                    payment_method: paymentMethodId,
                    invoice_settings: { default_payment_method: paymentMethodId },
                });
                user.stripeCustomerId = customer.id;
                await user.save();
            } else {
                // 2. Attach new payment method
                await (await this.getStripe()).paymentMethods.attach(paymentMethodId, { customer: user.stripeCustomerId });
                // 3. Set as default
                await (await this.getStripe()).customers.update(user.stripeCustomerId, {
                    invoice_settings: { default_payment_method: paymentMethodId },
                });
            }

            return { message: 'Payment method updated successfully.' };
        } catch (err: any) {
            this.logger.error(`Failed to update payment method for user ${userId}: ${err.message}`);
            throw new Error(`Payment method update failed: ${err.message}`);
        }
    }

    async toggleAutoPay(userId: string, enabled: boolean) {
        const user = await this.userRepository.findByPk(userId);
        if (!user || !user.stripeCustomerId) throw new Error('Subscription not found');

        try {
            const subscriptions = await (await this.getStripe()).subscriptions.list({
                customer: user.stripeCustomerId,
                status: 'active',
                limit: 1
            });

            if (subscriptions.data.length === 0) {
                // Just update local flag if no active Stripe sub found (might be a mock or already manual)
                user.hasAutoPayEnabled = enabled;
                await user.save();
                return { message: `Auto-pay ${enabled ? 'enabled' : 'disabled'} locally.` };
            }

            const subscription = subscriptions.data[0];
            await (await this.getStripe()).subscriptions.update(subscription.id, {
                cancel_at_period_end: !enabled
            });

            user.hasAutoPayEnabled = enabled;
            await user.save();

            return { message: `Auto-pay successfully ${enabled ? 'enabled' : 'disabled'}.` };
        } catch (err: any) {
            this.logger.error(`Failed to toggle auto-pay for user ${userId}: ${err.message}`);
            throw new Error(`Failed to update auto-pay: ${err.message}`);
        }
    }

    async getPlans() {
        const plans = await this.planRepo.findAll({
            order: [['monthlyPrice', 'ASC']]
        });

        const activeDiscounts = await this.discountRepo.findAll({
            where: {
                isActive: true,
                [Op.or]: [
                    { validUntil: null },
                    { validUntil: { [Op.gt]: new Date() } }
                ]
            }
        });

        // Attach applicable discounts to each plan
        return plans.map(plan => {
            const planData = plan.toJSON();
            const discount = activeDiscounts.find(d => {
                const ps = Array.isArray(d.applicablePlans) ? d.applicablePlans : [];
                return ps.includes(plan.tier);
            });

            if (discount) {
                planData.activeDiscount = {
                    code: discount.code,
                    name: discount.name,
                    value: discount.value,
                    type: discount.discountType,
                    validUntil: discount.validUntil,
                };
            }
            planData.isPopular = plan.tier === 'IMANI';
            return planData;
        });
    }

    async createSubscription(userId: string, tier: CommunityTier, billingCycle: 'MONTHLY' | 'YEARLY', paymentMethodId?: string) {
        const user = await this.userRepository.findByPk(userId);
        if (!user) throw new Error('User not found');

        // Always mark onboarding as completed when they choose ANY plan
        if (!user.flags.includes(AccountFlags.ONBOARDING_COMPLETED)) {
            user.flags = [...user.flags, AccountFlags.ONBOARDING_COMPLETED];
        }

        if (tier === CommunityTier.FREE) {
            user.communityTier = CommunityTier.FREE;
            user.subscriptionExpiresAt = null;
            await user.save();
            return {
                message: 'Joined Free tier successfully.',
                user: {
                    id: user.id,
                    firstName: user.firstName,
                    lastName: user.lastName,
                    email: user.email,
                    systemRole: user.systemRole,
                    communityTier: user.communityTier,
                    isActive: user.isActive,
                    flags: user.flags,
                    hasAutoPayEnabled: user.hasAutoPayEnabled,
                }
            };
        }
        // --- Paid Tiers Integration ---
        const tierPricingMap = {
            [CommunityTier.UBUNTU]: {
                MONTHLY: process.env.STRIPE_PRICE_UBUNTU_MONTHLY || 'price_ubuntu_monthly_mock',
                YEARLY: process.env.STRIPE_PRICE_UBUNTU_YEARLY || 'price_ubuntu_yearly_mock',
            },
            [CommunityTier.IMANI]: {
                MONTHLY: process.env.STRIPE_PRICE_IMANI_MONTHLY || 'price_imani_monthly_mock',
                YEARLY: process.env.STRIPE_PRICE_IMANI_YEARLY || 'price_imani_yearly_mock',
            },
            [CommunityTier.KIONGOZI]: {
                MONTHLY: process.env.STRIPE_PRICE_KIONGOZI_MONTHLY || 'price_kiongozi_monthly_mock',
                YEARLY: process.env.STRIPE_PRICE_KIONGOZI_YEARLY || 'price_kiongozi_yearly_mock',
            },
        };

        const priceId = tierPricingMap[tier]?.[billingCycle || 'MONTHLY'];
        if (!priceId) throw new Error('Selected membership tier is invalid or unavailable.');

        try {
            // 1. Ensure/Create Stripe Customer
            if (!user.stripeCustomerId) {
                const customer = await (await this.getStripe()).customers.create({
                    email: user.email,
                    name: `${user.firstName} ${user.lastName}`,
                    payment_method: paymentMethodId,
                    invoice_settings: { default_payment_method: paymentMethodId },
                });
                user.stripeCustomerId = customer.id;
                await user.save(); // Persist immediately to avoid orphans
            } else if (paymentMethodId) {
                // Update payment method if provided
                await (await this.getStripe()).paymentMethods.attach(paymentMethodId, { customer: user.stripeCustomerId });
                await (await this.getStripe()).customers.update(user.stripeCustomerId, {
                    invoice_settings: { default_payment_method: paymentMethodId },
                });
            }

            // Check for active discount for this plan
            const activeDiscount = await this.discountRepo.findOne({
                where: {
                    isActive: true,
                    applicablePlans: { [Op.contains]: [tier] }
                }
            });

            // 2. Create or Update Subscription
            if (!priceId.includes('mock') && !process.env.STRIPE_SECRET_KEY?.includes('placeholder')) {
                const stripe = await this.getStripe();
                const subscriptions = await stripe.subscriptions.list({
                    customer: user.stripeCustomerId!,
                    status: 'active',
                    limit: 1
                });

                if (subscriptions.data.length > 0) {
                    // Update existing
                    const subId = subscriptions.data[0].id;
                    await stripe.subscriptions.update(subId, {
                        items: [{
                            id: subscriptions.data[0].items.data[0].id,
                            price: priceId
                        }],
                        proration_behavior: 'always_invoice',
                        discounts: activeDiscount?.stripeCouponId ? [{ coupon: activeDiscount.stripeCouponId }] : undefined,
                    });
                } else {
                    // Create new
                    await stripe.subscriptions.create({
                        customer: user.stripeCustomerId!,
                        items: [{ price: priceId }],
                        discounts: activeDiscount?.stripeCouponId ? [{ coupon: activeDiscount.stripeCouponId }] : undefined,
                        expand: ['latest_invoice.payment_intent'],
                    });
                }
            } else {
                this.logger.warn(`Simulating Stripe Subscription for Tier: ${tier}`);
            }

            // 3. Update User Local State
            const durationMonths = billingCycle === 'YEARLY' ? 13 : 1;
            const expiresAt = new Date();
            expiresAt.setMonth(expiresAt.getMonth() + durationMonths);

            user.communityTier = tier;
            user.subscriptionExpiresAt = expiresAt;
            user.billingCycle = billingCycle;
            await user.save();

            // LOG REVENUE TRANSACTION (Simulate amount from tier if it's a mock)
            const plan = await this.planRepo.findOne({ where: { tier } });
            const amount = billingCycle === 'YEARLY' ? plan?.yearlyPrice : plan?.monthlyPrice;

            await this.transactionRepo.create({
                userId: user.id,
                chapterId: user.chapterId,
                type: TransactionType.SUBSCRIPTION,
                amount: amount || 0,
                currency: 'USD',
                status: TransactionStatus.COMPLETED,
                membershipTier: tier,
                referenceNumber: `SUB-${Date.now()}`,
            } as any);

            return {
                message: `${tier} subscription active.`,
                expiresAt,
                user: {
                    id: user.id,
                    firstName: user.firstName,
                    lastName: user.lastName,
                    email: user.email,
                    systemRole: user.systemRole,
                    communityTier: user.communityTier,
                    isActive: user.isActive,
                    flags: user.flags,
                    hasAutoPayEnabled: user.hasAutoPayEnabled,
                }
            };
        } catch (err: any) {
            this.logger.error('Subscription Error', err.message);
            throw new Error(`Failed to process subscription: ${err.message}`);
        }
    }

    async getRevenueMetrics() {

        let activeSubscriptions = 0;
        let estimatedMonthlyRevenue = 0;

        try {
            const subscriptions = await (await this.getStripe()).subscriptions.list({ status: 'active', limit: 100 });
            activeSubscriptions = subscriptions.data.length;

            for (const sub of subscriptions.data) {
                const price = (sub.items.data[0].price.unit_amount || 0) / 100;
                const interval = sub.items.data[0].price.recurring?.interval;

                if (interval === 'month') {
                    estimatedMonthlyRevenue += price;
                } else if (interval === 'year') {
                    estimatedMonthlyRevenue += (price / 12);
                }
            }

            return {
                activeSubscriptions,
                estimatedMonthlyRevenue,
                estimatedAnnualRunRate: estimatedMonthlyRevenue * 12,
                currency: 'USD'
            };
        } catch (error: any) {
            this.logger.error('Failed to fetch revenue metrics from Stripe', error.message);
            throw new Error('Failed to fetch financial metrics');
        }
    }

    /**
     * Confirme un paiement Stripe Checkout (paiement unique) et active le plan pour l'utilisateur.
     * @param userId ID de l'utilisateur
     * @param sessionId ID de la session Stripe
     * @param tier Plan choisi
     * @param cycle Cycle de facturation (MONTHLY / YEARLY)
     */
    async confirmPaymentAndSubscribe(
        userId: string,
        sessionId: string,
        tier: CommunityTier,
        cycle: 'MONTHLY' | 'YEARLY',
    ) {
        // 1. Récupérer la session Stripe
        const session = await this.stripe.checkout.sessions.retrieve(sessionId);

        // 2. Vérifier le statut du paiement
        if (session.payment_status !== 'paid') {
            throw new BadRequestException('Le paiement n\'est pas encore complété.');
        }

        // 3. (Optionnel) Récupérer le paymentMethodId pour traçabilité
        const paymentIntentId = session.payment_intent as string;
        const paymentIntent = await this.stripe.paymentIntents.retrieve(paymentIntentId);
        const paymentMethodId = paymentIntent.payment_method as string;

        // 4. Mettre à jour l'utilisateur
        const user = await this.userRepository.findByPk(userId);
        if (!user) {
            throw new BadRequestException('Utilisateur non trouvé');
        }

        // Mettre à jour le plan et le cycle
        user.communityTier = tier;
        user.billingCycle = cycle;

        // Définir la date d'expiration (1 mois ou 1 an)
        const durationMonths = cycle === 'YEARLY' ? 12 : 1;
        const expiresAt = new Date();
        expiresAt.setMonth(expiresAt.getMonth() + durationMonths);
        user.subscriptionExpiresAt = expiresAt;

        // Optionnel : stocker l'ID de session ou le paymentMethodId pour suivi
        // user.stripeSessionId = sessionId;
        // user.stripePaymentMethodId = paymentMethodId;

        await user.save();

        return {
            message: `Plan ${tier} activé avec succès pour ${durationMonths} mois.`,
            user: {
                id: user.id,
                communityTier: user.communityTier,
                subscriptionExpiresAt: user.subscriptionExpiresAt,
            },
        };
    }
}


