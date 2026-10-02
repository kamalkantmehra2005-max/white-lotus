import { ProjectsList } from "@/components/projects/projects-list";
import { AccountRequired, WHY } from "@/components/guest/account-required";
import { getViewer } from "@/lib/auth/viewer";

export const metadata = { title: "Projects" };
export default async function Page() {
  if ((await getViewer())?.isGuest) return <AccountRequired feature="Projects" why={WHY.projects} />;
  return <ProjectsList />;
}
