import Link from "next/link";
import { Lock } from "lucide-react";
import { PageShell } from "@/components/ui/page";

/** Shown instead of account-only pages (files, projects, memory, settings) during a guest session. */
export function AccountRequired({ feature, why }: { feature: string; why: string }) {
  return (
    <PageShell title={feature}>
      <div className="rounded-2xl border border-border bg-elevated p-6 sm:p-8">
        <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent/10 text-accent">
          <Lock size={20} />
        </div>
        <h2 className="mt-4 text-lg font-semibold">{feature} needs a free account</h2>
        <p className="mt-2 max-w-prose text-sm leading-relaxed text-muted">{why}</p>
        <p className="mt-2 max-w-prose text-sm leading-relaxed text-muted">
          You&apos;re using a temporary guest session. Sign in or create an account to use {feature.toLowerCase()} — you can keep the chats from this
          guest session.
        </p>
        <div className="mt-6 flex flex-wrap gap-2">
          <Link href="/register?from=guest" className="inline-flex h-10 items-center rounded-xl bg-fg px-4 text-sm font-medium text-bg hover:opacity-90">
            Create free account
          </Link>
          <Link href="/login?from=guest" className="inline-flex h-10 items-center rounded-xl border border-border px-4 text-sm font-medium hover:bg-surface">
            Sign in
          </Link>
          <Link href="/chat" className="inline-flex h-10 items-center rounded-xl px-4 text-sm text-muted hover:text-fg">
            Back to chat
          </Link>
        </div>
      </div>
    </PageShell>
  );
}

export const WHY = {
  files: "Uploaded documents can be confidential, so they're only accepted from signed-in accounts. Files are scanned, stored privately, and downloaded through short-lived signed links that only work for you.",
  projects: "Projects keep chats, files and instructions together for a piece of work, and are saved permanently to your account.",
  memory: "Memory lets WHITE-LOTUS remember what you ask it to across conversations, so it's tied to a permanent account you control.",
  settings: "Settings, active sessions, data export and account deletion belong to a permanent account.",
};
