"use client";

import { GlobalFooter } from "@/components/layout/global-footer";

export default function AppError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center">
      <h1 className="text-xl font-semibold">Something went wrong</h1>
      <p className="max-w-sm text-sm text-muted">WHITE-LOTUS couldn&apos;t complete that request. Please try again.</p>
      <button onClick={reset} className="rounded-xl bg-fg px-4 py-2 text-sm font-medium text-bg">Retry</button>
      <GlobalFooter />
    </div>
  );
}
