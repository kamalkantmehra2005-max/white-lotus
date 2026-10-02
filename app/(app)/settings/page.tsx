import { Suspense } from "react";
import { SettingsPage } from "@/components/settings/settings-page";
import { AccountRequired, WHY } from "@/components/guest/account-required";
import { getViewer } from "@/lib/auth/viewer";

export const metadata = { title: "Settings" };
export default async function Page({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  if ((await getViewer())?.isGuest) {
    const memory = (await searchParams).tab === "memory";
    return <AccountRequired feature={memory ? "Memory" : "Settings"} why={memory ? WHY.memory : WHY.settings} />;
  }
  return (
    <Suspense>
      <SettingsPage />
    </Suspense>
  );
}
