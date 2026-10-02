"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { signOut } from "next-auth/react";
import { useTheme } from "next-themes";
import { useCallback, useEffect, useState } from "react";
import { Pencil, Trash2 } from "lucide-react";
import { Button, Card, IconButton, Input, Modal, Switch, Textarea } from "@/components/ui/primitives";
import { PageShell } from "@/components/ui/page";
import { LocalStoragePanel } from "@/components/settings/local-panel";
import { useToast } from "@/components/ui/toast";
import { api } from "@/lib/client/api";
import { cn } from "@/lib/client/cn";

type Settings = { theme: string; defaultModel: string | null; defaultMode: string; memoryEnabled: boolean; webSearchDefault: boolean; customInstructions: string | null; responseStyle: string | null };
type Mem = { id: string; content: string; scope: string; source: string; updatedAt: string };
type Usage = { messages: { used: number; limit: number }; searches: { used: number; limit: number }; uploads: { used: number; limit: number }; resetsAt: string };
const TABS = ["general", "personalization", "memory", "storage", "security", "usage", "data"] as const;
const TAB_LABEL: Record<string, string> = { storage: "Privacy & storage" };
type Me = { name: string | null; email: string; emailVerified?: boolean; hasPassword?: boolean };

export function SettingsPage() {
  const params = useSearchParams();
  const router = useRouter();
  const tab = (TABS as readonly string[]).includes(params.get("tab") ?? "") ? (params.get("tab") as (typeof TABS)[number]) : "general";
  const [s, setS] = useState<Settings | null>(null);
  const [user, setUser] = useState<Me | null>(null);
  const [models, setModels] = useState<Array<{ id: string; label: string }>>([]);
  const [modes, setModes] = useState<Array<{ id: string; label: string }>>([]);
  const toast = useToast();
  const { setTheme } = useTheme();

  useEffect(() => {
    api<{ settings: Settings; user: Me }>("/api/settings").then((r) => (setS(r.settings), setUser(r.user)));
    api<{ models: Array<{ id: string; label: string }>; modes: Array<{ id: string; label: string }> }>("/api/models").then((r) => (setModels(r.models), setModes(r.modes)));
  }, []);

  const save = useCallback(
    async (patch: Partial<Settings> & { name?: string }) => {
      try {
        const r = await api<{ settings: Settings }>("/api/settings", { method: "PATCH", json: patch });
        setS(r.settings);
        toast("Saved", "success");
      } catch (e) {
        toast((e as Error).message, "error");
      }
    },
    [toast],
  );

  return (
    <PageShell title="Settings">
      <div className="mb-6 flex gap-1 overflow-x-auto border-b border-border">
        {TABS.map((t) => (
          <button key={t} onClick={() => router.replace(`/settings?tab=${t}`)} className={cn("-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm capitalize", tab === t ? "border-fg font-medium" : "border-transparent text-muted hover:text-fg")}>
            {TAB_LABEL[t] ?? t}
          </button>
        ))}
      </div>
      {!s ? (
        <div className="h-40 animate-pulse rounded-2xl bg-surface" />
      ) : tab === "general" ? (
        <div className="space-y-4">
          <Card>
            <Row label="Name"><NameField key={user?.name ?? ""} initial={user?.name ?? ""} onSave={(name) => save({ name })} /></Row>
            <Row label="Email"><span className="text-sm text-muted">{user?.email}</span></Row>
            <Row label="Theme">
              <select className="h-9 rounded-lg border border-border bg-bg px-2 text-sm" value={s.theme} onChange={(e) => (setTheme(e.target.value), save({ theme: e.target.value }))}>
                <option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option>
              </select>
            </Row>
            <Row label="Default model">
              <select className="h-9 max-w-[220px] rounded-lg border border-border bg-bg px-2 text-sm" value={s.defaultModel ?? ""} onChange={(e) => save({ defaultModel: e.target.value || null })}>
                <option value="">Server default</option>
                {models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
            </Row>
            <Row label="Default mode">
              <select className="h-9 rounded-lg border border-border bg-bg px-2 text-sm" value={s.defaultMode} onChange={(e) => save({ defaultMode: e.target.value })}>
                {modes.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
            </Row>
            <Row label="Web search on by default" last><Switch label="Web search by default" checked={s.webSearchDefault} onChange={(v) => save({ webSearchDefault: v })} /></Row>
          </Card>
        </div>
      ) : tab === "personalization" ? (
        <Personalization s={s} onSave={save} />
      ) : tab === "memory" ? (
        <MemoryPanel enabled={s.memoryEnabled} onToggle={(v) => save({ memoryEnabled: v })} />
      ) : tab === "storage" ? (
        <LocalStoragePanel />
      ) : tab === "security" ? (
        <SecurityPanel me={user} />
      ) : tab === "usage" ? (
        <UsagePanel />
      ) : (
        <DataPanel />
      )}
    </PageShell>
  );
}

function Row({ label, children, last }: { label: string; children: React.ReactNode; last?: boolean }) {
  return <div className={cn("flex items-center justify-between gap-4 py-3", !last && "border-b border-border")}><span className="text-sm">{label}</span>{children}</div>;
}

function NameField({ initial, onSave }: { initial: string; onSave: (v: string) => void }) {
  const [v, setV] = useState(initial);
  return <Input value={v} onChange={(e) => setV(e.target.value)} onBlur={() => v.trim() && v !== initial && onSave(v.trim())} className="h-9 max-w-[220px]" maxLength={80} />;
}

function Personalization({ s, onSave }: { s: Settings; onSave: (p: Partial<Settings>) => void }) {
  const [ci, setCi] = useState(s.customInstructions ?? "");
  const [rs, setRs] = useState(s.responseStyle ?? "");
  return (
    <Card className="space-y-5">
      <div>
        <label className="text-sm font-medium" htmlFor="ci">Custom instructions</label>
        <p className="mb-2 text-sm text-muted">What should WHITE-LOTUS know about you to give better answers?</p>
        <Textarea id="ci" rows={6} maxLength={5000} value={ci} onChange={(e) => setCi(e.target.value)} placeholder="e.g. I'm a patent attorney in India. Use Indian English and cite statutes where relevant." />
      </div>
      <div>
        <label className="text-sm font-medium" htmlFor="rs">Response style</label>
        <p className="mb-2 text-sm text-muted">How should it respond?</p>
        <Textarea id="rs" rows={3} maxLength={1000} value={rs} onChange={(e) => setRs(e.target.value)} placeholder="e.g. Concise, bullet points first, no filler." />
      </div>
      <div className="flex justify-end"><Button onClick={() => onSave({ customInstructions: ci || null, responseStyle: rs || null })}>Save</Button></div>
    </Card>
  );
}

function MemoryPanel({ enabled, onToggle }: { enabled: boolean; onToggle: (v: boolean) => void }) {
  const [mems, setMems] = useState<Mem[] | null>(null);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<Mem | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const toast = useToast();
  const load = useCallback(() => api<{ memories: Mem[] }>("/api/memories").then((r) => setMems(r.memories)), []);
  useEffect(() => void load(), [load]);
  const add = () => draft.trim() && api("/api/memories", { method: "POST", json: { content: draft } }).then(() => (setDraft(""), load())).catch((e) => toast(e.message, "error"));

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="text-sm font-medium">Memory</div>
            <p className="text-sm text-muted">WHITE-LOTUS only saves things you explicitly ask it to remember — never passwords, card numbers or other sensitive data. When off, saved memories are not used.</p>
          </div>
          <Switch label="Memory enabled" checked={enabled} onChange={onToggle} />
        </div>
      </Card>
      <Card>
        <div className="mb-3 flex gap-2">
          <Input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Add a memory, e.g. “I prefer metric units”" onKeyDown={(e) => e.key === "Enter" && add()} maxLength={1000} />
          <Button onClick={add}>Add</Button>
        </div>
        {mems === null ? <div className="h-16 animate-pulse rounded-xl bg-surface" /> : mems.length === 0 ? <p className="text-sm text-muted">No memories saved.</p> : (
          <ul className="divide-y divide-border">
            {mems.map((m) => (
              <li key={m.id} className="flex items-start justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <p className="text-sm">{m.content}</p>
                  <p className="mt-0.5 text-xs text-muted">{m.scope === "project" ? "Project memory" : "Personal"} · {m.source === "assistant" ? "saved on request in chat" : "added by you"} · {new Date(m.updatedAt).toLocaleDateString()}</p>
                </div>
                <div className="flex shrink-0">
                  <IconButton label="Edit memory" onClick={() => setEditing(m)}><Pencil size={14} /></IconButton>
                  <IconButton label="Delete memory" onClick={() => api(`/api/memories/${m.id}`, { method: "DELETE" }).then(load)}><Trash2 size={14} /></IconButton>
                </div>
              </li>
            ))}
          </ul>
        )}
        {mems && mems.length > 0 && <div className="mt-3 flex justify-end"><Button variant="outline" size="sm" onClick={() => setConfirmClear(true)}>Delete all memories</Button></div>}
      </Card>
      <EditMemory key={editing?.id ?? "none"} m={editing} onClose={() => setEditing(null)} onSaved={() => (setEditing(null), load())} />
      <Modal open={confirmClear} onClose={() => setConfirmClear(false)} title="Delete all memories?" footer={<><Button variant="ghost" onClick={() => setConfirmClear(false)}>Cancel</Button><Button variant="danger" onClick={() => api("/api/memories", { method: "DELETE" }).then(() => (setConfirmClear(false), load()))}>Delete all</Button></>}>
        <p className="text-sm text-muted">This permanently removes every saved memory, including project memories.</p>
      </Modal>
    </div>
  );
}

function EditMemory({ m, onClose, onSaved }: { m: Mem | null; onClose: () => void; onSaved: () => void }) {
  const [v, setV] = useState(m?.content ?? "");
  const toast = useToast();
  return (
    <Modal open={Boolean(m)} onClose={onClose} title="Edit memory" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={() => m && api(`/api/memories/${m.id}`, { method: "PATCH", json: { content: v } }).then(onSaved).catch((e) => toast(e.message, "error"))}>Save</Button></>}>
      <Textarea rows={3} value={v} onChange={(e) => setV(e.target.value)} maxLength={1000} />
    </Modal>
  );
}

function UsagePanel() {
  const [u, setU] = useState<Usage | null>(null);
  useEffect(() => void api<{ usage: Usage }>("/api/usage").then((r) => setU(r.usage)), []);
  if (!u) return <div className="h-32 animate-pulse rounded-2xl bg-surface" />;
  const rows: Array<[string, { used: number; limit: number }]> = [["Messages", u.messages], ["Web searches", u.searches], ["Uploads", u.uploads]];
  return (
    <Card className="space-y-4">
      <p className="text-sm text-muted">WHITE-LOTUS is free within daily limits that keep it sustainable for everyone. Limits reset {new Date(u.resetsAt).toLocaleString()}.</p>
      {rows.map(([label, r]) => (
        <div key={label}>
          <div className="mb-1 flex justify-between text-sm"><span>{label}</span><span className="text-muted">{r.used} / {r.limit === 0 ? "∞" : r.limit}</span></div>
          <div className="h-2 overflow-hidden rounded-full bg-surface"><div className="h-full rounded-full bg-accent transition-all" style={{ width: `${r.limit === 0 ? 2 : Math.min(100, (r.used / r.limit) * 100)}%` }} /></div>
        </div>
      ))}
    </Card>
  );
}

function SecurityPanel({ me }: { me: Me | null }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [confirmAll, setConfirmAll] = useState(false);
  async function changePassword(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    if (fd.get("newPassword") !== fd.get("confirm")) return toast("New passwords don't match.", "error");
    setBusy(true);
    try {
      await api("/api/settings/password", { method: "POST", json: { currentPassword: fd.get("currentPassword") || undefined, newPassword: fd.get("newPassword") } });
      toast("Password changed. Please sign in again.", "success");
      await signOut({ callbackUrl: "/login?reset=1" });
    } catch (err) {
      toast((err as Error).message, "error");
    }
    setBusy(false);
    form.reset();
  }
  return (
    <div className="space-y-4">
      <Card>
        <Row label="Email">
          <span className="text-sm text-muted">
            {me?.email} · {me?.emailVerified ? "verified" : "not verified"}
          </span>
        </Row>
        <Row label="This device" last>
          <Button variant="outline" size="sm" onClick={() => signOut({ callbackUrl: "/login" })}>Sign out</Button>
        </Row>
      </Card>
      <ActiveSessions onSignOutEverywhere={() => setConfirmAll(true)} />
      <Card>
        <h2 className="mb-1 text-sm font-medium">{me?.hasPassword ? "Change password" : "Set a password"}</h2>
        <p className="mb-4 text-sm text-muted">Passwords are hashed with Argon2id. Changing it signs you out everywhere.</p>
        <form onSubmit={changePassword} className="grid gap-3 sm:max-w-sm">
          {me?.hasPassword && <Input name="currentPassword" type="password" placeholder="Current password" autoComplete="current-password" required maxLength={200} />}
          <Input name="newPassword" type="password" placeholder="New password" autoComplete="new-password" required minLength={10} maxLength={200} />
          <Input name="confirm" type="password" placeholder="Confirm new password" autoComplete="new-password" required minLength={10} maxLength={200} />
          <Button type="submit" disabled={busy} className="justify-self-start">{busy ? "Saving…" : "Update password"}</Button>
        </form>
      </Card>
      <Modal
        open={confirmAll}
        onClose={() => setConfirmAll(false)}
        title="Sign out everywhere?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmAll(false)}>Cancel</Button>
            <Button onClick={() => api("/api/settings/sessions", { method: "DELETE" }).then(() => signOut({ callbackUrl: "/login" }))}>Sign out everywhere</Button>
          </>
        }
      >
        <p className="text-sm text-muted">Every device signed in to this account, including this one, will be signed out.</p>
      </Modal>
    </div>
  );
}

type ActiveSession = { id: string; device: string; ipPrefix: string | null; createdAt: string; lastSeenAt: string; expiresAt: string; current: boolean };

function ActiveSessions({ onSignOutEverywhere }: { onSignOutEverywhere: () => void }) {
  const toast = useToast();
  const [list, setList] = useState<ActiveSession[] | null>(null);
  const load = useCallback(() => api<{ sessions: ActiveSession[] }>("/api/settings/sessions").then((r) => setList(r.sessions)).catch((e) => toast(e.message, "error")), [toast]);
  useEffect(() => {
    const t = setTimeout(load, 0);
    return () => clearTimeout(t);
  }, [load]);
  async function revoke(s: ActiveSession) {
    try {
      await api(`/api/settings/sessions/${s.id}`, { method: "DELETE" });
      if (s.current) return void signOut({ callbackUrl: "/login" });
      toast(`Signed out ${s.device}`, "success");
      void load();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  }
  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium">Active sessions</h2>
          <p className="text-sm text-muted">Devices currently signed in. Sessions end after 12 hours of inactivity or 7 days at most (server defaults).</p>
        </div>
        <Button variant="danger" size="sm" onClick={onSignOutEverywhere}>Sign out everywhere</Button>
      </div>
      {list === null ? (
        <div className="h-12 animate-pulse rounded-xl bg-surface" />
      ) : (
        <ul className="divide-y divide-border">
          {list.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
              <div className="min-w-0">
                <div className="text-sm font-medium">
                  {s.device} {s.current && <span className="ml-1 rounded-md bg-accent/15 px-1.5 py-0.5 text-[11px] font-medium text-accent">This device</span>}
                </div>
                <div className="text-xs text-muted">
                  Signed in {new Date(s.createdAt).toLocaleString()} · last active {new Date(s.lastSeenAt).toLocaleString()}
                  {s.ipPrefix ? ` · network ${s.ipPrefix}` : ""}
                </div>
              </div>
              <Button size="sm" variant="ghost" onClick={() => revoke(s)}>{s.current ? "Sign out" : "Revoke"}</Button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function DataPanel() {
  const [confirm, setConfirm] = useState<null | "conversations" | "account">(null);
  const router = useRouter();
  const toast = useToast();
  async function run() {
    if (!confirm) return;
    try {
      await api(`/api/settings?what=${confirm}`, { method: "DELETE" });
      if (confirm === "account") await signOut({ callbackUrl: "/" });
      else {
        toast("All conversations deleted", "success");
        router.push("/chat");
      }
    } catch (e) {
      toast((e as Error).message, "error");
    }
    setConfirm(null);
  }
  return (
    <Card>
      <Row label="Export everything, readable (ZIP: conversations as Markdown, your files, JSON)">
        <a href="/api/settings/export?format=zip" className="inline-flex h-8 shrink-0 items-center rounded-xl border border-border px-3 text-sm font-medium hover:bg-surface">Download ZIP</a>
      </Row>
      <Row label="Export as a single JSON file">
        <a href="/api/settings/export" className="inline-flex h-8 shrink-0 items-center rounded-xl border border-border px-3 text-sm font-medium hover:bg-surface">Download JSON</a>
      </Row>
      <Row label="Delete all conversations"><Button variant="outline" size="sm" onClick={() => setConfirm("conversations")}>Delete</Button></Row>
      <Row label="Delete account and all data" last><Button variant="danger" size="sm" onClick={() => setConfirm("account")}>Delete account</Button></Row>
      <Modal open={Boolean(confirm)} onClose={() => setConfirm(null)} title={confirm === "account" ? "Delete your account?" : "Delete all conversations?"} footer={<><Button variant="ghost" onClick={() => setConfirm(null)}>Cancel</Button><Button variant="danger" onClick={run}>Delete permanently</Button></>}>
        <p className="text-sm text-muted">{confirm === "account" ? "Your account, conversations, files, projects and memories will be permanently deleted." : "Every conversation and message will be permanently deleted. Files and memories are kept."}</p>
      </Modal>
    </Card>
  );
}
