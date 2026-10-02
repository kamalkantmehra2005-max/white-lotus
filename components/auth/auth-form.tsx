"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { signIn } from "next-auth/react";
import { useState } from "react";
import { GlobalFooter } from "@/components/layout/global-footer";
import { Wordmark } from "@/components/brand/logo";
import { Button, Input } from "@/components/ui/primitives";
import { api, ApiError } from "@/lib/client/api";
import { prepareGuestClaim } from "@/components/guest/guest-claim";
import { StartChatButton } from "@/components/guest/start-chat-button";

export function AuthForm({ mode, googleEnabled, guestEnabled = false, isGuest = false }: { mode: "login" | "register"; googleEnabled: boolean; guestEnabled?: boolean; isGuest?: boolean }) {
  const router = useRouter();
  const params = useSearchParams();
  const rawNext = params.get("callbackUrl") ?? "/chat";
  // Only allow same-origin relative redirects (open-redirect protection).
  const next = rawNext.startsWith("/") && !rawNext.startsWith("//") ? rawNext : "/chat";
  const errParam = params.get("error");
  const [error, setError] = useState<string | null>(
    errParam === "signup_closed" ? "New sign-ups are currently closed." : errParam ? "Sign-in failed. Please try again." : params.get("verified") === "invalid" ? "That verification link is invalid or has expired." : null,
  );
  const [notice, setNotice] = useState<string | null>(
    params.get("verified") === "1"
      ? "Email verified — you can sign in."
      : params.get("reset") === "1"
        ? "Password updated. Sign in with your new password."
        : params.get("expired") === "1"
          ? "Your session has ended (signed out, timed out, or signed out everywhere). Please sign in again."
          : null,
  );
  const [busy, setBusy] = useState(false);
  // Guest → account: keep this guest session's chats (default on). Prepared before the session changes.
  const [keepGuest, setKeepGuest] = useState(true);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const fd = new FormData(e.currentTarget);
    const email = String(fd.get("email") ?? "");
    const password = String(fd.get("password") ?? "");
    try {
      if (isGuest) await prepareGuestClaim(keepGuest);
      if (mode === "register") {
        const r = await api<{ verificationRequired?: boolean }>("/api/auth/register", { method: "POST", json: { name: fd.get("name"), email, password } });
        if (r.verificationRequired) {
          setNotice("Account created. Check your email for a verification link, then sign in.");
          setBusy(false);
          return;
        }
      }
      const res = await signIn("credentials", { email, password, redirect: false });
      if (res?.error) throw new Error("Incorrect email or password — or too many attempts. Try again in a few minutes.");
      router.replace(next);
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError || err instanceof Error ? err.message : "Something went wrong.");
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-surface px-4">
      <div className="w-full max-w-sm">
        <Link href="/" className="mb-8 flex justify-center">
          <Wordmark />
        </Link>
        <div className="rounded-2xl border border-border bg-elevated p-6 shadow-sm">
          <h1 className="text-xl font-semibold">{mode === "login" ? "Welcome back" : "Create your account"}</h1>
          <p className="mt-1 text-sm text-muted">{mode === "login" ? "Sign in to continue to WHITE-LOTUS." : "Your account and data are stored only on this computer."}</p>
          {isGuest && (
            <label className="mt-4 flex items-start gap-2 rounded-xl bg-surface px-3 py-2.5 text-sm">
              <input type="checkbox" className="mt-0.5 h-4 w-4 accent-current" checked={keepGuest} onChange={(e) => setKeepGuest(e.target.checked)} />
              <span>
                Keep the chats from my guest session
                <span className="block text-xs text-muted">Otherwise they&apos;re deleted when the guest session expires.</span>
              </span>
            </label>
          )}

          {googleEnabled && (
            <>
              <Button variant="outline" className="mt-6 w-full" onClick={async () => {
                  if (isGuest) await prepareGuestClaim(keepGuest);
                  await signIn("google", { callbackUrl: next });
                }} type="button">
                <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden>
                  <path fill="currentColor" d="M21.35 11.1H12v2.9h5.35c-.23 1.5-1.7 4.4-5.35 4.4-3.22 0-5.85-2.67-5.85-5.95S8.78 6.5 12 6.5c1.83 0 3.06.78 3.76 1.45l2.57-2.47C16.7 3.95 14.55 3 12 3 6.98 3 2.9 7.03 2.9 12s4.08 9 9.1 9c5.25 0 8.73-3.69 8.73-8.89 0-.6-.07-1.05-.15-1.5z" />
                </svg>
                Continue with Google
              </Button>
              <div className="my-5 flex items-center gap-3 text-xs text-muted">
                <span className="h-px flex-1 bg-border" /> or <span className="h-px flex-1 bg-border" />
              </div>
            </>
          )}

          <form onSubmit={onSubmit} className={googleEnabled ? "space-y-3" : "mt-6 space-y-3"}>
            {mode === "register" && (
              <label className="block text-sm">
                <span className="mb-1 block text-muted">Name</span>
                <Input name="name" autoComplete="name" required maxLength={80} />
              </label>
            )}
            <label className="block text-sm">
              <span className="mb-1 block text-muted">Email</span>
              <Input name="email" type="email" autoComplete="email" required maxLength={254} />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-muted">Password</span>
              <Input name="password" type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} required minLength={mode === "register" ? 10 : 1} maxLength={200} />
              {mode === "register" && <span className="mt-1 block text-xs text-muted">At least 10 characters, with letters and numbers.</span>}
            </label>
            {notice && (
              <p role="status" className="rounded-lg bg-accent/10 px-3 py-2 text-sm text-fg">
                {notice}
              </p>
            )}
            {error && (
              <p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
                {error}
              </p>
            )}
            {mode === "login" && (
              <div className="text-right text-sm">
                <Link href="/forgot-password" className="text-muted underline-offset-4 hover:text-fg hover:underline">Forgot password?</Link>
              </div>
            )}
            <Button type="submit" className="w-full" disabled={busy}>
              {busy ? "Please wait…" : mode === "login" ? "Sign in" : "Create account"}
            </Button>
          </form>
        </div>
        <p className="mt-6 text-center text-sm text-muted">
          {mode === "login" ? (
            <>
              New here? <Link className="text-fg underline underline-offset-4" href="/register">Create an account</Link>
            </>
          ) : (
            <>
              Already have an account? <Link className="text-fg underline underline-offset-4" href="/login">Sign in</Link>
            </>
          )}
        </p>
        {guestEnabled && !isGuest && (
          <div className="mt-6 flex flex-col items-center gap-1 text-center text-sm text-muted">
            <span>Just want to try it?</span>
            <StartChatButton guestEnabled signedIn={false} label="Continue without an account" className="h-10 rounded-xl bg-transparent px-4 text-sm text-fg underline underline-offset-4 hover:opacity-80" />
          </div>
        )}
        <GlobalFooter />
      </div>
    </div>
  );
}
