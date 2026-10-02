import { ProjectDetail } from "@/components/projects/project-detail";
import { AccountRequired, WHY } from "@/components/guest/account-required";
import { getViewer } from "@/lib/auth/viewer";

export const metadata = { title: "Project" };
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  if ((await getViewer())?.isGuest) return <AccountRequired feature="Projects" why={WHY.projects} />;
  const { id } = await params;
  return <ProjectDetail id={id} />;
}
