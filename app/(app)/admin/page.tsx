import { redirect } from "next/navigation";
import { AdminPage } from "@/components/admin/admin-page";
import { requireUser } from "@/lib/auth";

export const metadata = { title: "Admin" };
export const dynamic = "force-dynamic";

export default async function Page() {
  const user = await requireUser();
  if (user.role !== "admin") redirect("/chat");
  return <AdminPage />;
}
