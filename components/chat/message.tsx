"use client";

import { useState } from "react";
import { AlertCircle, Check, ChevronDown, Copy, FileDown, FileText, Globe, Pencil, RefreshCw } from "lucide-react";
import { useShell } from "@/components/sidebar/app-shell";
import { useToast } from "@/components/ui/toast";
import { api } from "@/lib/client/api";
import { LotusMark } from "@/components/brand/logo";
import { Button, Dots, IconButton, Textarea } from "@/components/ui/primitives";
import type { MessageMetadata, MessageSource } from "@/lib/database/schema";
import { cn } from "@/lib/client/cn";
import { Markdown } from "./markdown";

export type UiAttachment = { id: string; fileName: string; mimeType: string; kind: string; sizeBytes?: number };
export type UiMessage = {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  metadata: MessageMetadata;
  attachments?: UiAttachment[];
  streaming?: boolean;
  activity?: string[];
};

const PROVENANCE_LABEL: Record<string, string> = { web: "Web", user_file: "Your files", tool: "Tools", memory: "Memory", model: "Model knowledge" };

export function MessageView({
  m,
  isLast,
  canRegenerate,
  onRegenerate,
  onEdit,
}: {
  m: UiMessage;
  isLast: boolean;
  canRegenerate: boolean;
  onRegenerate: () => void;
  onEdit: (content: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(m.content);
  const sources = m.metadata.sources ?? [];

  if (m.role === "user") {
    return (
      <div className="group flex animate-fade-in flex-col items-end gap-1.5">
        {m.attachments && m.attachments.length > 0 && (
          <div className="flex max-w-[85%] flex-wrap justify-end gap-2">
            {m.attachments.map((a) => (
              <AttachmentChip key={a.id} a={a} />
            ))}
          </div>
        )}
        {editing ? (
          <div className="w-full max-w-[85%] rounded-2xl border border-border bg-surface p-2">
            <Textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={Math.min(10, draft.split("\n").length + 1)} className="border-0 bg-transparent focus:border-0" autoFocus />
            <div className="flex justify-end gap-2 pt-1">
              <Button size="sm" variant="ghost" onClick={() => (setEditing(false), setDraft(m.content))}>Cancel</Button>
              <Button size="sm" onClick={() => (setEditing(false), draft.trim() && onEdit(draft.trim()))}>Send</Button>
            </div>
          </div>
        ) : (
          m.content && <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-surface px-4 py-2.5 text-[0.95rem] leading-relaxed">{m.content}</div>
        )}
        {!editing && (
          <div className="flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
            <IconButton label="Copy message" onClick={() => copy(m.content, setCopied)}>{copied ? <Check size={14} /> : <Copy size={14} />}</IconButton>
            <IconButton label="Edit message" onClick={() => setEditing(true)}><Pencil size={14} /></IconButton>
          </div>
        )}
      </div>
    );
  }

  const error = m.metadata.error;
  const activity = m.activity ?? m.metadata.activity ?? [];
  const provenance = (m.metadata.provenance ?? []).filter((p) => p !== "model");
  return (
    <div className="group flex animate-fade-in gap-3">
      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border bg-elevated">
        <LotusMark className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        {activity.length > 0 && <Activity items={activity} live={Boolean(m.streaming && !m.content)} />}
        {m.content ? (
          <div className={cn(m.streaming && "wl-caret")}>
            <Markdown content={m.content} sources={sources} />
          </div>
        ) : m.streaming ? (
          <div className="py-2"><Dots /></div>
        ) : error ? null : m.metadata.stopped ? (
          <p className="text-sm italic text-muted">Generation stopped.</p>
        ) : null}

        {error && (
          <div className="mt-2 flex items-start gap-2 rounded-xl border border-danger/25 bg-danger/5 px-3 py-2.5 text-sm">
            <AlertCircle size={16} className="mt-0.5 shrink-0 text-danger" />
            <div className="flex-1">{error.message}</div>
            {canRegenerate && (
              <Button size="sm" variant="outline" onClick={onRegenerate}>
                <RefreshCw size={13} /> Retry
              </Button>
            )}
          </div>
        )}

        {sources.length > 0 && <Sources sources={sources} queries={m.metadata.searchQueries} />}

        {!m.streaming && (m.content || error) && (
          <div className={cn("mt-1 flex items-center gap-0.5", isLast ? "opacity-100" : "opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100")}>
            {m.content && <IconButton label="Copy response" onClick={() => copy(m.content, setCopied)}>{copied ? <Check size={14} /> : <Copy size={14} />}</IconButton>}
            {canRegenerate && <IconButton label="Regenerate response" onClick={onRegenerate}><RefreshCw size={14} /></IconButton>}
            {m.content && <SaveAsFile id={m.id} />}
            {provenance.length > 0 && (
              <span className="ml-2 text-xs text-muted" title="Where this answer's information came from">
                Based on: {provenance.map((p) => PROVENANCE_LABEL[p] ?? p).join(" · ")}
              </span>
            )}
            {m.metadata.stopped && <span className="ml-2 text-xs text-muted">Stopped</span>}
          </div>
        )}
      </div>
    </div>
  );
}

function copy(text: string, set: (v: boolean) => void) {
  void navigator.clipboard.writeText(text);
  set(true);
  setTimeout(() => set(false), 1500);
}

function Activity({ items, live }: { items: string[]; live: boolean }) {
  const [open, setOpen] = useState(false);
  const last = items[items.length - 1];
  return (
    <div className="mb-2 text-sm text-muted">
      <button className="inline-flex items-center gap-1.5 hover:text-fg" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {live ? <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" /> : <Check size={13} />}
        <span className={cn(live && "animate-pulse")}>{live ? last : `${items.length} step${items.length > 1 ? "s" : ""} · ${last}`}</span>
        <ChevronDown size={13} className={cn("transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <ol className="mt-1.5 space-y-1 border-l border-border pl-3 text-xs">
          {items.map((a, i) => <li key={i}>{a}</li>)}
        </ol>
      )}
    </div>
  );
}

function Sources({ sources, queries }: { sources: MessageSource[]; queries?: string[] }) {
  const [open, setOpen] = useState(false);
  const shown = open ? sources : sources.slice(0, 4);
  return (
    <div className="mt-3">
      <div className="mb-1.5 flex flex-wrap items-center gap-x-1.5 text-xs text-muted">
        <span className="inline-flex items-center gap-1.5 font-medium"><Globe size={13} /> Sources</span>
        {queries && queries.length > 0 && <span className="truncate" title={queries.join(" · ")}>· searched {queries.map((q) => `“${q}”`).join(", ")}</span>}
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {shown.map((s) => {
          let host = s.url;
          try {
            host = new URL(s.url).hostname.replace(/^www\./, "");
          } catch {
            /* keep raw */
          }
          return (
            <a key={s.id} id={`source-${s.id}`} href={s.url} target="_blank" rel="noopener noreferrer nofollow" className="flex min-w-0 gap-2 rounded-xl border border-border px-3 py-2 text-sm hover:border-accent/40 hover:bg-surface">
              <span className="mt-0.5 flex h-5 min-w-5 items-center justify-center rounded-md bg-accent/15 px-1 text-[0.7rem] font-semibold text-accent">{s.id}</span>
              <span className="min-w-0">
                <span className="block truncate font-medium">{s.title || host}</span>
                <span className="block truncate text-xs text-muted">{host}{s.publishedAt ? ` · ${s.publishedAt.slice(0, 10)}` : ""}</span>
              </span>
            </a>
          );
        })}
      </div>
      {sources.length > 4 && (
        <button className="mt-1.5 text-xs text-muted hover:text-fg" onClick={() => setOpen((o) => !o)}>
          {open ? "Show fewer" : `Show all ${sources.length} sources`}
        </button>
      )}
    </div>
  );
}

export function AttachmentChip({ a, onRemove, status }: { a: UiAttachment; onRemove?: () => void; status?: "uploading" | "ready" | "error" }) {
  const isImage = a.kind === "image" && status !== "uploading";
  return (
    <div className="relative flex items-center gap-2 overflow-hidden rounded-xl border border-border bg-elevated pr-3 text-sm">
      {isImage ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={`/api/files/${a.id}`} alt={a.fileName} className="h-12 w-12 object-cover" loading="lazy" />
      ) : (
        <div className="flex h-12 w-10 items-center justify-center bg-surface text-muted">
          <FileText size={18} />
        </div>
      )}
      <div className="min-w-0 max-w-[160px]">
        <div className="truncate font-medium">{a.fileName}</div>
        <div className="text-xs text-muted">{status === "uploading" ? "Uploading…" : status === "error" ? "Failed" : a.fileName.split(".").pop()?.toUpperCase()}</div>
      </div>
      {onRemove && (
        <button onClick={onRemove} aria-label={`Remove ${a.fileName}`} className="absolute right-1 top-1 rounded-full bg-bg/80 px-1 text-xs text-muted hover:text-fg">
          ×
        </button>
      )}
    </div>
  );
}

/** Save an AI answer as a Markdown file in your local Files (encrypted on this computer). */
function SaveAsFile({ id }: { id: string }) {
  const shell = useShell();
  const toast = useToast();
  const [saved, setSaved] = useState(false);
  if (shell.user.isGuest || !/^[0-9a-f-]{36}$/i.test(id)) return null;
  return (
    <IconButton
      label={saved ? "Saved to Files" : "Save as file"}
      onClick={async () => {
        try {
          const r = await api<{ file: { fileName: string } }>(`/api/messages/${id}/save`, { method: "POST" });
          setSaved(true);
          toast(`Saved “${r.file.fileName}” to Files on this computer.`, "success");
        } catch (e) {
          toast((e as Error).message, "error");
        }
      }}
    >
      {saved ? <Check size={14} /> : <FileDown size={14} />}
    </IconButton>
  );
}
