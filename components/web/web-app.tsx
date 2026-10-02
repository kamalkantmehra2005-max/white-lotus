"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { getSession, signOut } from "next-auth/react";
import { CloudOff, Download, Globe, Menu, Paperclip, Plus, RefreshCw, Send, Settings2, Shield, Square, Trash2, Upload, UserRound, X } from "lucide-react";
import { LotusMark, Wordmark } from "@/components/brand/logo";
import { Markdown } from "@/components/chat/markdown";
import { Button, Textarea } from "@/components/ui/primitives";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { useToast } from "@/components/ui/toast";
import { CREATOR } from "@/config/creator";
import { decodeEvents } from "@/lib/chat/protocol";
import { cn } from "@/lib/client/cn";
import { AuthPanel, loginSecret, type Account } from "./auth-panel";
import { accountStore, DEFAULT_SETTINGS, forgetDeviceKey, loadDeviceKey, newId, saveDeviceKey, temporaryActive, temporaryStore, type Conv, type Msg, type Settings, type Store } from "./store";
import { syncNow } from "./sync";

type Config = { edition: string; models: Array<{ id: string; label: string; vision: boolean }>; defaultModel: string | null; webSearch: boolean; signup: boolean; maxUploadMb: number };
type Pending = { kind: "file"; name: string; text: string } | { kind: "image"; name: string; mimeType: string; data: string };
type Phase = "loading" | "choose" | "auth" | "unlock" | "ready";

const MODES = [
  ["quick", "Quick"],
  ["think", "Think"],
  ["research", "Research"],
  ["code", "Code"],
  ["creative", "Creative"],
  ["analyze", "Analyze"],
] as const;
const DOC_ACCEPT = ".pdf,.docx,.pptx,.xlsx,.csv,.txt,.md,.json,.rtf,.html,.xml,.js,.ts,.py,.java,.c,.cpp,.cs,.go,.rb,.php,.sql,.yaml,.yml";
const IMG_ACCEPT = "image/png,image/jpeg,image/webp,image/gif";

/** Shrink a photo in the browser so it fits hosting request limits (and costs less to send). */
async function imageToBase64(file: File): Promise<{ mimeType: string; data: string }> {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
  const url = c.toDataURL("image/jpeg", 0.85);
  return { mimeType: "image/jpeg", data: url.slice(url.indexOf(",") + 1) };
}

export function WebApp() {
  const toast = useToast();
  const [phase, setPhase] = useState<Phase>("loading");
  const [cfg, setCfg] = useState<Config | null>(null);
  const [acct, setAcct] = useState<Account | null>(null);
  const [lockedEmail, setLockedEmail] = useState<string | undefined>();
  const [store, setStore] = useState<Store | null>(null);
  const [convs, setConvs] = useState<Conv[]>([]);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<Pending[]>([]);
  const [webSearch, setWebSearch] = useState(false);
  const [busy, setBusy] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [panel, setPanel] = useState<null | "settings" | "account">(null);
  const [syncState, setSyncState] = useState<"idle" | "syncing" | "error" | "off">("idle");
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const syncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ---------- start-up: which mode is this tab in? ----------
  useEffect(() => {
    (async () => {
      const c = (await fetch("/api/web/config").then((r) => r.json()).catch(() => null)) as Config | null;
      setCfg(c);
      const s = await getSession().catch(() => null);
      const u = s?.user as { id?: string; email?: string; name?: string | null; role?: "user" | "admin" } | undefined;
      if (u?.id) {
        const k = await loadDeviceKey(u.id).catch(() => null);
        if (k) return openAccount({ userId: u.id, email: u.email ?? k.email, name: u.name ?? k.name, role: u.role ?? "user", vaultKey: k.vaultKey }, false);
        setLockedEmail(u.email ?? undefined);
        return setPhase("unlock");
      }
      if (temporaryActive()) return openTemporary();
      setPhase("choose");
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const reload = useCallback(async (st: Store) => {
    setConvs((await st.list()).filter((c) => !c.deleted).sort((a, b) => b.updatedAt - a.updatedAt));
    setSettings(await st.getSettings());
  }, []);

  const runSync = useCallback(
    async (st: Store | null = store, a: Account | null = acct) => {
      if (!st || st.kind !== "account" || !a) return;
      const s = await st.getSettings();
      if (!s.sync) return setSyncState("off");
      setSyncState("syncing");
      try {
        const r = await syncNow(st, a.userId, a.vaultKey);
        setSyncState("idle");
        if (r.pulled) await reload(st);
      } catch {
        setSyncState("error");
      }
    },
    [store, acct, reload],
  );
  const scheduleSync = useCallback(() => {
    if (syncTimer.current) clearTimeout(syncTimer.current);
    syncTimer.current = setTimeout(() => void runSync(), 1500);
  }, [runSync]);

  async function openAccount(a: Account, keepTemporary: boolean) {
    await saveDeviceKey({ userId: a.userId, email: a.email, name: a.name, vaultKey: a.vaultKey });
    const st = await accountStore(a.userId);
    if (temporaryActive()) {
      const tmp = temporaryStore();
      if (keepTemporary) for (const c of await tmp.list()) await st.put({ ...c, dirty: true, updatedAt: Date.now() });
      await tmp.destroy();
    }
    setAcct(a);
    setStore(st);
    setCurrentId(null);
    setDrawer(false);
    await reload(st);
    setPhase("ready");
    void runSync(st, a);
  }
  async function openTemporary() {
    const st = temporaryStore();
    await st.setMeta("started", Date.now()); // marks this tab as "without account"
    setAcct(null);
    setStore(st);
    await reload(st);
    setPhase("ready");
  }

  // periodic sync while the tab is visible
  useEffect(() => {
    if (phase !== "ready" || store?.kind !== "account") return;
    const t = setInterval(() => document.visibilityState === "visible" && void runSync(), 60_000);
    const onVis = () => document.visibilityState === "visible" && void runSync();
    document.addEventListener("visibilitychange", onVis);
    return () => (clearInterval(t), document.removeEventListener("visibilitychange", onVis));
  }, [phase, store, runSync]);

  const current = useMemo(() => convs.find((c) => c.id === currentId) ?? null, [convs, currentId]);
  const lastLen = current?.messages[current.messages.length - 1]?.content.length ?? 0;
  const msgCount = current?.messages.length ?? 0;
  useEffect(() => endRef.current?.scrollIntoView({ block: "end" }), [msgCount, lastLen]);

  const saveConv = async (c: Conv) => {
    if (!store) return;
    const next = { ...c, dirty: store.kind === "account" };
    await store.put(next);
    setConvs((list) => [next, ...list.filter((x) => x.id !== c.id)].sort((a, b) => b.updatedAt - a.updatedAt));
  };
  const saveSettings = async (patch: Partial<Settings>) => {
    if (!store) return;
    const next = { ...settings, ...patch, updatedAt: Date.now(), dirty: store.kind === "account" };
    setSettings(next);
    await store.putSettings(next);
    if (store.kind === "account") scheduleSync();
  };

  // ---------- attachments ----------
  const addFiles = async (files: FileList | null) => {
    if (!files) return;
    for (const f of Array.from(files).slice(0, 5)) {
      try {
        if (f.type.startsWith("image/")) {
          const img = await imageToBase64(f);
          setPending((p) => [...p, { kind: "image" as const, name: f.name, ...img }].slice(0, 8));
        } else {
          if (f.size > (cfg?.maxUploadMb ?? 4) * 1024 * 1024) throw new Error(`${f.name} is larger than ${cfg?.maxUploadMb ?? 4} MB.`);
          const fd = new FormData();
          fd.append("file", f);
          toast(`Reading ${f.name}…`);
          const r = await fetch("/api/web/extract", { method: "POST", body: fd });
          const j = await r.json();
          if (!r.ok) throw new Error(j?.error?.message ?? "Couldn't read that file.");
          setPending((p) => [...p, { kind: "file" as const, name: String(j.name), text: String(j.text) }].slice(0, 8));
        }
      } catch (e) {
        toast((e as Error).message, "error");
      }
    }
  };

  // ---------- send ----------
  const send = async () => {
    const text = draft.trim();
    if ((!text && !pending.length) || busy || !store) return;
    const now = Date.now();
    const files = pending.filter((p): p is Extract<Pending, { kind: "file" }> => p.kind === "file").map(({ name, text }) => ({ name, text }));
    const images = pending.filter((p): p is Extract<Pending, { kind: "image" }> => p.kind === "image");
    const userMsg: Msg = { id: newId(), role: "user", content: text || "(see attachments)", createdAt: now, ...(files.length ? { files } : {}), ...(images.length ? { images: images.map((i) => i.name) } : {}) };
    const assistant: Msg = { id: newId(), role: "assistant", content: "", createdAt: now, activity: [], sources: [] };
    let conv: Conv = current ?? { id: newId(), title: text.slice(0, 60) || "New chat", createdAt: now, updatedAt: now, messages: [] };
    const first = conv.messages.length === 0;
    conv = { ...conv, updatedAt: now, messages: [...conv.messages, userMsg, assistant] };
    setCurrentId(conv.id);
    setDraft("");
    setPending([]);
    setDrawer(false);
    await saveConv(conv);

    // Files from earlier turns stay available to follow-up questions (newest first).
    const convFiles = conv.messages.flatMap((m) => m.files ?? []).reverse().slice(0, 5);
    const history = conv.messages.slice(0, -1).filter((m) => m.content && !m.error).map((m) => ({ role: m.role, content: m.content }));
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setBusy(true);
    const live = { ...assistant };
    const paint = () => setConvs((list) => list.map((c) => (c.id === conv.id ? { ...c, messages: [...c.messages.slice(0, -1), { ...live }] } : c)));
    let title: string | undefined;
    try {
      const r = await fetch("/api/web/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: ctrl.signal,
        body: JSON.stringify({
          messages: history.slice(-40),
          images: images.map(({ mimeType, data }) => ({ mimeType, data })).slice(0, 3),
          files: convFiles,
          mode: settings.mode,
          model: settings.model,
          webSearch,
          deepResearch: false,
          customInstructions: settings.customInstructions || null,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          wantTitle: first,
        }),
      });
      if (!r.ok || !r.body) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j?.error?.message ?? `Request failed (${r.status})`);
      }
      for await (const ev of decodeEvents(r.body)) {
        if (ev.type === "text") live.content += ev.delta;
        else if (ev.type === "activity") live.activity = [...(live.activity ?? []), ev.text];
        else if (ev.type === "sources") live.sources = ev.sources.map((s) => ({ id: s.id, title: s.title, url: s.url, snippet: s.snippet }));
        else if (ev.type === "done") title = ev.title;
        else if (ev.type === "error") live.error = ev.message;
        paint();
      }
    } catch (e) {
      if (!ctrl.signal.aborted) live.error = (e as Error).message;
    } finally {
      setBusy(false);
      abortRef.current = null;
      const finalConv: Conv = { ...conv, title: title || conv.title, updatedAt: Date.now(), messages: [...conv.messages.slice(0, -1), { ...live }] };
      await saveConv(finalConv);
      if (store.kind === "account") scheduleSync();
    }
  };

  const removeConv = async (c: Conv) => {
    await saveConv({ ...c, messages: [], title: "", deleted: true, updatedAt: Date.now() });
    setConvs((l) => l.filter((x) => x.id !== c.id));
    if (currentId === c.id) setCurrentId(null);
    if (store?.kind === "account") scheduleSync();
  };

  // ---------- account / session actions ----------
  const endTemporary = async () => {
    await store?.destroy();
    setStore(null);
    setConvs([]);
    setCurrentId(null);
    setPhase("choose");
    toast("Temporary chats erased from this device.", "success");
  };
  const doSignOut = async (removeLocal: boolean) => {
    if (acct && removeLocal) {
      await store?.destroy();
      await forgetDeviceKey(acct.userId);
    }
    await signOut({ redirect: false });
    setAcct(null);
    setStore(null);
    setConvs([]);
    setCurrentId(null);
    setPanel(null);
    setPhase("choose");
    toast(removeLocal ? "Signed out and removed from this device." : "Signed out. Your chats stay on this device for next time.", "success");
  };
  const exportData = async () => {
    if (!store) return;
    const blob = new Blob([JSON.stringify({ app: "WHITE-LOTUS", exportedAt: new Date().toISOString(), conversations: (await store.list()).filter((c) => !c.deleted), settings: await store.getSettings() }, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `white-lotus-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const importData = async (file: File | undefined) => {
    if (!file || !store) return;
    try {
      const data = JSON.parse(await file.text()) as { conversations?: Conv[] };
      let n = 0;
      for (const c of data.conversations ?? []) {
        if (!c?.id || !Array.isArray(c.messages)) continue;
        await store.put({ ...c, dirty: store.kind === "account", updatedAt: Math.max(c.updatedAt ?? 0, Date.now()) });
        n++;
      }
      await reload(store);
      if (store.kind === "account") scheduleSync();
      toast(`Imported ${n} conversation${n === 1 ? "" : "s"}.`, "success");
    } catch {
      toast("That file isn't a WHITE-LOTUS export.", "error");
    }
  };
  const deleteAccount = async () => {
    if (!acct) return;
    const pw = window.prompt("Type your password to permanently delete your account and its synced copies. Chats on this device will also be removed.");
    if (!pw) return;
    try {
      const authSecret = await loginSecret(acct.email, pw);
      const r = await fetch("/api/web/account", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ authSecret }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error?.message ?? "Couldn't delete the account.");
      await doSignOut(true);
      toast("Account deleted.", "success");
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  // ───────────────────────── screens ─────────────────────────

  if (phase === "loading") return <div className="grid min-h-dvh place-items-center bg-bg text-muted">Loading…</div>;

  if (phase === "choose" || phase === "auth" || phase === "unlock") {
    return (
      <div className="min-h-dvh bg-bg px-4 py-8 text-fg">
        <div className="mx-auto flex max-w-3xl items-center justify-between">
          <Wordmark />
          <ThemeToggle />
        </div>
        <main className="mx-auto mt-10 max-w-3xl">
          {phase === "choose" ? (
            <>
              <h1 className="text-2xl font-semibold sm:text-3xl">Your AI workspace, in the browser</h1>
              <p className="mt-2 text-muted">Works on any device. Your conversations are kept in this browser, on this device — choose how:</p>
              <div className="mt-6 grid gap-4 sm:grid-cols-2">
                <button type="button" data-testid="choose-account" onClick={() => setPhase("auth")} className="rounded-2xl border border-border bg-surface p-5 text-left hover:border-accent">
                  <UserRound className="mb-3" />
                  <div className="font-semibold">Use with account</div>
                  <ul className="mt-2 list-disc space-y-1 pl-4 text-sm text-muted">
                    <li>History is saved on this device and is still here after you close the site</li>
                    <li>Syncs to your other devices when you sign in there, end-to-end encrypted with your password</li>
                    <li>The server can&apos;t read your chats</li>
                  </ul>
                </button>
                <button type="button" data-testid="choose-temporary" onClick={() => void openTemporary()} className="rounded-2xl border border-border bg-surface p-5 text-left hover:border-accent">
                  <CloudOff className="mb-3" />
                  <div className="font-semibold">Use without account</div>
                  <ul className="mt-2 list-disc space-y-1 pl-4 text-sm text-muted">
                    <li>No sign-up. Nothing is saved to any account or server</li>
                    <li>Chats are kept only in this tab and erased when you close it</li>
                    <li>Daily limits are lower</li>
                  </ul>
                </button>
              </div>
              <p className="mt-6 text-xs text-muted">To answer, your message (and any file text you attach) is sent to the AI service and isn&apos;t stored by WHITE-LOTUS. Web search sends short search queries.</p>
            </>
          ) : (
            <AuthPanel
              signup={cfg?.signup ?? true}
              hasTemporary={temporaryActive()}
              lockedEmail={phase === "unlock" ? lockedEmail : undefined}
              onBack={() => (phase === "unlock" ? void doSignOut(false) : setPhase("choose"))}
              onDone={(a, keep) => void openAccount(a, keep)}
            />
          )}
        </main>
        <footer className="mx-auto mt-16 max-w-3xl text-center text-xs text-muted">Created by {CREATOR.name}</footer>
      </div>
    );
  }

  const temporary = store?.kind === "temporary";
  const visionOk = cfg?.models.find((m) => m.id === (settings.model ?? cfg?.defaultModel))?.vision ?? false;

  return (
    <div className="flex h-dvh bg-bg text-fg">
      {/* ---------- sidebar ---------- */}
      <aside className={cn("fixed inset-y-0 left-0 z-40 flex w-72 flex-col border-r border-border bg-bg transition-transform md:static md:translate-x-0", drawer ? "translate-x-0" : "-translate-x-full")}>
        <div className="flex items-center justify-between p-3">
          <Wordmark />
          <button type="button" className="md:hidden" aria-label="Close menu" onClick={() => setDrawer(false)}><X size={18} /></button>
        </div>
        <div className="px-3">
          <Button className="w-full" onClick={() => (setCurrentId(null), setDrawer(false))}><Plus size={16} /> New chat</Button>
        </div>
        <nav className="mt-3 flex-1 overflow-y-auto px-2" aria-label="Conversations">
          {convs.length === 0 && <p className="px-2 text-sm text-muted">No conversations yet.</p>}
          {convs.map((c) => (
            <div key={c.id} className={cn("group flex items-center rounded-lg", c.id === currentId && "bg-surface")}>
              <button type="button" className="min-w-0 flex-1 truncate px-2.5 py-2 text-left text-sm" onClick={() => (setCurrentId(c.id), setDrawer(false))}>{c.title || "Untitled"}</button>
              <button type="button" aria-label={`Delete ${c.title}`} className="p-2 text-muted opacity-60 hover:text-danger group-hover:opacity-100" onClick={() => void removeConv(c)}><Trash2 size={14} /></button>
            </div>
          ))}
        </nav>
        <div className="border-t border-border p-2 text-sm">
          {temporary ? (
            <div className="rounded-lg bg-surface p-2.5 text-xs" data-testid="temporary-banner">
              <div className="font-medium">Without account · temporary</div>
              <div className="mt-0.5 text-muted">Only in this tab. Erased when you close it.</div>
              <div className="mt-2 flex gap-2">
                <Button size="sm" variant="outline" onClick={() => void endTemporary()}>End &amp; erase now</Button>
                <Button size="sm" variant="ghost" onClick={() => setPhase("auth")}>Create account</Button>
              </div>
            </div>
          ) : (
            <button type="button" onClick={() => setPanel("account")} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 hover:bg-surface" data-testid="account-button">
              <UserRound size={16} />
              <span className="min-w-0 flex-1 truncate text-left">{acct?.email}</span>
              <span className="text-xs text-muted" data-testid="sync-state">{syncState === "syncing" ? "syncing…" : syncState === "error" ? "sync error" : syncState === "off" ? "this device only" : "synced"}</span>
            </button>
          )}
          <div className="mt-1 flex items-center gap-1">
            <button type="button" onClick={() => setPanel("settings")} className="flex flex-1 items-center gap-2 rounded-lg px-2.5 py-2 hover:bg-surface"><Settings2 size={16} /> Settings</button>
            {acct?.role === "admin" && <Link href="/admin" className="flex items-center gap-1.5 rounded-lg px-2.5 py-2 hover:bg-surface"><Shield size={16} /> Admin</Link>}
            <ThemeToggle />
          </div>
        </div>
      </aside>
      {drawer && <button type="button" aria-label="Close menu" className="fixed inset-0 z-30 bg-black/30 md:hidden" onClick={() => setDrawer(false)} />}

      {/* ---------- main ---------- */}
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2 border-b border-border px-3 py-2">
          <button type="button" className="md:hidden" aria-label="Open menu" onClick={() => setDrawer(true)}><Menu size={20} /></button>
          <div className="min-w-0 flex-1 truncate text-sm font-medium">{current?.title ?? "New chat"}</div>
          {temporary && (
            <button type="button" onClick={() => setDrawer(true)} className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted md:hidden" title="Without account — erased when you close this tab">
              Temporary
            </button>
          )}
          <select aria-label="Mode" className="h-8 rounded-lg border border-border bg-bg px-2 text-sm" value={settings.mode} onChange={(e) => void saveSettings({ mode: e.target.value })}>
            {MODES.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          </select>
          {cfg && cfg.models.length > 1 && (
            <select aria-label="Model" className="hidden h-8 max-w-[10rem] rounded-lg border border-border bg-bg px-2 text-sm sm:block" value={settings.model ?? cfg.defaultModel ?? ""} onChange={(e) => void saveSettings({ model: e.target.value })}>
              {cfg.models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          )}
        </header>

        <div className="flex-1 overflow-y-auto px-3 py-4">
          <div className="mx-auto max-w-3xl space-y-5">
            {!current && (
              <div className="pt-[12vh] text-center">
                <LotusMark className="mx-auto h-12 w-12" />
                <h1 className="mt-3 text-xl font-semibold">How can I help?</h1>
                <p className="mt-1 text-sm text-muted">{temporary ? "Temporary chat — erased when you close this tab." : "Saved on this device" + (settings.sync ? " and synced, encrypted, to your account." : " only (sync is off).")}</p>
              </div>
            )}
            {current?.messages.map((m) => (
              <div key={m.id} className={cn("flex", m.role === "user" ? "justify-end" : "justify-start")} data-testid={`msg-${m.role}`}>
                <div className={cn("max-w-[92%] text-[15px] leading-relaxed", m.role === "user" ? "rounded-2xl bg-surface px-4 py-2.5" : "w-full")}>
                  {m.role === "user" ? (
                    <>
                      <div className="whitespace-pre-wrap">{m.content}</div>
                      {(m.files?.length || m.images?.length) ? <div className="mt-1.5 text-xs text-muted">📎 {[...(m.files ?? []).map((f) => f.name), ...(m.images ?? [])].join(", ")}</div> : null}
                    </>
                  ) : (
                    <>
                      {m.activity && m.activity.length > 0 && <div className="mb-1.5 text-xs text-muted">{m.activity[m.activity.length - 1]}</div>}
                      {m.content ? <Markdown content={m.content} sources={(m.sources ?? []) as never} /> : !m.error && <div className="h-5 w-16 animate-pulse rounded bg-surface" />}
                      {m.error && <div className="rounded-lg border border-danger/40 bg-danger/5 p-3 text-sm text-danger" role="alert">{m.error}</div>}
                      {m.sources && m.sources.length > 0 && (
                        <ol className="mt-2 space-y-0.5 text-xs text-muted">
                          {m.sources.map((s) => <li key={s.id}>[{s.id}] <a className="underline" href={s.url} target="_blank" rel="noopener noreferrer nofollow">{s.title || s.url}</a></li>)}
                        </ol>
                      )}
                    </>
                  )}
                </div>
              </div>
            ))}
            <div ref={endRef} />
          </div>
        </div>

        {/* ---------- composer ---------- */}
        <div className="border-t border-border p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] sm:p-3">
          <div className="mx-auto max-w-3xl">
            {pending.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-1.5">
                {pending.map((p, i) => (
                  <span key={i} className="flex items-center gap-1 rounded-full bg-surface px-2.5 py-1 text-xs">
                    {p.kind === "image" ? "🖼" : "📄"} {p.name}
                    <button type="button" aria-label={`Remove ${p.name}`} onClick={() => setPending((l) => l.filter((_, j) => j !== i))}><X size={12} /></button>
                  </span>
                ))}
              </div>
            )}
            <div className="flex items-end gap-2 rounded-2xl border border-border bg-surface p-2">
              <label className="cursor-pointer p-1.5 text-muted hover:text-fg" aria-label="Attach files">
                <Paperclip size={18} />
                <input type="file" multiple className="hidden" accept={`${DOC_ACCEPT}${visionOk ? `,${IMG_ACCEPT}` : ""}`} onChange={(e) => (void addFiles(e.target.files), (e.target.value = ""))} />
              </label>
              {cfg?.webSearch && (
                <button type="button" aria-pressed={webSearch} aria-label="Search the web" title="Search the web" onClick={() => setWebSearch((v) => !v)} className={cn("p-1.5", webSearch ? "text-accent" : "text-muted hover:text-fg")}><Globe size={18} /></button>
              )}
              <Textarea
                aria-label="Message WHITE-LOTUS"
                rows={1}
                value={draft}
                placeholder="Message WHITE-LOTUS"
                className="max-h-48 min-h-[2.25rem] flex-1 resize-none border-0 bg-transparent p-1.5 focus-visible:ring-0"
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !("ontouchstart" in window)) {
                    e.preventDefault();
                    void send();
                  }
                }}
              />
              {busy ? (
                <Button size="icon" variant="secondary" aria-label="Stop" onClick={() => abortRef.current?.abort()}><Square size={16} /></Button>
              ) : (
                <Button size="icon" aria-label="Send" onClick={() => void send()} disabled={!draft.trim() && !pending.length}><Send size={16} /></Button>
              )}
            </div>
            <p className="mt-1.5 text-center text-[11px] text-muted">{temporary ? "Without account: kept only in this tab." : "Saved in this browser on this device."} AI answers can be wrong — check important facts.</p>
          </div>
        </div>
      </main>

      {/* ---------- panels ---------- */}
      {panel && (
        <div className="fixed inset-0 z-50 grid place-items-end bg-black/40 sm:place-items-center" role="dialog" aria-modal="true" onClick={() => setPanel(null)}>
          <div className="max-h-[90dvh] w-full overflow-y-auto rounded-t-2xl bg-bg p-5 sm:max-w-md sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-4 flex items-center justify-between">
              <h2 className="font-semibold">{panel === "settings" ? "Settings" : "Account & data"}</h2>
              <button type="button" aria-label="Close" onClick={() => setPanel(null)}><X size={18} /></button>
            </div>
            {panel === "settings" ? (
              <div className="space-y-4 text-sm">
                <label className="block">
                  <span className="mb-1 block font-medium">Custom instructions</span>
                  <Textarea rows={4} maxLength={4000} defaultValue={settings.customInstructions} onBlur={(e) => void saveSettings({ customInstructions: e.target.value })} placeholder="e.g. Answer in British English. I work in IP law in India." />
                </label>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="secondary" onClick={() => void exportData()}><Download size={14} /> Export (JSON)</Button>
                  <label className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border border-border px-3 text-sm hover:bg-surface">
                    <Upload size={14} /> Import
                    <input type="file" accept="application/json,.json" className="hidden" onChange={(e) => void importData(e.target.files?.[0])} />
                  </label>
                </div>
                <p className="text-xs text-muted">{temporary ? "Without account, settings last only for this tab." : "Settings are saved on this device and synced (encrypted) when sync is on."}</p>
              </div>
            ) : (
              <div className="space-y-4 text-sm">
                <div>
                  <div className="font-medium">{acct?.name ?? acct?.email}</div>
                  <div className="text-muted">{acct?.email}</div>
                </div>
                <label className="flex items-center justify-between gap-3 rounded-xl border border-border p-3">
                  <span>
                    <span className="block font-medium">Sync across my devices</span>
                    <span className="text-xs text-muted">End-to-end encrypted with your password. Off = chats stay on this device only.</span>
                  </span>
                  <input type="checkbox" checked={settings.sync} onChange={(e) => void saveSettings({ sync: e.target.checked }).then(() => (e.target.checked ? runSync() : setSyncState("off")))} />
                </label>
                <Button size="sm" variant="secondary" onClick={() => void runSync()} disabled={!settings.sync}><RefreshCw size={14} /> Sync now</Button>
                <div className="space-y-2 border-t border-border pt-4">
                  <Button className="w-full" variant="outline" onClick={() => void doSignOut(false)}>Sign out (keep chats on this device)</Button>
                  <Button className="w-full" variant="outline" onClick={() => void doSignOut(true)}>Sign out and remove from this device</Button>
                  <Button className="w-full" variant="ghost" onClick={() => void deleteAccount()}><span className="text-danger">Delete my account</span></Button>
                </div>
                <p className="text-xs text-muted">Use “remove from this device” on shared or public computers.</p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
