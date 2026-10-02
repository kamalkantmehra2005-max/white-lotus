"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { FolderKanban, Plus } from "lucide-react";
import { Button, Input, Modal, Textarea } from "@/components/ui/primitives";
import { PageShell } from "@/components/ui/page";
import { useToast } from "@/components/ui/toast";
import { api } from "@/lib/client/api";

type P = { id: string; name: string; description: string | null; updatedAt: string; conversations: number };

export function ProjectsList() {
  const [projects, setProjects] = useState<P[] | null>(null);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: "", description: "", instructions: "" });
  const toast = useToast();
  const router = useRouter();

  useEffect(() => {
    api<{ projects: P[] }>("/api/projects").then((r) => setProjects(r.projects)).catch((e) => toast(e.message, "error"));
  }, [toast]);

  async function create() {
    try {
      const r = await api<{ project: { id: string } }>("/api/projects", { method: "POST", json: form });
      router.push(`/projects/${r.project.id}`);
    } catch (e) {
      toast((e as Error).message, "error");
    }
  }

  return (
    <PageShell
      title="Projects"
      description="Group conversations and files with shared instructions and memory."
      actions={<Button onClick={() => setOpen(true)}><Plus size={16} /> New project</Button>}
    >
      {projects === null ? (
        <div className="grid gap-3 sm:grid-cols-2">{[0, 1].map((i) => <div key={i} className="h-24 animate-pulse rounded-2xl bg-surface" />)}</div>
      ) : projects.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border p-10 text-center">
          <FolderKanban className="mx-auto text-muted" />
          <p className="mt-3 font-medium">No projects yet</p>
          <p className="mt-1 text-sm text-muted">Create one for “Build my website”, a thesis, a client — anything with ongoing context.</p>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {projects.map((p) => (
            <Link key={p.id} href={`/projects/${p.id}`} className="rounded-2xl border border-border p-4 transition-colors hover:border-accent/40 hover:bg-surface">
              <div className="flex items-center gap-2 font-medium"><FolderKanban size={16} className="text-accent" /> {p.name}</div>
              {p.description && <p className="mt-1.5 line-clamp-2 text-sm text-muted">{p.description}</p>}
              <p className="mt-3 text-xs text-muted">{p.conversations} conversation{p.conversations === 1 ? "" : "s"} · updated {new Date(p.updatedAt).toLocaleDateString()}</p>
            </Link>
          ))}
        </div>
      )}

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="New project"
        footer={<><Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button><Button onClick={create} disabled={!form.name.trim()}>Create</Button></>}
      >
        <div className="space-y-3">
          <Input placeholder="Project name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={120} />
          <Input placeholder="Short description (optional)" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} maxLength={1000} />
          <Textarea placeholder="Custom instructions for every chat in this project (optional)" rows={4} value={form.instructions} onChange={(e) => setForm({ ...form, instructions: e.target.value })} />
        </div>
      </Modal>
    </PageShell>
  );
}
