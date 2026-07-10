"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import {
  EmbeddedCheckout,
  EmbeddedCheckoutProvider,
} from "@stripe/react-stripe-js";
import { loadStripe } from "@stripe/stripe-js";
import api from "@/services/api"; // ← votre client API

const stripePromise = loadStripe(
  process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY!
);

interface SubscriptionCheckoutProps {
  tier: string;
  isYearly: boolean;
  userEmail: string;
  userId: string;
  onSuccess: (subscriptionId: string) => void;
  onError: (error: any) => void;
}

export default function SubscriptionCheckout({
  tier,
  isYearly,
  userEmail,
  userId,
  onSuccess,
  onError,
}: SubscriptionCheckoutProps) {
  const [clientSecret, setClientSecret] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const initialized = useRef(false);
  const subscriptionIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (initialized.current) return;

    let isMounted = true;

    async function initializeCheckout() {
      try {
        setLoading(true);
        setError(null);

        console.log("Initializing subscription checkout...");

        // ✅ Appel à votre API NestJS (backend)
        const response = await api.post("/billing/create-checkout-session", {
          tier,
          isYearly,
        });

        if (!isMounted) return;

        // Le backend doit retourner { clientSecret, subscriptionId }
        if (response.data?.clientSecret) {
          subscriptionIdRef.current = response.data.subscriptionId || null;
          setClientSecret(response.data.clientSecret);
          initialized.current = true;
          console.log("✅ Subscription checkout ready");
        } else {
          throw new Error("Invalid response from server: missing clientSecret");
        }
      } catch (err: any) {
        console.error("Checkout error:", err);
        if (isMounted) {
          setError(err.message || "Unable to initialize payment.");
          onError?.(err);
        }
      } finally {
        if (isMounted) setLoading(false);
      }
    }

    initializeCheckout();
    return () => {
      isMounted = false;
    };
  }, [tier, isYearly, onError]);

  // Appelé lorsque Stripe confirme le paiement
  const handleComplete = useCallback(() => {
    console.log("💰 Payment completed successfully!");
    onSuccess?.(subscriptionIdRef.current ?? "");
  }, [onSuccess]);

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-12">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-tatt-lime mb-4"></div>
        <p className="text-gray-600">Préparation du paiement sécurisé...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-8">
        <div className="bg-red-50 border border-red-200 rounded-lg p-6">
          <h3 className="text-red-800 font-semibold mb-2">Erreur de paiement</h3>
          <p className="text-red-600 mb-4">{error}</p>
          <button
            onClick={() => window.location.reload()}
            className="bg-tatt-lime text-tatt-black px-4 py-2 rounded hover:brightness-105"
          >
            Réessayer
          </button>
        </div>
      </div>
    );
  }

  if (!clientSecret) {
    return (
      <div className="text-center py-8">
        <p className="text-gray-600">Impossible d'initialiser le paiement.</p>
      </div>
    );
  }

  return (
    <div id="subscription-checkout" className="min-h-[500px]">
      <EmbeddedCheckoutProvider
        stripe={stripePromise}
        options={{
          clientSecret,
          onComplete: handleComplete,
        }}
      >
        <EmbeddedCheckout />
      </EmbeddedCheckoutProvider>
    </div>
  );
}