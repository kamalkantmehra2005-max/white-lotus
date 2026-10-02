"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { signOut } from "next-auth/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Archive, ArchiveRestore, FileText, FolderKanban, Lock, LogOut, MoreHorizontal, PanelLeftClose, Pencil, Pin, PinOff, Search, Settings, Shield, SquarePen, Trash2, Brain } from "lucide-react";
import { Wordmark } from "@/components/brand/logo";
import { Button, IconButton, Input, Modal } from "@/components/ui/primitives";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { useToast } from "@/components/ui/toast";
import { api, bus } from "@/lib/client/api";
import { cn } from "@/lib/client/cn";
import type { ShellUser } from "./app-shell";

type Conv = { id: string; title: string; pinned: boolean; archived: boolean; updatedAt: string; projectId: string | null };

function isActive(href: string, pathname: string, tab: string | null) {
  const [path, query] = href.split("?");
  if (!pathname.startsWith(path)) return false;
  const want = new URLSearchParams(query ?? "").get("tab");
  return want ? tab === want : true;
}

function group(convs: Conv[]) {
  const now = Date.now();
  const day = 86_400_000;
  const startToday = new Date().setHours(0, 0, 0, 0);
  const g: Record<string, Conv[]> = { Pinned: [], Today: [], Yesterday: [], "Previous 7 days": [], "Previous 30 days": [], Older: [] };
  for (const c of convs) {
    const t = new Date(c.updatedAt).getTime();
    if (c.pinned) g.Pinned.push(c);
    else if (t >= startToday) g.Today.push(c);
    else if (t >= startToday - day) g.Yesterday.push(c);
    else if (now - t < 7 * day) g["Previous 7 days"].push(c);
    else if (now - t < 30 * day) g["Previous 30 days"].push(c);
    else g.Older.push(c);
  }
  return Object.entries(g).filter(([, v]) => v.length);
}

export function Sidebar({ user, onNavigate, onCollapse }: { user: ShellUser; onNavigate: () => void; onCollapse: () => void }) {
  const pathname = usePathname();
  const tabParam = useSearchParams().get("tab");
  const router = useRouter();
  const toast = useToast();
  const [convs, setConvs] = useState<Conv[]>([]);
  const [q, setQ] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [loading, setLoading] = useState(true);
  const [renaming, setRenaming] = useState<Conv | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Conv | null>(null);
  const [confirmEndGuest, setConfirmEndGuest] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (q.trim()) params.set("q", q.trim());
    if (showArchived) params.set("archived", "true");
    try {
      const r = await api<{ conversations: Conv[] }>(`/api/conversations?${params}`);
      setConvs(r.conversations);
    } catch {
      /* sidebar stays usable */
    } finally {
      setLoading(false);
    }
  }, [q, showArchived]);

  useEffect(() => {
    const t = setTimeout(load, q ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, q]);
  useEffect(() => bus.on("conversations:changed", load), [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const groups = useMemo(() => group(convs), [convs]);
  const activeId = pathname.startsWith("/chat/") ? pathname.split("/")[2] : null;

  async function patch(c: Conv, body: Partial<Conv>) {
    try {
      await api(`/api/conversations/${c.id}`, { method: "PATCH", json: body });
      await load();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  }
  async function remove(c: Conv) {
    try {
      await api(`/api/conversations/${c.id}`, { method: "DELETE" });
      setConfirmDelete(null);
      if (activeId === c.id) router.push("/chat");
      await load();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  }

  const nav = [
    { href: "/projects", label: "Projects", icon: FolderKanban },
    { href: "/files", label: "Files", icon: FileText },
    { href: "/settings?tab=memory", label: "Memory", icon: Brain },
  ];

  return (
    <div className="flex h-full min-w-[272px] flex-col">
      <div className="flex h-14 items-center justify-between px-3">
        <Link href="/chat" onClick={onNavigate} className="rounded-lg px-1.5 py-1">
          <Wordmark className="text-[0.82rem]" />
        </Link>
        <IconButton label="Close sidebar" onClick={onCollapse}>
          <PanelLeftClose size={18} />
        </IconButton>
      </div>

      <div className="space-y-1 px-2">
        <Link
          href="/chat"
          onClick={() => {
            onNavigate();
            // The URL may read /chat/<id> after a first message without a remount — always reset the view.
            window.dispatchEvent(new CustomEvent("chat:new"));
          }}
          className="flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-sm font-medium hover:bg-elevated"
        >
          <SquarePen size={16} /> New chat
        </Link>
        <div className="relative">
          <Search size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
          <Input ref={searchRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search chats  ⌘K" aria-label="Search conversations" className="h-9 border-transparent bg-transparent pl-8 hover:bg-elevated focus:bg-bg" />
        </div>
        {nav.map((n) => (
          <Link
            key={n.href}
            href={n.href}
            onClick={onNavigate}
            className={cn("flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-sm hover:bg-elevated", isActive(n.href, pathname, tabParam) && "bg-elevated font-medium")}
          >
            <n.icon size={16} /> {n.label}
            {user.isGuest && <Lock size={13} className="ml-auto text-muted" aria-label="Needs an account" />}
          </Link>
        ))}
      </div>

      <div className="mt-3 flex items-center justify-between px-4 pb-1">
        <span className="text-xs font-medium text-muted">{showArchived ? "Archived" : "History"}</span>
        <button className="text-xs text-muted hover:text-fg" onClick={() => setShowArchived((v) => !v)}>
          {showArchived ? "Show active" : "Archived"}
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto px-2 pb-2" aria-label="Conversations">
        {loading && <div className="space-y-2 px-2 py-2">{[0, 1, 2, 3].map((i) => <div key={i} className="h-6 animate-pulse rounded bg-border/60" />)}</div>}
        {!loading && convs.length === 0 && <p className="px-3 py-4 text-sm text-muted">{q ? "No matching chats." : showArchived ? "No archived chats." : "Your conversations will appear here."}</p>}
        {groups.map(([label, items]) => (
          <div key={label} className="mb-3">
            <div className="px-2.5 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-muted/80">{label}</div>
            {items.map((c) => (
              <ConvItem
                key={c.id}
                c={c}
                active={c.id === activeId}
                onNavigate={onNavigate}
                onRename={() => setRenaming(c)}
                onPin={() => patch(c, { pinned: !c.pinned })}
                onArchive={() => patch(c, { archived: !c.archived })}
                onDelete={() => setConfirmDelete(c)}
              />
            ))}
          </div>
        ))}
      </nav>

      <div className="border-t border-border p-2">
        {user.role === "admin" && (
          <Link href="/admin" onClick={onNavigate} className="flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-sm hover:bg-elevated">
            <Shield size={16} /> Admin / Creator
          </Link>
        )}
        {user.isGuest ? (
          <GuestFooter expiresAt={user.guestExpiresAt} onNavigate={onNavigate} onEnd={() => setConfirmEndGuest(true)} />
        ) : (
        <div className="flex items-center gap-2 rounded-lg px-2 py-1.5">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent/15 text-sm font-semibold text-accent">{(user.name ?? user.email).slice(0, 1).toUpperCase()}</div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{user.name ?? "You"}</div>
            <div className="truncate text-xs text-muted">{user.email}</div>
          </div>
          <ThemeToggle />
          <Link href="/settings" onClick={onNavigate} aria-label="Settings" title="Settings" className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-elevated hover:text-fg">
            <Settings size={16} />
          </Link>
          <IconButton label="Sign out" onClick={() => signOut({ callbackUrl: "/" })}>
            <LogOut size={16} />
          </IconButton>
        </div>
        )}
      </div>
      <Modal open={confirmEndGuest} onClose={() => setConfirmEndGuest(false)} title="End guest session?">
        <p className="text-sm text-muted">This deletes every chat from this guest session right away. To keep them, create a free account instead.</p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setConfirmEndGuest(false)}>Cancel</Button>
          <Button variant="danger" onClick={() => signOut({ callbackUrl: "/" })}>End and delete</Button>
        </div>
      </Modal>

      <RenameModal key={renaming?.id ?? "none"} conv={renaming} onClose={() => setRenaming(null)} onSave={(title) => renaming && patch(renaming, { title }).then(() => setRenaming(null))} />
      <Modal
        open={Boolean(confirmDelete)}
        onClose={() => setConfirmDelete(null)}
        title="Delete conversation?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(null)}>Cancel</Button>
            <Button variant="danger" onClick={() => confirmDelete && remove(confirmDelete)}>Delete</Button>
          </>
        }
      >
        <p className="text-sm text-muted">“{confirmDelete?.title}” and all its messages will be permanently deleted.</p>
      </Modal>
    </div>
  );
}

function ConvItem({ c, active, onNavigate, onRename, onPin, onArchive, onDelete }: { c: Conv; active: boolean; onNavigate: () => void; onRename: () => void; onPin: () => void; onArchive: () => void; onDelete: () => void }) {
  const [menu, setMenu] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setMenu(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menu]);
  const item = "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-surface";
  return (
    <div ref={ref} className={cn("group relative flex items-center rounded-lg", active ? "bg-elevated" : "hover:bg-elevated/70")}>
      <Link href={`/chat/${c.id}`} onClick={onNavigate} className="min-w-0 flex-1 truncate px-2.5 py-2 text-sm" title={c.title}>
        {c.title}
      </Link>
      <button
        aria-label="Conversation options"
        onClick={() => setMenu((m) => !m)}
        className={cn("mr-1 rounded-md p-1 text-muted hover:text-fg", menu || active ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus:opacity-100")}
      >
        <MoreHorizontal size={16} />
      </button>
      {menu && (
        <div className="absolute right-0 top-9 z-50 w-44 animate-fade-in rounded-xl border border-border bg-elevated p-1 shadow-xl" role="menu">
          <button className={item} onClick={() => (setMenu(false), onRename())}><Pencil size={14} /> Rename</button>
          <button className={item} onClick={() => (setMenu(false), onPin())}>{c.pinned ? <PinOff size={14} /> : <Pin size={14} />} {c.pinned ? "Unpin" : "Pin"}</button>
          <button className={item} onClick={() => (setMenu(false), onArchive())}>{c.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />} {c.archived ? "Unarchive" : "Archive"}</button>
          <button className={cn(item, "text-danger")} onClick={() => (setMenu(false), onDelete())}><Trash2 size={14} /> Delete</button>
        </div>
      )}
    </div>
  );
}

function RenameModal({ conv, onClose, onSave }: { conv: Conv | null; onClose: () => void; onSave: (t: string) => void }) {
  const [title, setTitle] = useState(conv?.title ?? "");
  return (
    <Modal
      open={Boolean(conv)}
      onClose={onClose}
      title="Rename conversation"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => title.trim() && onSave(title.trim())}>Save</Button>
        </>
      }
    >
      <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} onKeyDown={(e) => e.key === "Enter" && title.trim() && onSave(title.trim())} />
    </Modal>
  );
}

function hoursLeft(iso: string | null) {
  if (!iso) return null;
  const h = Math.max(0, (new Date(iso).getTime() - Date.now()) / 3_600_000);
  return h >= 1 ? `${Math.floor(h)} h` : `${Math.max(1, Math.round(h * 60))} min`;
}

function GuestFooter({ expiresAt, onNavigate, onEnd }: { expiresAt: string | null; onNavigate: () => void; onEnd: () => void }) {
  const [left] = useState(() => hoursLeft(expiresAt));
  return (
    <div className="space-y-2 px-1 py-1">
      <div className="flex items-center gap-2 px-1">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-border/70 text-sm font-semibold text-muted">G</div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">Guest session</div>
          <div className="truncate text-xs text-muted">{left ? `Chats deleted in ${left}` : "Temporary"}</div>
        </div>
        <ThemeToggle />
        <IconButton label="End guest session" onClick={onEnd}>
          <LogOut size={16} />
        </IconButton>
      </div>
      <Link href="/register?from=guest" onClick={onNavigate} className="flex h-9 items-center justify-center rounded-lg bg-fg text-sm font-medium text-bg hover:opacity-90">
        Create free account
      </Link>
      <Link href="/login?from=guest" onClick={onNavigate} className="flex h-8 items-center justify-center rounded-lg text-sm text-muted hover:bg-elevated hover:text-fg">
        Sign in
      </Link>
    </div>
  );
}
