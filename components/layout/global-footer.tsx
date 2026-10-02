import { cn } from "@/lib/client/cn";

/**
 * Creator credit shown on every page. Configure with NEXT_PUBLIC_CREATOR_NAME (public, inlined at build time).
 * If unset, the credit is hidden rather than showing a placeholder.
 */
export const CREATOR_NAME = (process.env.NEXT_PUBLIC_CREATOR_NAME ?? "").trim();

export function CreatorCredit({ className }: { className?: string }) {
  if (!CREATOR_NAME) return null;
  return <span className={cn("text-[11px] leading-none text-muted/80", className)}>Made by {CREATOR_NAME}</span>;
}

/**
 * GlobalFooter — the one reusable footer used on every page (landing, auth, chat, settings, projects, files, admin, errors).
 * `compact` is the one-line variant under the chat composer. The creator credit comes from NEXT_PUBLIC_CREATOR_NAME.
 */
export function GlobalFooter({ compact = false, className }: { compact?: boolean; className?: string }) {
  if (compact) {
    return (
      <footer className={cn("flex flex-wrap items-center justify-center gap-x-1.5 gap-y-0.5 text-center text-[11px] leading-tight text-muted/80", className)}>
        <span>
          WHITE-LOTUS can make mistakes.<span className="hidden sm:inline"> Verify important information.</span>
        </span>
        {CREATOR_NAME && (
          <>
            <span aria-hidden>·</span>
            <CreatorCredit className="whitespace-nowrap" />
          </>
        )}
      </footer>
    );
  }
  return (
    <footer className={cn("flex flex-col items-center gap-1 py-6 text-center", className)}>
      <span className="text-[11px] font-semibold tracking-[0.14em] text-muted">WHITE-LOTUS</span>
      <CreatorCredit />
    </footer>
  );
}
