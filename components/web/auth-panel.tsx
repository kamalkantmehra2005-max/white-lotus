"use client";

import { useState } from "react";
import { getSession, signIn } from "next-auth/react";
import { Lock } from "lucide-react";
import { Button, Input } from "@/components/ui/primitives";
import { deriveKeys, randomSalt } from "./crypto";

export type Account = { userId: string; email: string; name: string | null; role: "user" | "admin"; vaultKey: CryptoKey };

async function post<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error?.message ?? "Something went wrong. Please try again.");
  return j as T;
}

/** Sign in with the derived login secret (never the password) and return the account plus its vault key. */
export async function signInDerived(email: string, password: string): Promise<Account> {
  const pre = await post<{ salt: string; iterations: number }>("/api/web/prelogin", { email });
  const { authSecret, vaultKey } = await deriveKeys(password, pre.salt, pre.iterations);
  const res = await signIn("credentials", { email, password: authSecret, redirect: false });
  if (!res || res.error) throw new Error("Email or password isn't right (or too many attempts — wait a few minutes).");
  const s = await getSession();
  const u = s?.user as { id?: string; email?: string; name?: string | null; role?: "user" | "admin" } | undefined;
  if (!u?.id) throw new Error("Signed in, but the session didn't start. Allow cookies for this site and try again.");
  return { userId: u.id, email: u.email ?? email, name: u.name ?? null, role: u.role ?? "user", vaultKey };
}

export async function loginSecret(email: string, password: string): Promise<string> {
  const pre = await post<{ salt: string; iterations: number }>("/api/web/prelogin", { email });
  return (await deriveKeys(password, pre.salt, pre.iterations)).authSecret;
}

export function AuthPanel({
  signup,
  hasTemporary,
  lockedEmail,
  onDone,
  onBack,
}: {
  signup: boolean;
  hasTemporary: boolean;
  lockedEmail?: string;
  onDone: (a: Account, keepTemporary: boolean) => void;
  onBack: () => void;
}) {
  const [tab, setTab] = useState<"in" | "up">("in");
  const [name, setName] = useState("");
  const [email, setEmail] = useState(lockedEmail ?? "");
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [ownerCode, setOwnerCode] = useState("");
  const [showOwner, setShowOwner] = useState(false);
  const [keep, setKeep] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    if (tab === "up") {
      if (password.length < 10 || !/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) return setErr("Use at least 10 characters with letters and numbers.");
      if (password !== password2) return setErr("The two passwords don't match.");
    }
    setBusy(true);
    try {
      const em = email.trim().toLowerCase();
      if (tab === "up") {
        const salt = randomSalt();
        const iterations = 600_000;
        const { authSecret } = await deriveKeys(password, salt, iterations);
        await post("/api/web/register", { name: name.trim(), email: em, authSecret, salt, iterations, ...(ownerCode.trim() ? { ownerCode: ownerCode.trim() } : {}) });
      }
      onDone(await signInDerived(em, password), hasTemporary && keep);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-sm">
      <button type="button" onClick={onBack} className="mb-4 text-sm text-muted hover:text-fg">← Back</button>
      {lockedEmail ? (
        <h2 className="mb-1 flex items-center gap-2 text-lg font-semibold"><Lock size={16} /> Unlock on this device</h2>
      ) : (
        <div className="mb-4 flex rounded-xl border border-border p-1 text-sm">
          {(["in", "up"] as const).map((t) => (
            <button key={t} type="button" disabled={t === "up" && !signup} onClick={() => setTab(t)} className={`flex-1 rounded-lg py-1.5 ${tab === t ? "bg-surface font-medium" : "text-muted"} disabled:opacity-40`}>
              {t === "in" ? "Sign in" : "Create account"}
            </button>
          ))}
        </div>
      )}
      <form onSubmit={submit} className="space-y-3">
        {tab === "up" && <Input aria-label="Name" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} autoComplete="name" />}
        <Input aria-label="Email" type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" disabled={Boolean(lockedEmail)} />
        <Input aria-label="Password" type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete={tab === "up" ? "new-password" : "current-password"} />
        {tab === "up" && <Input aria-label="Repeat password" type="password" placeholder="Repeat password" value={password2} onChange={(e) => setPassword2(e.target.value)} required autoComplete="new-password" />}
        {tab === "up" && (
          <div className="text-xs text-muted">
            <p className="rounded-lg bg-surface p-2.5">
              Your password encrypts your synced chats on this device before they&apos;re uploaded. <b>It can&apos;t be reset</b> — if you forget it, synced copies can&apos;t be opened (chats already on a device stay there).
            </p>
            <button type="button" className="mt-2 underline" onClick={() => setShowOwner((v) => !v)}>I&apos;m the owner of this site</button>
            {showOwner && <Input aria-label="Owner setup code" className="mt-2" placeholder="Owner setup code (from the server settings)" value={ownerCode} onChange={(e) => setOwnerCode(e.target.value)} autoComplete="off" />}
          </div>
        )}
        {hasTemporary && !lockedEmail && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} /> Keep this tab&apos;s temporary chats in my account
          </label>
        )}
        {err && <p className="text-sm text-danger" role="alert">{err}</p>}
        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? "Working…" : lockedEmail ? "Unlock" : tab === "in" ? "Sign in" : "Create account"}
        </Button>
        <p className="text-center text-xs text-muted">Encryption happens in your browser. It can take a second or two.</p>
      </form>
    </div>
  );
}
