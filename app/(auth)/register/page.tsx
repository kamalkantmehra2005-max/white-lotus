import { Suspense } from "react";
import { AuthForm } from "@/components/auth/auth-form";
import { guestEnabled } from "@/lib/auth/guest";
import { getViewer } from "@/lib/auth/viewer";

export const metadata = { title: "Create account" };
export const dynamic = "force-dynamic";

export default async function Page() {
  const viewer = await getViewer();
  const googleEnabled = Boolean((process.env.GOOGLE_CLIENT_ID || process.env.AUTH_GOOGLE_ID) && (process.env.GOOGLE_CLIENT_SECRET || process.env.AUTH_GOOGLE_SECRET));
  return (
    <Suspense>
      <AuthForm mode="register" googleEnabled={googleEnabled} guestEnabled={guestEnabled()} isGuest={Boolean(viewer?.isGuest)} />
    </Suspense>
  );
}
