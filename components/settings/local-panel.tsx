"use client";

import { useCallback, useEffect, useState } from "react";
import { Cloud, FolderOpen, HardDrive, Lock, ShieldCheck, Trash2 } from "lucide-react";
import { Button, Card, IconButton, Input, Modal } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { api, ApiError } from "@/lib/client/api";
import { cn } from "@/lib/client/cn";

type Storage = {
  dataDir: string;
  configDir: string;
  folders: Record<string, string>;
  sizes: { database: number; files: number; backups: number; logs: number; total: number };
  counts: { conversations: number; messages: number; files: number; searches: number };
  keyProtection: "dpapi" | "file" | "none";
  cloudSyncedWarning: boolean;
  canManage: boolean;
  managedByLauncher: boolean;
  backups: Array<{ name: string; sizeBytes: number; createdAt: string }>;
};
type Flow = { id: string; service: string; destination: string; local: boolean; when: string; sends: string[]; neverSends: string[] };
type Privacy = { offlineMode: boolean; everythingLocal: boolean; flows: Flow[] };
type Search = { id: string; query: string; conversationId: string | null; createdAt: string };

const mb = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** After move / restore / wipe the app restarts itself: wait for it, then reload. */
function useRestartOverlay() {
  const [restarting, setRestarting] = useState<string | null>(null);
  const begin = useCallback((message: string, to = "/login") => {
    setRestarting(message);
    const started = Date.now();
    const poll = async () => {
      await new Promise((r) => setTimeout(r, 2500));
      try {
        const r = await fetch("/api/health", { cache: "no-store" });
        if (r.ok && Date.now() - started > 4000) return window.location.assign(to);
      } catch {
        /* still restarting */
      }
      if (Date.now() - started < 10 * 60_000) void poll();
    };
    void poll();
  }, []);
  const overlay = restarting ? (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-bg/90 p-6 text-center backdrop-blur" role="status">
      <div>
        <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-border border-t-fg" />
        <p className="mt-4 font-medium">{restarting}</p>
        <p className="mt-1 text-sm text-muted">WHITE-LOTUS is restarting on this computer. This page reloads by itself.</p>
      </div>
    </div>
  ) : null;
  return { begin, overlay };
}

export function LocalStoragePanel() {
  const toast = useToast();
  const [st, setSt] = useState<Storage | null>(null);
  const [pv, setPv] = useState<Privacy | null>(null);
  const { begin, overlay } = useRestartOverlay();

  const load = useCallback(() => {
    api<Storage>("/api/local/storage").then(setSt).catch((e) => toast((e as Error).message, "error"));
    api<Privacy>("/api/local/privacy").then(setPv).catch(() => {});
  }, [toast]);
  useEffect(load, [load]);

  if (!st) return <div className="h-40 animate-pulse rounded-2xl bg-surface" />;
  return (
    <div className="space-y-6">
      {overlay}
      <PrivacyCard pv={pv} />
      <StorageCard st={st} onMoved={(to) => begin(`Moving your data to ${to}…`, "/settings?tab=storage")} />
      {st.canManage && <BackupCard st={st} onRestored={() => begin("Restoring your backup…")} onChanged={load} />}
      <SearchHistoryCard />
      {st.canManage && <WipeCard managed={st.managedByLauncher} onWiped={() => begin("Deleting all local data…", "/")} />}
    </div>
  );
}

function PrivacyCard({ pv }: { pv: Privacy | null }) {
  if (!pv) return null;
  const external = pv.flows.filter((f) => !f.local);
  return (
    <Card>
      <div className="flex items-start gap-3">
        <div className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-xl", external.length ? "bg-accent/10 text-accent" : "bg-green-500/10 text-green-600")}>
          <ShieldCheck size={18} />
        </div>
        <div className="min-w-0">
          <h2 className="font-semibold">What leaves this computer</h2>
          <p className="mt-1 text-sm text-muted">
            Your conversations, files, search history, settings and memories are <strong className="text-fg">stored only on this computer</strong>. {external.length ? "To answer, some services receive data at the moment you use them:" : "With the current settings nothing is sent anywhere."}
            {pv.offlineMode && " Offline mode is on."}
          </p>
        </div>
      </div>
      <ul className="mt-4 space-y-3" data-testid="data-flows">
        {pv.flows.map((f) => (
          <li key={f.id} className="rounded-xl border border-border p-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              {f.local ? <HardDrive size={15} className="text-green-600" /> : <Cloud size={15} className="text-accent" />}
              <span className="font-medium">{f.service}</span>
              <span className="text-muted">→ {f.destination}</span>
              <span className={cn("ml-auto rounded-full px-2 py-0.5 text-xs", f.local ? "bg-green-500/10 text-green-700 dark:text-green-400" : "bg-accent/10 text-accent")}>{f.local ? "stays on this computer" : "leaves this computer"}</span>
            </div>
            <p className="mt-1 text-xs text-muted">{f.when}</p>
            {!f.local && (
              <div className="mt-2 grid gap-2 text-xs sm:grid-cols-2">
                <div>
                  <div className="font-medium">Sent</div>
                  <ul className="mt-0.5 list-disc pl-4 text-muted">{f.sends.map((x) => <li key={x}>{x}</li>)}</ul>
                </div>
                <div>
                  <div className="font-medium">Never sent</div>
                  <ul className="mt-0.5 list-disc pl-4 text-muted">{f.neverSends.map((x) => <li key={x}>{x}</li>)}</ul>
                </div>
              </div>
            )}
          </li>
        ))}
        {pv.flows.length === 0 && <li className="text-sm text-muted">No AI or search service is configured yet.</li>}
      </ul>
      <p className="mt-3 text-xs text-muted">Answers that a cloud AI generates are stored here, not there. Check that provider&apos;s terms for how long it keeps requests.</p>
    </Card>
  );
}

function StorageCard({ st, onMoved }: { st: Storage; onMoved: (to: string) => void }) {
  const toast = useToast();
  const [moving, setMoving] = useState(false);
  const [to, setTo] = useState("");
  const [deleteOld, setDeleteOld] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function move() {
    setErr(null);
    try {
      const r = await api<{ to: string }>("/api/local/move", { method: "POST", json: { to, deleteOld } });
      setMoving(false);
      onMoved(r.to);
    } catch (e) {
      setErr((e as Error).message);
    }
  }
  return (
    <Card>
      <h2 className="font-semibold">Local storage</h2>
      <div className="mt-3 rounded-xl bg-surface p-3">
        <div className="text-xs text-muted">Data folder</div>
        <div className="mt-0.5 break-all font-mono text-sm" data-testid="data-dir">{st.dataDir}</div>
        {st.cloudSyncedWarning && <p className="mt-2 text-xs text-danger">This folder looks like it syncs to a cloud service. Move it to a folder that stays on this computer.</p>}
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        {[
          ["Conversations", st.counts.conversations],
          ["Files", st.counts.files],
          ["Searches", st.counts.searches],
          ["Total size", mb(st.sizes.total)],
        ].map(([k, v]) => (
          <div key={String(k)} className="rounded-xl border border-border p-3">
            <dt className="text-xs text-muted">{k}</dt>
            <dd className="mt-0.5 font-semibold">{v}</dd>
          </div>
        ))}
      </dl>
      <ul className="mt-3 space-y-1 text-xs text-muted">
        <li>Database (conversations, history, settings, indexes): {mb(st.sizes.database)} — {st.folders.database}</li>
        <li>Files (uploads and saved answers, each encrypted): {mb(st.sizes.files)} — {st.folders.files}</li>
        <li className="flex items-center gap-1">
          <Lock size={12} /> Encryption keys: {st.keyProtection === "dpapi" ? "protected by your Windows account (DPAPI)" : "owner-only file"} in {st.configDir} — kept separate from the data folder
        </li>
      </ul>
      {st.canManage && (
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => api("/api/local/open-folder", { method: "POST" }).catch((e) => toast((e as Error).message, "error"))}>
            <FolderOpen size={15} /> Open folder
          </Button>
          <Button variant="outline" size="sm" onClick={() => setMoving(true)} disabled={!st.managedByLauncher} title={st.managedByLauncher ? undefined : "Start WHITE-LOTUS with the launcher to move data"}>
            Move data…
          </Button>
        </div>
      )}
      <Modal
        open={moving}
        onClose={() => setMoving(false)}
        title="Move your data folder"
        footer={
          <>
            <Button variant="ghost" onClick={() => setMoving(false)}>Cancel</Button>
            <Button onClick={move} disabled={!to.trim()}>Move and restart</Button>
          </>
        }
      >
        <p className="text-sm text-muted">Choose an empty folder on this computer (not OneDrive, Dropbox, Google Drive or iCloud). WHITE-LOTUS copies everything there, checks the copy, and restarts.</p>
        <label className="mt-3 block text-sm">
          <span className="mb-1 block text-muted">New folder (full path)</span>
          <Input value={to} onChange={(e) => setTo(e.target.value)} placeholder="D:\WHITE-LOTUS-data" aria-label="New data folder" />
        </label>
        <label className="mt-3 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={deleteOld} onChange={(e) => setDeleteOld(e.target.checked)} /> Delete the old folder after copying
        </label>
        {err && <p role="alert" className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{err}</p>}
      </Modal>
    </Card>
  );
}

function BackupCard({ st, onRestored, onChanged }: { st: Storage; onRestored: () => void; onChanged: () => void }) {
  const toast = useToast();
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [busy, setBusy] = useState(false);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [rpw, setRpw] = useState("");
  const [err, setErr] = useState<string | null>(null);

  async function backup() {
    if (pw.length < 10) return toast("Use a backup password of at least 10 characters.", "error");
    if (pw !== pw2) return toast("The passwords don't match.", "error");
    setBusy(true);
    try {
      const r = await fetch("/api/local/backup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: pw }) });
      if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: { message?: string } }).error?.message ?? "Backup failed.");
      const blob = await r.blob();
      const name = /filename="([^"]+)"/.exec(r.headers.get("content-disposition") ?? "")?.[1] ?? "white-lotus.wlbackup";
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();
      URL.revokeObjectURL(a.href);
      setPw("");
      setPw2("");
      toast("Encrypted backup created (also saved in the backups folder).", "success");
      onChanged();
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function restore() {
    if (!file) return;
    setErr(null);
    setBusy(true);
    const fd = new FormData();
    fd.append("file", file);
    fd.append("password", rpw);
    try {
      const r = await fetch("/api/local/restore", { method: "POST", body: fd });
      const j = (await r.json().catch(() => ({}))) as { error?: { message?: string } };
      if (!r.ok) throw new ApiError("restore_failed", j.error?.message ?? "Restore failed.", r.status);
      setRestoreOpen(false);
      onRestored();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <h2 className="font-semibold">Backup & restore</h2>
      <p className="mt-1 text-sm text-muted">
        One encrypted file with everything: conversations, files, search history, settings, memories and the keys needed to read them. Keep it on a USB drive or another disk. Without the backup password it can&apos;t be opened — WHITE-LOTUS can&apos;t recover a forgotten password.
      </p>
      <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
        <Input type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="Backup password (10+ characters)" aria-label="Backup password" autoComplete="new-password" />
        <Input type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} placeholder="Repeat password" aria-label="Repeat backup password" autoComplete="new-password" />
        <Button onClick={backup} disabled={busy}>{busy ? "Working…" : "Create backup"}</Button>
      </div>
      {st.backups.length > 0 && (
        <div className="mt-3 text-xs text-muted">
          In {st.folders.backups}:
          <ul className="mt-1 space-y-0.5">
            {st.backups.slice(0, 5).map((b) => (
              <li key={b.name} className="font-mono">{b.name} · {mb(b.sizeBytes)}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="mt-4">
        <Button variant="outline" size="sm" onClick={() => setRestoreOpen(true)} disabled={!st.managedByLauncher}>Restore from a backup…</Button>
      </div>
      <Modal
        open={restoreOpen}
        onClose={() => setRestoreOpen(false)}
        title="Restore a backup"
        footer={
          <>
            <Button variant="ghost" onClick={() => setRestoreOpen(false)}>Cancel</Button>
            <Button onClick={restore} disabled={!file || !rpw || busy}>{busy ? "Checking…" : "Restore and restart"}</Button>
          </>
        }
      >
        <p className="text-sm text-muted">Your current data is not deleted: it&apos;s kept as a copy next to the data folder. You&apos;ll sign in again with the accounts from the backup.</p>
        <input className="mt-3 block w-full text-sm" type="file" accept=".wlbackup" aria-label="Backup file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        <Input className="mt-3" type="password" value={rpw} onChange={(e) => setRpw(e.target.value)} placeholder="Backup password" aria-label="Backup password for restore" />
        {err && <p role="alert" className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{err}</p>}
      </Modal>
    </Card>
  );
}

function SearchHistoryCard() {
  const toast = useToast();
  const [items, setItems] = useState<Search[] | null>(null);
  const load = useCallback(() => {
    api<{ searches: Search[] }>("/api/local/search-history").then((r) => setItems(r.searches)).catch(() => setItems([]));
  }, []);
  useEffect(load, [load]);
  async function del(ids?: string[]) {
    try {
      await api("/api/local/search-history", { method: "DELETE", json: ids ? { ids } : {} });
      load();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  }
  return (
    <Card>
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold">Search history</h2>
          <p className="mt-1 text-sm text-muted">Web searches run for your questions, stored (encrypted) on this computer.</p>
        </div>
        {items && items.length > 0 && <Button variant="outline" size="sm" onClick={() => del()}>Clear all</Button>}
      </div>
      <ul className="mt-3 max-h-72 divide-y divide-border overflow-y-auto" data-testid="search-history">
        {items?.map((s) => (
          <li key={s.id} className="flex items-center gap-3 py-2 text-sm">
            <span className="min-w-0 flex-1 truncate">{s.query}</span>
            <span className="shrink-0 text-xs text-muted">{new Date(s.createdAt).toLocaleString()}</span>
            {s.conversationId && <a className="shrink-0 text-xs underline" href={`/chat/${s.conversationId}`}>Chat</a>}
            <IconButton label="Delete search" onClick={() => del([s.id])}>
              <Trash2 size={14} />
            </IconButton>
          </li>
        ))}
        {items?.length === 0 && <li className="py-2 text-sm text-muted">No searches yet.</li>}
      </ul>
    </Card>
  );
}

function WipeCard({ managed, onWiped }: { managed: boolean; onWiped: () => void }) {
  const [open, setOpen] = useState(false);
  const [word, setWord] = useState("");
  const [pw, setPw] = useState("");
  const [err, setErr] = useState<string | null>(null);
  async function wipe() {
    setErr(null);
    try {
      await api("/api/local/wipe", { method: "POST", json: { confirm: word, password: pw } });
      setOpen(false);
      onWiped();
    } catch (e) {
      setErr((e as Error).message);
    }
  }
  return (
    <Card className="border-danger/40">
      <h2 className="font-semibold text-danger">Delete everything on this computer</h2>
      <p className="mt-1 text-sm text-muted">Permanently deletes every account, conversation, file, search, memory, log and backup in the data folder, plus the encryption keys. Backups you saved elsewhere are not touched.</p>
      <Button className="mt-3" variant="danger" size="sm" onClick={() => setOpen(true)} disabled={!managed}>Delete all local data…</Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Delete all local WHITE-LOTUS data?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="danger" onClick={wipe} disabled={word !== "DELETE" || !pw}>Delete permanently</Button>
          </>
        }
      >
        <p className="text-sm text-muted">This can&apos;t be undone. Type DELETE and your password to confirm.</p>
        <Input className="mt-3" value={word} onChange={(e) => setWord(e.target.value)} placeholder="DELETE" aria-label="Type DELETE" />
        <Input className="mt-2" type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="Your password" aria-label="Your password" />
        {err && <p role="alert" className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{err}</p>}
      </Modal>
    </Card>
  );
}
