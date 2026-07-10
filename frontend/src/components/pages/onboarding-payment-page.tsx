"use client";

import React, { useMemo, useState, useEffect } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import {
    ArrowLeft,
    CheckCircle,
    Loader2,
    Lock,
    ShieldCheck,
} from "lucide-react";
import { Navbar, Footer } from "@/components/organisms";
import { useAuth } from "@/context/auth-context";
import api from "@/services/api";

export function OnboardingPaymentPage() {
    const searchParams = useSearchParams();
    const router = useRouter();

    const planId = searchParams.get("plan") || "IMANI";
    const isYearly = searchParams.get("yearly") === "true";

    const [plans, setPlans] = useState<any[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [isRedirecting, setIsRedirecting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const { updateUser } = useAuth();

    // Charger les plans depuis l'API
    useEffect(() => {
        const fetchPlans = async () => {
            try {
                const resp = await api.get("/billing/plans");
                setPlans(resp.data);
            } catch (err) {
                console.error("Failed to fetch plans", err);
            } finally {
                setIsLoading(false);
            }
        };
        fetchPlans();
    }, []);

    // Détails du plan sélectionné
    const planDetails = useMemo(() => {
        const plan = plans.find((p) => p.tier === planId);
        if (!plan) return { name: planId, price: 0, period: isYearly ? "year" : "mo" };
        return {
            name: plan.name,
            price: isYearly ? plan.yearlyPrice : plan.monthlyPrice,
            period: isYearly ? "year" : "mo",
        };
    }, [plans, planId, isYearly]);

    // Lancer Stripe Checkout
    const handleCheckout = async () => {
        setIsRedirecting(true);
        setError(null);
        try {
            const resp = await api.post("/billing/create-checkout-session", {
                tier: planId,
                isYearly: isYearly,
            });
            // Redirection vers Stripe
            window.location.href = resp.data.url;
        } catch (err: any) {
            console.error("Checkout error", err);
            setError(err?.response?.data?.message || "Unable to start checkout. Please try again.");
            setIsRedirecting(false);
        }
    };

    if (isLoading) {
        return (
            <div className="flex items-center justify-center min-h-[60vh]">
                <Loader2 className="h-10 w-10 text-tatt-lime animate-spin" />
            </div>
        );
    }

    return (
        <div className="bg-background text-tatt-black min-h-screen flex flex-col">
            <Navbar />

            <main className="max-w-7xl mx-auto px-4 py-8 sm:px-6 lg:px-8 flex-grow">
                {/* Progress Steps */}
                <div className="mb-10">
                    <div className="flex items-center justify-between mb-2">
                        <span className="text-xs font-bold uppercase tracking-wider text-tatt-lime">
                            Step 2 of 3
                        </span>
                        <span className="text-xs font-bold uppercase tracking-wider text-tatt-lime">
                            66% Complete
                        </span>
                    </div>
                    <div className="w-full bg-tatt-lime/10 h-1.5 rounded-full overflow-hidden">
                        <div className="bg-tatt-lime h-full w-2/3 transition-all duration-500"></div>
                    </div>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-12 gap-12">
                    {/* Left Column: Checkout Content */}
                    <div className="lg:col-span-7 space-y-10">
                        <section>
                            <button
                                onClick={() => router.push("/onboarding/plans")}
                                className="text-xs font-bold text-tatt-gray hover:text-tatt-lime transition-colors flex items-center gap-1 mb-6 uppercase tracking-widest group"
                            >
                                <ArrowLeft className="h-4 w-4 transition-transform group-hover:-translate-x-1" />
                                Back to Plans
                            </button>
                            <h1 className="text-4xl font-black mb-2 text-foreground">
                                Checkout
                            </h1>
                            <p className="text-tatt-gray">
                                Complete your TATT <strong>{planDetails.name}</strong> subscription and unlock premium access.
                            </p>
                        </section>

                        {/* Stripe Checkout Button */}
                        <section className="space-y-6">
                            {error && (
                                <div className="p-4 bg-red-50 border border-red-200 rounded-xl text-sm text-red-600 font-medium">
                                    {error}
                                </div>
                            )}

                            <div className="p-6 border-2 border-tatt-lime rounded-xl bg-tatt-lime/5">
                                <div className="flex justify-between items-center mb-4">
                                    <span className="font-bold text-lg">{planDetails.name}</span>
                                    <span className="text-tatt-lime font-bold text-2xl">
                                        ${Number(planDetails.price).toFixed(2)}
                                        <span className="text-sm font-normal text-tatt-gray">
                                            {" "}
                                            / {planDetails.period}
                                        </span>
                                    </span>
                                </div>

                                <button
                                    onClick={handleCheckout}
                                    disabled={isRedirecting}
                                    className="w-full bg-tatt-lime hover:brightness-105 text-tatt-black font-black py-4 px-6 rounded-xl transition-all shadow-lg shadow-tatt-lime/20 flex items-center justify-center gap-3 group disabled:opacity-60 disabled:cursor-not-allowed uppercase tracking-widest"
                                >
                                    {isRedirecting ? (
                                        <Loader2 className="h-5 w-5 animate-spin" />
                                    ) : (
                                        <>
                                            <ShieldCheck className="h-5 w-5 group-hover:scale-110 transition-transform" />
                                            Pay with Stripe
                                        </>
                                    )}
                                </button>

                                <p className="text-center text-xs text-tatt-gray mt-4 flex items-center justify-center gap-1">
                                    <Lock className="h-3 w-3" />
                                    Secure SSL Encrypted Payment Process
                                </p>
                            </div>
                        </section>
                    </div>

                    {/* Right Column: Sidebar Summary (inchangé) */}
                    <div className="lg:col-span-5">
                        <div className="sticky top-24 space-y-6">
                            <div className="bg-white rounded-2xl p-6 shadow-sm border border-border overflow-hidden relative">
                                <div className="absolute top-0 right-0 w-32 h-32 bg-tatt-lime/5 rounded-full -mr-16 -mt-16"></div>

                                <div className="relative z-10 text-foreground">
                                    <h3 className="text-lg font-bold mb-4">Order Summary</h3>
                                    <div className="flex items-start gap-4 mb-6 p-4 bg-tatt-lime/5 rounded-xl border border-tatt-lime/20">
                                        <div className="w-16 h-16 rounded-lg bg-tatt-lime/20 flex items-center justify-center shrink-0">
                                            <CheckCircle className="h-8 w-8 text-tatt-lime" />
                                        </div>
                                        <div className="flex-1">
                                            <p className="font-bold text-lg">
                                                TATT {planDetails.name} Access
                                            </p>
                                            <p className="text-tatt-lime font-bold text-xl">
                                                ${Number(planDetails.price).toFixed(2)}{" "}
                                                <span className="text-tatt-gray text-xs font-normal">
                                                    / {planDetails.period}
                                                </span>
                                            </p>
                                            <button
                                                type="button"
                                                onClick={() => router.push("/onboarding/plans")}
                                                className="text-xs font-bold text-tatt-gray hover:text-tatt-lime mt-1 underline decoration-tatt-lime/30 underline-offset-4"
                                            >
                                                Change plan
                                            </button>
                                        </div>
                                    </div>

                                    <ul className="space-y-3 mb-8 border-b border-border pb-6">
                                        {plans
                                            .find((p) => p.tier === planId)
                                            ?.features.map((feature: string, idx: number) => (
                                                <li
                                                    key={idx}
                                                    className="flex items-center gap-2 text-sm text-tatt-gray"
                                                >
                                                    <CheckCircle className="text-tatt-lime h-4 w-4 shrink-0" />
                                                    {feature}
                                                </li>
                                            ))}
                                    </ul>

                                    <div className="space-y-3 mb-6">
                                        <div className="flex justify-between text-sm">
                                            <span className="text-tatt-gray">Subtotal</span>
                                            <span className="font-medium">
                                                ${Number(planDetails.price).toFixed(2)}
                                            </span>
                                        </div>
                                        <div className="flex justify-between text-sm">
                                            <span className="text-tatt-gray">Tax (0%)</span>
                                            <span className="font-medium">$0.00</span>
                                        </div>
                                        <div className="flex justify-between text-xl font-black pt-3 border-t border-border">
                                            <span>Total Due</span>
                                            <span className="text-tatt-lime">
                                                ${Number(planDetails.price).toFixed(2)}
                                            </span>
                                        </div>
                                    </div>

                                    <div className="p-4 bg-gray-50 rounded-xl border border-dashed border-border text-[10px] text-tatt-gray leading-relaxed uppercase tracking-tight">
                                        <span className="font-black text-foreground">
                                            Renewal Notice:
                                        </span>{" "}
                                        Your membership can automatically renew for convenience. You can opt for
                                        manual renewal or enable Autopay anytime in your Account Settings.
                                    </div>
                                </div>
                            </div>

                            {/* Trust Signals */}
                            <div className="flex items-center justify-center gap-6 px-4 opacity-40 grayscale contrast-125">
                                <div
                                    className="h-8 w-16 bg-contain bg-center bg-no-repeat bg-[url('https://upload.wikimedia.org/wikipedia/commons/5/5e/Visa_Inc._logo.svg')]"
                                    title="Visa"
                                ></div>
                                <div
                                    className="h-8 w-12 bg-contain bg-center bg-no-repeat bg-[url('https://upload.wikimedia.org/wikipedia/commons/2/2a/Mastercard-logo.svg')]"
                                    title="Mastercard"
                                ></div>
                                <div
                                    className="h-8 w-16 bg-contain bg-center bg-no-repeat bg-[url('https://upload.wikimedia.org/wikipedia/commons/3/30/American_Express_logo.svg')]"
                                    title="American Express"
                                ></div>
                                <div
                                    className="h-8 w-16 bg-contain bg-center bg-no-repeat bg-[url('https://upload.wikimedia.org/wikipedia/commons/b/b5/Discover_Card_logo.svg')]"
                                    title="Discover"
                                ></div>
                            </div>
                        </div>
                    </div>
                </div>
            </main>
            <Footer />
        </div>
    );
}