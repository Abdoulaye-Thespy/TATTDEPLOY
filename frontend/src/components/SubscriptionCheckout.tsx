"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import {
  EmbeddedCheckout,
  EmbeddedCheckoutProvider,
} from "@stripe/react-stripe-js";
import { loadStripe } from "@stripe/stripe-js";
import { createSubscriptionCheckoutSession } from "@/app/actions/stripe-actions";
import api from "@/services/api";

const stripePromise = loadStripe(
  process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY!
);

interface SubscriptionCheckoutProps {
  tier: string;
  isYearly: boolean;
  amount: number;          // ← Montant en centimes
  currency?: string;       // ← "usd" par défaut
  userEmail: string;
  userId: string;
  onSuccess: (sessionId: string) => void;
  onError: (error: any) => void;
}

export default function SubscriptionCheckout({
  tier,
  isYearly,
  amount,
  currency = "usd",
  userEmail,
  userId,
  onSuccess,
  onError,
}: SubscriptionCheckoutProps) {
  const [clientSecret, setClientSecret] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const initialized = useRef(false);
  const sessionIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!userEmail?.includes('@')) {
      setError("Adresse email invalide.");
      setLoading(false);
      return;
    }

    if (initialized.current) return;

    let isMounted = true;

    async function initializeCheckout() {
      try {
        setLoading(true);
        setError(null);

        const result = await createSubscriptionCheckoutSession({
          tier,
          isYearly,
          amount,
          currency,
          userEmail,
          userId,
        });

        if (!isMounted) return;

        if (result?.clientSecret) {
          sessionIdRef.current = result.sessionId || null;
          setClientSecret(result.clientSecret);
          initialized.current = true;
        } else {
          throw new Error("Réponse invalide du serveur");
        }
      } catch (err: any) {
        if (isMounted) {
          setError(err.message || "Impossible d'initialiser le paiement.");
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
  }, [tier, isYearly, amount, currency, userEmail, userId, onError]);

  const handleComplete = useCallback(async () => {
    const sessionId = sessionIdRef.current;
    if (!sessionId) {
      onError(new Error("ID de session manquant"));
      return;
    }

    try {
      console.log("💰 Paiement réussi !");

      // Appel au backend pour mettre à jour l'utilisateur
      const response = await api.post("/billing/confirm-payment", {
        sessionId,
        communityTier: tier,
        billingCycle: isYearly ? "YEARLY" : "MONTHLY",
      });

      console.log("✅ Utilisateur mis à jour :", response.data);
      onSuccess(sessionId);
    } catch (err: any) {
      console.error("Erreur confirmation :", err);
      onError(err);
    }
  }, [tier, isYearly, onSuccess, onError]);

  // États d'affichage (loading, error, render)
  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-12">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-tatt-lime mb-4"></div>
        <p className="text-gray-600">Préparation du paiement...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-8">
        <div className="bg-red-50 border border-red-200 rounded-lg p-6">
          <h3 className="text-red-800 font-semibold mb-2">Erreur</h3>
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
    return <div className="text-center py-8">Impossible d'initialiser le paiement.</div>;
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