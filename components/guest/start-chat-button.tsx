"use client";

import { useRouter } from "next/navigation";
import { signIn } from "next-auth/react";
import { useState } from "react";
import { ArrowRight } from "lucide-react";
import { cn } from "@/lib/client/cn";

/**
 * "Start Chatting": with guest mode on, creates a temporary server-side guest session and opens the chat —
 * no form, no onboarding. With guest mode off it goes to sign-in (and on to the chat afterwards).
 */
export function StartChatButton({ guestEnabled, signedIn, className, label = "Start Chatting" }: { guestEnabled: boolean; signedIn: boolean; className?: string; label?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setError(null);
    if (signedIn) return router.push("/chat");
    if (!guestEnabled) return router.push("/login?callbackUrl=%2Fchat");
    setBusy(true);
    const res = await signIn("guest", { redirect: false }).catch(() => ({ error: "failed" }));
    if (res?.error) {
      setBusy(false);
      setError("Couldn't start a guest session right now (too many from this network). Please sign in or try again later.");
      return;
    }
    router.replace("/chat");
    router.refresh();
  }

  return (
    <div className="flex flex-col items-center gap-2">
      <button
        type="button"
        onClick={start}
        disabled={busy}
        className={cn("inline-flex h-12 items-center gap-2 rounded-2xl bg-fg px-7 text-base font-medium text-bg transition-opacity hover:opacity-90 disabled:opacity-60", className)}
      >
        {busy ? "Opening…" : label} {!busy && <ArrowRight size={18} />}
      </button>
      {error && (
        <p role="alert" className="max-w-sm text-center text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
