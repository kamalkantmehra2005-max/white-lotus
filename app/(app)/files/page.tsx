import { FilesPage } from "@/components/files/files-page";
import { AccountRequired, WHY } from "@/components/guest/account-required";
import { getViewer } from "@/lib/auth/viewer";

export const metadata = { title: "Files" };
export default async function Page() {
  if ((await getViewer())?.isGuest) return <AccountRequired feature="Files" why={WHY.files} />;
  return <FilesPage />;
}
