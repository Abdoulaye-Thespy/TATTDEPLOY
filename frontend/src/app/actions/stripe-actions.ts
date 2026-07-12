'use server';

import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2025-02-24.acacia',
});

export async function createSubscriptionCheckoutSession({
  tier,
  isYearly,
  amount,
  currency,
  userEmail,
  userId,
}: {
  tier: string;
  isYearly: boolean;
  amount: number;
  currency: string;
  userEmail: string;
  userId: string;
}) {
  // Validation
  if (!userEmail || !userEmail.includes('@')) {
    throw new Error('Adresse email invalide.');
  }
  if (!amount || amount <= 0) {
    throw new Error('Montant invalide.');
  }

  // Création de la session Checkout (paiement unique)
  const session = await stripe.checkout.sessions.create({
    mode: 'payment', // ← Paiement unique
    payment_method_types: ['card'],
    line_items: [
      {
        price_data: {
          currency: currency || 'usd',
          product_data: {
            name: `TATT ${tier} Membership - ${isYearly ? 'Yearly' : 'Monthly'}`,
            description: `Accès au plan ${tier}`,
          },
          unit_amount: amount, // ← Montant en centimes
        },
        quantity: 1,
      },
    ],
    ui_mode: 'embedded',
    redirect_on_completion: 'never',
    customer_email: userEmail,
    metadata: {
      userId,
      tier,
      billingCycle: isYearly ? 'YEARLY' : 'MONTHLY',
    },
  });

  return {
    clientSecret: session.client_secret,
    sessionId: session.id,
  };
}