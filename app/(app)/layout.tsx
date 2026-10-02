import { redirect } from "next/navigation";
import { AppShell } from "@/components/sidebar/app-shell";
import { ThemeSync } from "@/components/ui/theme-sync";
import { requireUser } from "@/lib/auth";
import { getSettings } from "@/lib/memory";
import { guestRetentionHours } from "@/lib/auth/guest";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const result = await requireUser().then(
    (u) => ({ user: u, code: undefined as string | undefined }),
    (e: unknown) => ({ user: null, code: (e as { code?: string }).code }),
  );
  const user = result.user;
  if (!user) redirect(result.code === "session_expired" ? "/login?expired=1" : result.code === "guest_ended" ? "/?ended=guest" : "/login");
  const settings = await getSettings(user.id).catch(() => null);
  return (
    <AppShell user={{ name: user.name ?? null, email: user.email ?? "", role: user.role, isGuest: user.isGuest, guestExpiresAt: user.guestExpiresAt?.toISOString() ?? null }} guestRetentionHours={guestRetentionHours()}>
      <ThemeSync theme={settings?.theme ?? null} />
      {children}
    </AppShell>
  );
}
