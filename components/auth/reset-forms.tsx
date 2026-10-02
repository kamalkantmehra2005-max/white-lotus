"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { GlobalFooter } from "@/components/layout/global-footer";
import { Wordmark } from "@/components/brand/logo";
import { Button, Input } from "@/components/ui/primitives";
import { api } from "@/lib/client/api";

function Shell({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-surface px-4">
      <div className="w-full max-w-sm">
        <Link href="/" className="mb-8 flex justify-center">
          <Wordmark />
        </Link>
        <div className="rounded-2xl border border-border bg-elevated p-6 shadow-sm">
          <h1 className="text-xl font-semibold">{title}</h1>
          <p className="mt-1 text-sm text-muted">{subtitle}</p>
          <div className="mt-6">{children}</div>
        </div>
        <p className="mt-6 text-center text-sm text-muted">
          <Link className="text-fg underline underline-offset-4" href="/login">Back to sign in</Link>
        </p>
        <GlobalFooter />
      </div>
    </div>
  );
}

/** No email on a local install: reset the password on this computer (the launcher never sends anything anywhere). */
export function LocalPasswordReset() {
  return (
    <Shell title="Reset your password" subtitle="WHITE-LOTUS runs on this computer, so the reset happens here too.">
      <ol className="list-decimal space-y-2 pl-5 text-sm text-muted">
        <li>Close the WHITE-LOTUS window (the black launcher window) to stop it.</li>
        <li>
          Open the WHITE-LOTUS folder and run <code className="rounded bg-surface px-1">reset-password.cmd</code> (Windows), or in a terminal:
          <code className="mt-1 block rounded bg-surface px-2 py-1">npm run local -- reset-password you@example.com</code>
        </li>
        <li>Type a new password, then start WHITE-LOTUS again and sign in.</li>
      </ol>
      <p className="mt-4 text-xs text-muted">Resetting signs out every device that was signed in to that account.</p>
    </Shell>
  );
}

export function ForgotPasswordForm() {
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Shell title="Reset your password" subtitle="We'll email you a link to choose a new one.">
      {done ? (
        <p role="status" className="rounded-lg bg-accent/10 px-3 py-2 text-sm">{done}</p>
      ) : (
        <form
          className="space-y-3"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            try {
              const r = await api<{ message: string }>("/api/auth/forgot-password", { method: "POST", json: { email: new FormData(e.currentTarget).get("email") } });
              setDone(r.message);
            } catch (err) {
              setError((err as Error).message);
            }
            setBusy(false);
          }}
        >
          <label className="block text-sm">
            <span className="mb-1 block text-muted">Email</span>
            <Input name="email" type="email" autoComplete="email" required maxLength={254} />
          </label>
          {error && <p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}
          <Button type="submit" className="w-full" disabled={busy}>{busy ? "Sending…" : "Send reset link"}</Button>
        </form>
      )}
    </Shell>
  );
}

export function ResetPasswordForm() {
  const token = useSearchParams().get("token") ?? "";
  const router = useRouter();
  const [error, setError] = useState<string | null>(token ? null : "This reset link is missing its token.");
  const [busy, setBusy] = useState(false);
  return (
    <Shell title="Choose a new password" subtitle="At least 10 characters, with letters and numbers.">
      <form
        className="space-y-3"
        onSubmit={async (e) => {
          e.preventDefault();
          const fd = new FormData(e.currentTarget);
          if (fd.get("password") !== fd.get("confirm")) return setError("Passwords don't match.");
          setBusy(true);
          setError(null);
          try {
            await api("/api/auth/reset-password", { method: "POST", json: { token, password: fd.get("password") } });
            router.replace("/login?reset=1");
          } catch (err) {
            setError((err as Error).message);
            setBusy(false);
          }
        }}
      >
        <label className="block text-sm">
          <span className="mb-1 block text-muted">New password</span>
          <Input name="password" type="password" autoComplete="new-password" required minLength={10} maxLength={200} />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-muted">Confirm password</span>
          <Input name="confirm" type="password" autoComplete="new-password" required minLength={10} maxLength={200} />
        </label>
        {error && <p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}
        <Button type="submit" className="w-full" disabled={busy || !token}>{busy ? "Saving…" : "Set new password"}</Button>
      </form>
    </Shell>
  );
}
