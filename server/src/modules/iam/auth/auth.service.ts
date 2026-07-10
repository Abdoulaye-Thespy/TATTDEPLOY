import {
    Injectable,
    UnauthorizedException,
    BadRequestException,
    ConflictException,
    ForbiddenException,
    Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/sequelize';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import { Op } from 'sequelize';
import Stripe from 'stripe';
import { SystemSettingsService } from '../../system-settings/system-settings.service';
import { User } from '../entities/user.entity';
import { AddOrgMemberDto, BootstrapAdminDto, CompleteOrgMemberDto, CommunitySignupDto, SignInDto, ForgotPasswordDto, ResetPasswordDto } from './dto/auth.dto';
import { SystemRole, CommunityTier } from '../enums/roles.enum';
import { MailService } from '../../../common/mail/mail.service';
import { SecurityPolicyService } from '../../security/security-policy.service';
import { TwoFactorService } from '../../security/two-factor.service';
import { Chapter } from '../../chapters/entities/chapter.entity';
import { ProfessionalInterest } from '../../interests/entities/interest.entity';

export interface AuthResponse {
    access_token: string;
    user: {
        id: string;
        firstName: string;
        lastName: string;
        email: string;
        systemRole: SystemRole;
        communityTier: CommunityTier;
        isActive: boolean;
        flags: any; // Flags are dynamic JSON
        isTwoFactorEnabled: boolean;
        twoFactorMethod: string | null;
        deletionRequestedAt: Date | null;
        hasAutoPayEnabled: boolean;
    };
    isScheduledForDeletion?: boolean;
    deletionDate?: Date;
    message?: string;
}

@Injectable()
export class AuthService {
    private readonly logger = new Logger(AuthService.name);
    private stripe: Stripe;

    constructor(
        @InjectModel(User) private userRepository: typeof User,
        private jwtService: JwtService,
        private mailService: MailService,
        private securityPolicyService: SecurityPolicyService,
        private twoFactorService: TwoFactorService,
        private settingsService: SystemSettingsService,
        private configService: ConfigService,
    ) { }

    private async getStripe() {
        return this.settingsService.getStripeInstance();
    }

    // ─── SIGN IN ──────────────────────────────────────────────────────────────────
    async signIn(dto: SignInDto, ip?: string) {
        const user = await this.userRepository.findOne({ where: { email: dto.email } });

        if (!user) throw new UnauthorizedException('Invalid credentials');
        if (!user.isActive) throw new UnauthorizedException('Please complete your registration first.');
        if (!user.password) throw new UnauthorizedException('Account registered via alternative provider.');

        const isMatch = await bcrypt.compare(dto.password, user.password);
        if (!isMatch) throw new UnauthorizedException('Invalid credentials');

        // ── Password rotation check ─────────────────────────────────────────────
        const policy = await this.securityPolicyService.getPolicy();
        if (policy.passwordRotationEnabled && user.passwordChangedAt) {
            const expiresAt = new Date(user.passwordChangedAt);
            expiresAt.setDate(expiresAt.getDate() + policy.passwordRotationDays);

            if (expiresAt < new Date()) {
                // Password is expired — user must change it. Issue a scoped token.
                const rotationToken = this.jwtService.sign(
                    { sub: user.id, scope: 'password_rotation_required' },
                    { expiresIn: '15m' },
                );
                return {
                    requiresPasswordRotation: true,
                    rotationToken,
                    message: 'Your password has expired. Please set a new password to continue.',
                };
            }
        }

        // ── 2FA check ───────────────────────────────────────────────────────────
        const twoFactorRequired = await this.securityPolicyService.isTwoFactorRequired(user);

        if (twoFactorRequired && !user.isTwoFactorEnabled) {
            // Policy demands 2FA but user hasn't set it up yet
            const setupToken = this.jwtService.sign(
                { sub: user.id, scope: 'two_factor_setup_required' },
                { expiresIn: '15m' },
            );
            return {
                requiresTwoFactorSetup: true,
                setupToken,
                message: 'Your organisation requires 2FA. Please set up two-factor authentication before continuing.',
            };
        }

        if (user.isTwoFactorEnabled && user.twoFactorMethod) {
            // 2FA is enabled — issue partial token and trigger OTP if email-based
            if (user.twoFactorMethod === 'EMAIL') {
                await this.twoFactorService.sendEmailOtp(user.id, ip ?? null);
            }

            const partialToken = this.twoFactorService.issuePartialToken(user.id, user.twoFactorMethod);
            return {
                requiresTwoFactor: true,
                partialToken,
                method: user.twoFactorMethod,
                message:
                    user.twoFactorMethod === 'EMAIL'
                        ? 'A verification code has been sent to your registered email. Enter it to complete sign-in.'
                        : 'Enter the 6-digit code from your authenticator app to complete sign-in.',
            };
        }

        const authResponse = this.generateAuthResponse(user) as AuthResponse;
        if (user.deletionRequestedAt) {
            authResponse.isScheduledForDeletion = true;
            authResponse.deletionDate = new Date(user.deletionRequestedAt.getTime() + 14 * 24 * 60 * 60 * 1000);
        }
        return authResponse;
    }

    // ─── COMPLETE 2FA STEP (called after partial token is returned) ───────────
    async completeTwoFactorSignIn(partialToken: string, otp: string, ip?: string) {
        const { userId, method } = await this.twoFactorService.validatePartialToken(partialToken);

        let user: User;

        if (method === 'TOTP') {
            user = await this.twoFactorService.verifyTotpOtp(userId, otp);
        } else {
            user = await this.twoFactorService.verifyEmailOtp(userId, otp, ip ?? null);
        }

        return this.generateAuthResponse(user);
    }

    // ─── RESEND EMAIL OTP (during 2FA login step) ─────────────────────────────
    async resendEmailOtp(partialToken: string, ip?: string) {
        const { userId, method } = await this.twoFactorService.validatePartialToken(partialToken);
        if (method !== 'EMAIL') {
            throw new BadRequestException('Resend is only available for Email OTP.');
        }
        await this.twoFactorService.sendEmailOtp(userId, ip ?? null);
        return { message: 'A new verification code has been sent to your registered email.' };
    }

    // ─── FORCED PASSWORD ROTATION (after rotationToken) ──────────────────────
    async rotateExpiredPassword(rotationToken: string, newPassword: string) {
        let payload: { sub: string; scope: string };
        try {
            payload = this.jwtService.verify(rotationToken);
        } catch (error) {
            throw new UnauthorizedException('Rotation token is invalid or has expired.');
        }
        if (payload.scope !== 'password_rotation_required') {
            throw new ForbiddenException('Invalid token scope.');
        }

        const user = await this.userRepository.findByPk(payload.sub);
        if (!user) throw new UnauthorizedException('User not found.');

        const policy = await this.securityPolicyService.getPolicy();

        // Validate against complexity policy
        await this.securityPolicyService.validatePasswordStrength(newPassword, policy);

        // Block reuse of historical passwords
        await this.securityPolicyService.checkPasswordHistory(user.id, newPassword, policy);

        const newHash = await bcrypt.hash(newPassword, 12);

        // Record old password to history before overwriting
        await this.securityPolicyService.recordPasswordChange(user.id, user.password, policy);

        user.password = newHash;
        user.passwordChangedAt = new Date();
        user.passwordExpiryNotifiedAt = null; // Reset expiry notifications
        await user.save();

        return this.generateAuthResponse(user);
    }

    // ─── BOOTSTRAP FIRST ADMIN (no JWT required) ──────────────────────────────
    /**
     * Creates the first admin account. Only allowed when zero users with ADMIN or SUPERADMIN exist.
     * Use this once to create an account you can use to sign in and then add other org members.
     */
    async bootstrapFirstAdmin(dto: BootstrapAdminDto) {
        // Secure bootstrap with optional env secret (Item #4)
        const bootstrapSecret = this.configService.get<string>('BOOTSTRAP_SECRET');
        if (bootstrapSecret && dto.bootstrapSecret !== bootstrapSecret) {
            this.logger.warn(`Unauthorized bootstrap attempt: Secret mismatch.`);
            throw new ForbiddenException('Invalid bootstrap secret.');
        }

        const existingAdmin = await this.userRepository.findOne({
            where: { systemRole: { [Op.in]: [SystemRole.ADMIN, SystemRole.SUPERADMIN] } },
        });
        if (existingAdmin) {
            throw new ForbiddenException(
                'Bootstrap is only allowed when no admin exists. An admin account already exists.',
            );
        }

        const existingEmail = await this.userRepository.findOne({ where: { email: dto.email } });
        if (existingEmail) {
            throw new ConflictException('A user with this email already exists.');
        }

        let policy = null;
        try {
            policy = await this.securityPolicyService.getPolicy();
        } catch {
            // No policy row yet (e.g. fresh DB)
        }
        if (policy) {
            try {
                await this.securityPolicyService.validatePasswordStrength(dto.password, policy);
            } catch (err) {
                const error = err as Error;
                throw new BadRequestException(error?.message || 'Password does not meet policy requirements.');
            }
        } else {
            if (dto.password.length < 8) {
                throw new BadRequestException('Password must be at least 8 characters long.');
            }
        }

        const hashedPassword = await bcrypt.hash(dto.password, 12);
        const user = await this.userRepository.create({
            firstName: dto.firstName,
            lastName: dto.lastName,
            email: dto.email,
            password: hashedPassword,
            systemRole: SystemRole.SUPERADMIN,
            communityTier: CommunityTier.FREE,
            isActive: true,
            isApproved: true,
            passwordChangedAt: new Date(),
        });

        if (policy) {
            try {
                await this.securityPolicyService.recordPasswordChange(user.id, hashedPassword, policy);
            } catch {
                // Non-fatal
            }
        }

        // Send branded welcome email to the first system admin
        this.mailService.sendOrgWelcomeEmail(user.email, user.firstName, user.systemRole);

        return {
            message: 'First admin created successfully. Sign in at POST /auth/signin with your email and password.',
            email: user.email,
        };
    }

    // ─── ADD ORG MEMBER ────────────────────────────────────────────────────────
    async addOrgMember(dto: AddOrgMemberDto, currentAdmin: User) {
        if (currentAdmin.systemRole !== SystemRole.SUPERADMIN && currentAdmin.systemRole !== SystemRole.ADMIN) {
            throw new UnauthorizedException('Insufficient permissions to add Org Members');
        }

        const existingUser = await this.userRepository.findOne({ where: { email: dto.email } });
        if (existingUser) throw new ConflictException('A user with this email already exists.');

        const inviteToken = crypto.randomBytes(32).toString('hex');
        const tokenHash = await bcrypt.hash(inviteToken, 10);

        const user = await this.userRepository.create({
            firstName: dto.firstName,
            lastName: dto.lastName,
            email: dto.email,
            phoneNumber: dto.phoneNumber,
            professionTitle: dto.professionTitle,
            location: dto.location,
            systemRole: dto.systemRole,
            communityTier: CommunityTier.FREE,
            isActive: false,
            inviteToken: tokenHash,
            isApproved: true,
        });

        // Email dispatch is non-fatal for member creation
        try {
            await this.mailService.sendAdminInvite(user.email, user.firstName, inviteToken);
        } catch (error) {
            const mailError = error as Error;
            this.logger.error(`Failed to send initial invite to ${user.email} (non-fatal): ${mailError.message}`, mailError.stack);
            return { 
                message: 'Org member added successfully, but invitation email failed to send. You can resend it from the management dashboard once email settings are verified.',
                warning: 'EMAIL_DISPATCH_FAILED'
            };
        }

        return { message: 'Org member added successfully. Invitation email dispatched.' };
    }

    async resendOrgInvite(userId: string, currentAdmin: User) {
        this.logger.log(`Resending invite attempt for user ID: ${userId} by admin: ${currentAdmin.email}`);
        
        if (currentAdmin.systemRole !== SystemRole.SUPERADMIN && currentAdmin.systemRole !== SystemRole.ADMIN) {
            this.logger.warn(`Insufficient permissions for ${currentAdmin.email} to resend invitation`);
            throw new UnauthorizedException('Insufficient permissions to resend invitations');
        }

        const user = await this.userRepository.findByPk(userId);
        if (!user) {
            this.logger.warn(`Resend invite failed: User not found for ID ${userId}`);
            throw new BadRequestException('User not found');
        }

        if (user.isActive) {
            this.logger.warn(`Resend invite failed: User ${user.email} is already active`);
            throw new BadRequestException('User has already activated their account');
        }

        const inviteToken = crypto.randomBytes(32).toString('hex');
        const tokenHash = await bcrypt.hash(inviteToken, 10);

        user.inviteToken = tokenHash;
        await user.save();

        // Email dispatch is now treated as a fatal error for explicit "Resend" requests
        try {
            await this.mailService.sendAdminInvite(user.email, user.firstName, inviteToken);
            this.logger.log(`Invitation email successfully resent to ${user.email}`);
            return { message: 'Invitation email resent successfully.' };
        } catch (error) {
            const mailError = error as Error;
            this.logger.error(`Failed to resend invite to ${user.email}: ${mailError.message}`, mailError.stack);
            throw new BadRequestException(`Email failed to send. Please check your SMTP configuration. Error: ${mailError.message}`);
        }
    }

    // ─── COMPLETE ORG MEMBER REGISTRATION ────────────────────────────────────
    async completeOrgMemberRegistration(dto: CompleteOrgMemberDto) {
        const users = await this.userRepository.findAll({ where: { isActive: false } });

        let matchedUser: User | null = null;
        for (const user of users) {
            if (user.inviteToken && await bcrypt.compare(dto.token, user.inviteToken)) {
                matchedUser = user;
                break;
            }
        }

        if (!matchedUser) throw new UnauthorizedException('Invalid or expired invitation token.');

        const policy = await this.securityPolicyService.getPolicy();
        await this.securityPolicyService.validatePasswordStrength(dto.password, policy);

        const hash = await bcrypt.hash(dto.password, 12);
        await this.securityPolicyService.recordPasswordChange(matchedUser.id, hash, policy);

        matchedUser.password = hash;
        matchedUser.isActive = true;
        matchedUser.inviteToken = null;
        matchedUser.passwordChangedAt = new Date();
        await matchedUser.save();

        return this.generateAuthResponse(matchedUser);
    }

    // ─── COMMUNITY SIGNUP ────────────────────────────────────────────────────
    async signupCommunityMember(dto: CommunitySignupDto) {
        const existingUser = await this.userRepository.findOne({ where: { email: dto.email } });
        if (existingUser) {
            const isMatch = await bcrypt.compare(dto.password, existingUser.password);
            if (isMatch) {
                this.logger.log(`User ${dto.email} restarted signup. Logging them in and returning to onboarding.`);
                const authResp = this.generateAuthResponse(existingUser) as AuthResponse;
                authResp.message = 'Registration resumed. Redirecting to plan selection.';
                return authResp;
            }
            throw new ConflictException('Email address already in use. Please sign in or reset your password.');
        }

        // Validate against password policy
        const policy = await this.securityPolicyService.getPolicy();
        await this.securityPolicyService.validatePasswordStrength(dto.password, policy);

        let subscriptionExpiresAt: Date = null;
        let stripeCustomerId: string = null;

        if (dto.communityTier !== CommunityTier.FREE) {
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

            const priceId = tierPricingMap[dto.communityTier]?.[dto.billingCycle || 'MONTHLY'];
            if (!priceId) throw new BadRequestException('Selected membership tier is invalid or unavailable.');

            try {
                const customer = await (await this.getStripe()).customers.create({
                    email: dto.email,
                    name: `${dto.firstName} ${dto.lastName}`,
                    payment_method: dto.paymentMethodId,
                    invoice_settings: { default_payment_method: dto.paymentMethodId },
                });
                stripeCustomerId = customer.id;

                if (!priceId.includes('mock') && !process.env.STRIPE_SECRET_KEY?.includes('placeholder')) {
                    await (await this.getStripe()).subscriptions.create({
                        customer: customer.id,
                        items: [{ price: priceId }],
                        expand: ['latest_invoice.payment_intent'],
                    });
                } else {
                    this.logger.warn(`Simulating Stripe Subscription for Tier: ${dto.communityTier}`);
                }

                const durationMonths = dto.billingCycle === 'YEARLY' ? 13 : 1;
                subscriptionExpiresAt = new Date();
                subscriptionExpiresAt.setMonth(subscriptionExpiresAt.getMonth() + durationMonths);
            } catch (err) {
                const error = err as Error;
                this.logger.error('Stripe Integration Error', error.message);
                throw new BadRequestException('Payment processing failed: Transaction Declined or Config Error');
            }
        }

        const hashedPassword = await bcrypt.hash(dto.password, 12);

        const user = await this.userRepository.create({
            firstName: dto.firstName,
            lastName: dto.lastName,
            email: dto.email,
            password: hashedPassword,
            professionTitle: dto.professionTitle,
            industryId: dto.industryId,
            chapterId: dto.chapterId,
            systemRole: SystemRole.COMMUNITY_MEMBER,
            communityTier: dto.communityTier,
            isActive: true,
            isApproved: true,
            stripeCustomerId,
            subscriptionExpiresAt,
            billingCycle: dto.billingCycle,
            hasAutoPayEnabled: true,
            passwordChangedAt: new Date(),
        });

        if (dto.interestIds?.length > 0) {
            await user.$set('interests', dto.interestIds);
        }

        await this.securityPolicyService.recordPasswordChange(user.id, hashedPassword, policy);

        // Send branded welcome email to new community member
        this.mailService.sendCommunityWelcomeEmail(user.email, user.firstName, user.communityTier);

        return this.generateAuthResponse(user);
    }

    // ─── FORGOT PASSWORD ────────────────────────────────────────────────────
    async forgotPassword(dto: ForgotPasswordDto) {
        const user = await this.userRepository.findOne({ where: { email: dto.email } });
        if (!user) return { message: 'If that email exists, a reset link has been sent.' };

        const resetTokenRaw = crypto.randomBytes(32).toString('hex');
        const resetTokenHash = await bcrypt.hash(resetTokenRaw, 10);

        const expiresAt = new Date();
        expiresAt.setHours(expiresAt.getHours() + 1);

        user.resetPasswordToken = resetTokenHash;
        user.resetPasswordExpiresAt = expiresAt;
        await user.save();

        const resetLink = `${process.env.FRONTEND_URL}/reset-password?token=${resetTokenRaw}`;

        if (process.env.NODE_ENV === 'development') {
            this.logger.log(`[DEV] Password reset requested for ${user.email}. Raw token: ${resetTokenRaw}`);
            this.logger.log(`[DEV] Reset link: ${resetLink}`);
        }

        try {
            // ✅ Appel correct avec deux arguments
            await this.mailService.sendPasswordReset(user.email, resetTokenRaw);
            this.logger.log(`✅ Password reset email sent to ${user.email}`);
        } catch (mailError) {
            this.logger.error(`❌ Failed to send password reset email: ${mailError}`);
            if (process.env.NODE_ENV !== 'development') {
                throw mailError;
            }
        }

        return { message: 'If that email exists, a reset link has been sent.' };
    }


    // ─── RESET PASSWORD ──────────────────────────────────────────────────────
    async resetPassword(dto: ResetPasswordDto) {
        const users = await this.userRepository.findAll({
            where: {
                resetPasswordToken: { [Op.not]: null },
                resetPasswordExpiresAt: { [Op.gt]: new Date() },
            },
        });

        let matchedUser: User | null = null;
        for (const user of users) {
            if (await bcrypt.compare(dto.token, user.resetPasswordToken)) {
                matchedUser = user;
                break;
            }
        }

        if (!matchedUser) throw new UnauthorizedException('Invalid or expired password reset token.');

        const policy = await this.securityPolicyService.getPolicy();
        await this.securityPolicyService.validatePasswordStrength(dto.newPassword, policy);
        await this.securityPolicyService.checkPasswordHistory(matchedUser.id, dto.newPassword, policy);

        const newHash = await bcrypt.hash(dto.newPassword, 12);
        await this.securityPolicyService.recordPasswordChange(matchedUser.id, newHash, policy);

        matchedUser.password = newHash;
        matchedUser.resetPasswordToken = null;
        matchedUser.resetPasswordExpiresAt = null;
        matchedUser.passwordChangedAt = new Date();
        matchedUser.passwordExpiryNotifiedAt = null;
        await matchedUser.save();

        return { message: 'Password has been successfully reset.' };
    }

    // ─── GET CURRENT USER PROFILE (for frontend /auth/me) ──────────────────────
    async getMe(userId: string) {
        const user = await this.userRepository.findByPk(userId, {
            attributes: [
                'id', 'firstName', 'lastName', 'email', 'systemRole', 'communityTier',
                'chapterId', 'profilePicture', 'professionTitle', 'companyName', 'tattMemberId',
                'isActive', 'flags', 'isTwoFactorEnabled', 'twoFactorMethod',
                'connectionPreference', 'expertise', 'businessName', 'businessRole',
                'businessProfileLink', 'professionalHighlight', 'location', 'deletionRequestedAt',
                'linkedInProfileUrl', 'hasAutoPayEnabled'
            ],

            include: [
                { model: Chapter, as: 'chapter' },
                { model: ProfessionalInterest, as: 'interests', attributes: ['id', 'name'], through: { attributes: [] } }
            ],
        });
        if (!user) throw new UnauthorizedException('User not found');
        const plain = user.get({ plain: true }) as Record<string, any>;
        if (plain.chapter) {
            plain.chapterName = (plain.chapter as any).name;
            plain.chapterCode = (plain.chapter as any).code;
        }
        delete plain.chapter;
        return plain;
    }

    async getPasswordPolicy() {
        return this.securityPolicyService.getPolicy();
    }

    // ─── INTERNAL: GENERATE FULL AUTH RESPONSE ────────────────────────────────
    private generateAuthResponse(user: User) {
        const payload = {
            sub: user.id,
            email: user.email,
            role: user.systemRole,
            tier: user.communityTier,
        };

        return {
            access_token: this.jwtService.sign(payload),
            user: {
                id: user.id,
                firstName: user.firstName,
                lastName: user.lastName,
                email: user.email,
                systemRole: user.systemRole,
                communityTier: user.communityTier,
                isActive: user.isActive,
                flags: user.flags,
                isTwoFactorEnabled: user.isTwoFactorEnabled,
                twoFactorMethod: user.twoFactorMethod ?? null,
                deletionRequestedAt: user.deletionRequestedAt || null,
                hasAutoPayEnabled: user.hasAutoPayEnabled,
            },
        };

    }
}
