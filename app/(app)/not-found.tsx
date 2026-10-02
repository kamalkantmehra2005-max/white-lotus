import Link from "next/link";
import { GlobalFooter } from "@/components/layout/global-footer";

export default function NotFound() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
      <h1 className="text-xl font-semibold">Not found</h1>
      <p className="text-sm text-muted">That conversation doesn&apos;t exist or you don&apos;t have access to it.</p>
      <Link href="/chat" className="rounded-xl bg-fg px-4 py-2 text-sm font-medium text-bg">Start a new chat</Link>
      <GlobalFooter />
    </div>
  );
}
