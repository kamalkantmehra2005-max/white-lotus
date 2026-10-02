import { cn } from "@/lib/client/cn";

/** Original WHITE-LOTUS mark: three geometric petals on a waterline. */
export function LotusMark({ className, accent = true }: { className?: string; accent?: boolean }) {
  return (
    <svg viewBox="0 0 40 40" aria-hidden className={cn("h-6 w-6", className)} fill="none">
      <g stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round">
        <path d="M20 6c4.2 5 4.2 13.4 0 20-4.2-6.6-4.2-15 0-20z" />
        <path d="M20 26c-2.2-6.4-7.8-10.6-14-10.6.7 6.4 6.4 10.6 14 10.6z" />
        <path d="M20 26c2.2-6.4 7.8-10.6 14-10.6-.7 6.4-6.4 10.6-14 10.6z" />
      </g>
      <path d="M8 32h24" stroke={accent ? "rgb(var(--accent))" : "currentColor"} strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2 font-semibold tracking-[0.14em] text-[0.95rem]", className)}>
      <LotusMark />
      WHITE-LOTUS
    </span>
  );
}
