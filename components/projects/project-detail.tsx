"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Brain, FileText, MessageSquare, Plus, Trash2, Upload } from "lucide-react";
import { ChatView } from "@/components/chat/chat-view";
import { Button, Card, IconButton, Input, Modal, Textarea } from "@/components/ui/primitives";
import { PageShell } from "@/components/ui/page";
import { useToast } from "@/components/ui/toast";
import { api, bus } from "@/lib/client/api";
import { ACCEPT_ATTR } from "@/lib/files/validate";

type Data = {
  project: { id: string; name: string; description: string | null; instructions: string | null };
  conversations: Array<{ id: string; title: string; updatedAt: string }>;
  files: Array<{ id: string; fileName: string; sizeBytes: number; status: string }>;
  memories: Array<{ id: string; content: string }>;
};

export function ProjectDetail({ id }: { id: string }) {
  const [data, setData] = useState<Data | null>(null);
  const [chatting, setChatting] = useState(false);
  const [instr, setInstr] = useState("");
  const [memo, setMemo] = useState("");
  const [confirm, setConfirm] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const toast = useToast();
  const router = useRouter();

  const load = useCallback(async () => {
    try {
      const d = await api<Data>(`/api/projects/${id}`);
      setData(d);
      setInstr(d.project.instructions ?? "");
    } catch (e) {
      toast((e as Error).message, "error");
    }
  }, [id, toast]);
  useEffect(() => {
    const t = setTimeout(load, 0); // defer: never set state synchronously inside an effect
    const off = bus.on("conversations:changed", load);
    return () => (clearTimeout(t), off());
  }, [load]);

  if (chatting && data) {
    return <ChatView projectId={id} projectName={data.project.name} />;
  }
  if (!data) return <PageShell title="Loading…"><div className="h-40 animate-pulse rounded-2xl bg-surface" /></PageShell>;

  const saveInstr = async () => {
    await api(`/api/projects/${id}`, { method: "PATCH", json: { instructions: instr || null } }).then(() => toast("Instructions saved", "success")).catch((e) => toast(e.message, "error"));
  };
  const addMemory = async () => {
    if (!memo.trim()) return;
    await api("/api/memories", { method: "POST", json: { content: memo, projectId: id } }).then(() => (setMemo(""), load())).catch((e) => toast(e.message, "error"));
  };
  const upload = async (files: FileList) => {
    for (const f of [...files]) {
      const fd = new FormData();
      fd.append("file", f);
      fd.append("projectId", id);
      await api("/api/files", { method: "POST", body: fd }).catch((e) => toast(e.message, "error"));
    }
    await load();
  };

  return (
    <PageShell
      title={data.project.name}
      description={data.project.description ?? undefined}
      actions={
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setConfirm(true)}><Trash2 size={15} /> Delete</Button>
          <Button onClick={() => setChatting(true)}><Plus size={16} /> New chat</Button>
        </div>
      }
    >
      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <div className="space-y-4">
          <Card>
            <h2 className="mb-3 flex items-center gap-2 font-medium"><MessageSquare size={16} /> Conversations</h2>
            {data.conversations.length === 0 ? (
              <p className="text-sm text-muted">No chats yet. Start one — it will use this project&apos;s instructions, files and memory.</p>
            ) : (
              <ul className="divide-y divide-border">
                {data.conversations.map((c) => (
                  <li key={c.id}>
                    <Link href={`/chat/${c.id}`} className="flex items-center justify-between py-2.5 text-sm hover:text-accent">
                      <span className="truncate">{c.title}</span>
                      <span className="shrink-0 pl-4 text-xs text-muted">{new Date(c.updatedAt).toLocaleDateString()}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card>
            <h2 className="mb-1 font-medium">Project instructions</h2>
            <p className="mb-3 text-sm text-muted">Applied to every conversation in this project.</p>
            <Textarea rows={6} value={instr} onChange={(e) => setInstr(e.target.value)} placeholder="e.g. We're building a Next.js site for a bakery. Prefer TypeScript and Tailwind. Keep copy warm and concise." />
            <div className="mt-3 flex justify-end"><Button size="sm" onClick={saveInstr}>Save</Button></div>
          </Card>
        </div>
        <div className="space-y-4">
          <Card>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="flex items-center gap-2 font-medium"><FileText size={16} /> Files</h2>
              <input ref={fileRef} type="file" hidden multiple accept={ACCEPT_ATTR} onChange={(e) => e.target.files && void upload(e.target.files)} />
              <IconButton label="Upload file" onClick={() => fileRef.current?.click()}><Upload size={15} /></IconButton>
            </div>
            {data.files.length === 0 ? <p className="text-sm text-muted">No files yet.</p> : (
              <ul className="space-y-1.5 text-sm">
                {data.files.map((f) => <li key={f.id} className="flex justify-between gap-2"><span className="truncate">{f.fileName}</span><span className="shrink-0 text-xs text-muted">{f.status}</span></li>)}
              </ul>
            )}
          </Card>
          <Card>
            <h2 className="mb-3 flex items-center gap-2 font-medium"><Brain size={16} /> Project memory</h2>
            <ul className="mb-3 space-y-1.5 text-sm">
              {data.memories.map((m) => (
                <li key={m.id} className="group flex items-start justify-between gap-2">
                  <span>{m.content}</span>
                  <button className="text-muted opacity-0 hover:text-danger group-hover:opacity-100" aria-label="Delete memory" onClick={() => api(`/api/memories/${m.id}`, { method: "DELETE" }).then(load)}><Trash2 size={13} /></button>
                </li>
              ))}
            </ul>
            <div className="flex gap-2">
              <Input value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="Add a fact…" className="h-9" onKeyDown={(e) => e.key === "Enter" && addMemory()} />
              <Button size="sm" onClick={addMemory}>Add</Button>
            </div>
          </Card>
        </div>
      </div>
      <Modal
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Delete project?"
        footer={<><Button variant="ghost" onClick={() => setConfirm(false)}>Cancel</Button><Button variant="danger" onClick={() => api(`/api/projects/${id}`, { method: "DELETE" }).then(() => router.push("/projects"))}>Delete</Button></>}
      >
        <p className="text-sm text-muted">The project and its memory are deleted. Conversations and files are kept and moved out of the project.</p>
      </Modal>
    </PageShell>
  );
}
