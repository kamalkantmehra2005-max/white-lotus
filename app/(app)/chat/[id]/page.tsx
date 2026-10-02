import { notFound } from "next/navigation";
import { ChatView } from "@/components/chat/chat-view";
import type { UiMessage } from "@/components/chat/message";
import { requireUser } from "@/lib/auth";
import { getConversationWithMessages } from "@/lib/chat/conversations";
import { findProject } from "@/lib/projects";

export const dynamic = "force-dynamic";

export default async function ConversationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const conv = await getConversationWithMessages(user.id, id).catch(() => null);
  if (!conv) notFound();
  const project = conv.projectId ? await findProject(user.id, conv.projectId) : null;
  const messages: UiMessage[] = conv.messages.map((m) => ({
    id: m.id,
    role: m.role,
    content: m.content,
    metadata: m.metadata,
    attachments: m.attachments.map((a) => ({ id: a.id, fileName: a.fileName, mimeType: a.mimeType, kind: a.kind, sizeBytes: a.sizeBytes })),
  }));
  return (
    <ChatView
      key={conv.id}
      initial={{ id: conv.id, title: conv.title, mode: conv.mode, model: conv.model, messages }}
      projectId={conv.projectId}
      projectName={project?.name ?? null}
    />
  );
}
