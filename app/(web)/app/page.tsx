import { redirect } from "next/navigation";
import { WebApp } from "@/components/web/web-app";
import { isCloud } from "@/lib/edition";

export const metadata = { title: "WHITE-LOTUS" };
export const dynamic = "force-dynamic";

/** The online web app. Conversations live in this browser (IndexedDB / sessionStorage), not on the server. */
export default function Page() {
  if (!isCloud()) redirect("/chat");
  return <WebApp />;
}
