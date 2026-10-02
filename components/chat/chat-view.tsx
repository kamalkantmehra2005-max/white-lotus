"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDown, Code2, FileSearch, Globe, Lightbulb } from "lucide-react";
import Link from "next/link";
import { GlobalFooter } from "@/components/layout/global-footer";
import { useShell } from "@/components/sidebar/app-shell";
import { LotusMark } from "@/components/brand/logo";
import { useToast } from "@/components/ui/toast";
import { api, bus } from "@/lib/client/api";
import { cn } from "@/lib/client/cn";
import { decodeEvents } from "@/lib/chat/protocol";
import { Composer, type ComposerState, type ModelOpt, type ModeOpt } from "./composer";
import { MessageView, type UiAttachment, type UiMessage } from "./message";

type Config = { models: ModelOpt[]; defaultModel: string | null; modes: ModeOpt[]; features: { webSearch: boolean; codeExecution: boolean; offline?: boolean; searchHost?: string | null } };
type Initial = { id: string; title: string; mode: string; model: string | null; messages: UiMessage[] };

const STARTERS = [
  { icon: Globe, text: "What are today's most important tech news stories?", mode: "research" },
  { icon: Lightbulb, text: "Explain how transformers work, step by step", mode: "think" },
  { icon: Code2, text: "Write a TypeScript function that debounces another function", mode: "code" },
  { icon: FileSearch, text: "Summarize a document — attach a PDF to begin", mode: "analyze" },
];

const GENERIC = "WHITE-LOTUS couldn't complete that request. Please try again.";
let tmpSeq = 0;
const tmpId = (p: string) => `tmp-${p}-${++tmpSeq}`;
const browserTimezone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
};

export function ChatView({ initial, projectId, projectName }: { initial?: Initial; projectId?: string | null; projectName?: string | null }) {
  const shell = useShell();
  const isGuest = shell.user.isGuest;
  const toast = useToast();
  const [conversationId, setConversationId] = useState<string | null>(initial?.id ?? null);
  const [title, setTitle] = useState(initial?.title ?? "");
  const [messages, setMessages] = useState<UiMessage[]>(initial?.messages ?? []);
  const [busy, setBusy] = useState(false);
  const [config, setConfig] = useState<Config | null>(null);
  const [state, setState] = useState<ComposerState>({ mode: initial?.mode ?? "quick", model: initial?.model ?? null, webSearch: false, deepResearch: false });
  const [dropped, setDropped] = useState<File[] | null>(null);
  const [dragging, setDragging] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const conversationRef = useRef<string | null>(initial?.id ?? null);
  // Request that failed before the server accepted it (e.g. quota / network) — Retry re-sends it instead of regenerating.
  const unsentRef = useRef<{ body: Record<string, unknown>; userMsg?: UiMessage } | null>(null);

  useEffect(() => {
    conversationRef.current = conversationId;
  }, [conversationId]);

  useEffect(() => {
    let alive = true;
    type Prefs = { settings: { defaultModel: string | null; defaultMode: string; webSearchDefault: boolean } };
    // Guests have no saved settings (account-only), so they start from the server defaults.
    const prefs: Promise<Prefs> = isGuest ? Promise.resolve({ settings: { defaultModel: null, defaultMode: "quick", webSearchDefault: false } }) : api<Prefs>("/api/settings");
    Promise.all([api<Config>("/api/models"), prefs])
      .then(([cfg, s]) => {
        if (!alive) return;
        setConfig(cfg);
        setState((st) => ({
          ...st,
          model:
            st.model && cfg.models.some((m) => m.id === st.model)
              ? st.model
              : s.settings.defaultModel && cfg.models.some((m) => m.id === s.settings.defaultModel)
                ? s.settings.defaultModel
                : cfg.defaultModel,
          mode: initial ? st.mode : (s.settings.defaultMode ?? st.mode),
          webSearch: initial ? st.webSearch : s.settings.webSearchDefault && cfg.features.webSearch,
        }));
      })
      .catch(() => toast("Couldn't load model settings.", "error"));
    return () => {
      alive = false;
    };
  }, [initial, toast, isGuest]);

  // "New chat" — always a clean slate, even when the URL was rewritten from /chat to /chat/<id> without a remount.
  useEffect(() => {
    const reset = () => {
      abortRef.current?.abort();
      unsentRef.current = null;
      conversationRef.current = null;
      setConversationId(null);
      setMessages([]);
      setTitle("");
      if (window.location.pathname !== "/chat" && !projectId) window.history.replaceState(null, "", "/chat");
      window.dispatchEvent(new CustomEvent("chat:focus"));
    };
    window.addEventListener("chat:new", reset);
    return () => window.removeEventListener("chat:new", reset);
  }, [projectId]);

  useEffect(() => {
    window.dispatchEvent(new CustomEvent("chat:focus"));
    return () => abortRef.current?.abort();
  }, []);

  const scrollToBottom = useCallback((smooth = false) => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  }, []);
  useEffect(() => {
    if (atBottom) scrollToBottom();
  }, [messages, atBottom, scrollToBottom]);

  const stream = useCallback(
    async (body: Record<string, unknown>, optimistic: { userMsg?: UiMessage; replaceFrom?: number }) => {
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      unsentRef.current = null;
      setBusy(true);
      setAtBottom(true);
      const assistantTempId = tmpId("a");
      setMessages((prev) => {
        const base = optimistic.replaceFrom !== undefined ? prev.slice(0, optimistic.replaceFrom) : prev;
        return [...base, ...(optimistic.userMsg ? [optimistic.userMsg] : []), { id: assistantTempId, role: "assistant", content: "", metadata: {}, streaming: true, activity: [] }];
      });
      let aId = assistantTempId;
      let started = false;
      const patchAssistant = (fn: (m: UiMessage) => UiMessage) => setMessages((prev) => prev.map((m) => (m.id === aId ? fn(m) : m)));

      // Batch text deltas per animation frame: one React update per frame instead of per token.
      let pending = "";
      let raf = 0;
      const flush = () => {
        raf = 0;
        if (!pending) return;
        const chunk = pending;
        pending = "";
        patchAssistant((m) => ({ ...m, content: m.content + chunk }));
      };
      const fail = (message: string, code: string) => {
        flush();
        patchAssistant((m) => ({ ...m, streaming: false, metadata: { ...m.metadata, error: { code, message } } }));
        if (!started) unsentRef.current = { body, userMsg: optimistic.userMsg };
      };

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...body, ...state, conversationId: conversationRef.current ?? undefined, projectId: projectId ?? undefined, timezone: browserTimezone() }),
          signal: ctrl.signal,
        });
        if (!res.ok || !res.body) {
          const j = (await res.json().catch(() => ({}))) as { error?: { message?: string; code?: string } };
          fail(j.error?.message ?? GENERIC, j.error?.code ?? "error");
          return;
        }
        for await (const ev of decodeEvents(res.body)) {
          switch (ev.type) {
            case "start": {
              started = true;
              const tempUser = optimistic.userMsg?.id;
              setMessages((prev) => prev.map((m) => (m.id === assistantTempId ? { ...m, id: ev.assistantMessageId } : tempUser && m.id === tempUser ? { ...m, id: ev.userMessageId } : m)));
              aId = ev.assistantMessageId;
              if (!conversationRef.current) {
                conversationRef.current = ev.conversationId;
                setConversationId(ev.conversationId);
                setTitle(ev.title);
                window.history.replaceState(null, "", `/chat/${ev.conversationId}`);
                bus.emit("conversations:changed");
              }
              break;
            }
            case "activity":
              patchAssistant((m) => ({ ...m, activity: [...(m.activity ?? []), ev.text] }));
              break;
            case "sources":
              patchAssistant((m) => ({ ...m, metadata: { ...m.metadata, sources: ev.sources } }));
              break;
            case "text":
              pending += ev.delta;
              if (!raf) raf = requestAnimationFrame(flush);
              break;
            case "done":
              flush();
              patchAssistant((m) => ({
                ...m,
                streaming: false,
                metadata: { ...m.metadata, provenance: ev.provenance as UiMessage["metadata"]["provenance"], stopped: ev.stopped, activity: m.activity, searchQueries: ev.searchQueries },
              }));
              if (ev.title) {
                setTitle(ev.title);
                bus.emit("conversations:changed");
              }
              break;
            case "error":
              fail(ev.message, ev.code);
              break;
          }
        }
      } catch (e) {
        if ((e as Error).name === "AbortError") {
          flush();
          patchAssistant((m) => ({ ...m, streaming: false, metadata: { ...m.metadata, stopped: true } }));
        } else fail("Connection lost. Please try again.", "network");
      } finally {
        if (raf) cancelAnimationFrame(raf);
        flush();
        patchAssistant((m) => ({ ...m, streaming: false }));
        setBusy(false);
        abortRef.current = null;
        bus.emit("conversations:changed");
      }
    },
    [projectId, state],
  );

  const send = (text: string, attachments: UiAttachment[]) => {
    const userMsg: UiMessage = { id: tmpId("u"), role: "user", content: text, metadata: {}, attachments };
    void stream({ content: text, attachmentIds: attachments.map((a) => a.id) }, { userMsg });
  };
  const regenerate = () => {
    const unsent = unsentRef.current;
    if (unsent) {
      // Nothing reached the server: remove the failed pair and send the original request again.
      const cut = messages.findIndex((m) => m.id === unsent.userMsg?.id);
      void stream(unsent.body, { userMsg: unsent.userMsg, replaceFrom: cut >= 0 ? cut : Math.max(0, messages.length - 1) });
      return;
    }
    const lastAssistant = messages.map((m) => m.role).lastIndexOf("assistant");
    void stream({ regenerate: true, content: "" }, { replaceFrom: lastAssistant >= 0 ? lastAssistant : messages.length });
  };
  const edit = (index: number, content: string) => {
    const m = messages[index];
    if (m.id.startsWith("tmp-")) return send(content, m.attachments ?? []);
    void stream({ editMessageId: m.id, content }, { replaceFrom: index, userMsg: { ...m, content } });
  };

  const empty = messages.length === 0;

  return (
    <div
      className="relative flex h-full flex-col"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        if (e.dataTransfer.files.length) setDropped([...e.dataTransfer.files]);
      }}
    >
      <header className="flex h-12 shrink-0 items-center justify-center border-b border-transparent px-12 text-sm">
        <span className="truncate text-muted">
          {projectName && <span className="text-fg">{projectName}</span>}
          {projectName && title && " / "}
          {title}
        </span>
      </header>

      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto"
        onScroll={(e) => {
          const el = e.currentTarget;
          setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
        }}
      >
        {empty ? (
          <div className="mx-auto flex h-full max-w-2xl flex-col items-center justify-center px-4 pb-16 text-center">
            <LotusMark className="h-10 w-10" />
            <h1 className="mt-4 text-2xl font-semibold tracking-tight">{projectName ? `New chat in ${projectName}` : "How can I help today?"}</h1>
            <div className="mt-8 grid w-full gap-2 sm:grid-cols-2">
              {STARTERS.map((s) => (
                <button
                  key={s.text}
                  onClick={() => (s.mode === "analyze" ? setState({ ...state, mode: "analyze" }) : (setState({ ...state, mode: s.mode }), send(s.text, [])))}
                  disabled={busy || !config?.models.length}
                  className="flex items-start gap-3 rounded-2xl border border-border p-3.5 text-left text-sm transition-colors hover:bg-surface disabled:opacity-50"
                >
                  <s.icon size={16} className="mt-0.5 shrink-0 text-accent" />
                  <span>{s.text}</span>
                </button>
              ))}
            </div>
            {config && config.models.length === 0 && (
              <p className="mt-6 rounded-xl border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">
                No usable AI model is set up yet (or its name is invalid). Close WHITE-LOTUS, run “npm run local -- setup” (or edit DEFAULT_MODEL in settings.env), then start it again.
              </p>
            )}
          </div>
        ) : (
          <div className="mx-auto max-w-3xl space-y-7 px-4 py-6">
            {messages.map((m, i) => (
              <MessageView
                key={m.id}
                m={m}
                isLast={i === messages.length - 1}
                canRegenerate={!busy && m.role === "assistant" && i === messages.length - 1}
                onRegenerate={regenerate}
                onEdit={(c) => edit(i, c)}
              />
            ))}
            <div className="h-4" />
          </div>
        )}
      </div>

      {!atBottom && !empty && (
        <button
          onClick={() => (setAtBottom(true), scrollToBottom(true))}
          aria-label="Scroll to bottom"
          className="absolute bottom-32 left-1/2 z-10 -translate-x-1/2 rounded-full border border-border bg-elevated p-2 shadow-md hover:bg-surface"
        >
          <ArrowDown size={16} />
        </button>
      )}

      <div className="shrink-0 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-4">
        <div className="mx-auto max-w-3xl">
          <Composer
            state={state}
            setState={setState}
            models={config?.models ?? []}
            modes={config?.modes ?? [{ id: "quick", label: "Quick", description: "" }]}
            features={{ webSearch: config?.features.webSearch ?? false }}
            busy={busy}
            onSend={send}
            onStop={() => abortRef.current?.abort()}
            droppedFiles={dropped}
            projectId={projectId}
            guest={shell.user.isGuest}
          />
          {config && <DataFlowNote model={config.models.find((m) => m.id === state.model) ?? null} search={state.webSearch || state.deepResearch ? (config.features.searchHost ?? null) : null} />}
          {shell.user.isGuest && <GuestNote hours={shell.guestRetentionHours} />}
          <GlobalFooter compact className="mt-2" />
        </div>
      </div>

      {dragging && (
        <div className={cn("pointer-events-none absolute inset-2 z-30 flex items-center justify-center rounded-3xl border-2 border-dashed border-accent bg-accent/5 text-sm font-medium text-accent")}>
          Drop files to attach
        </div>
      )}
    </div>
  );
}

function GuestNote({ hours }: { hours: number }) {
  return (
    <p className="mt-2 text-center text-xs text-muted" data-testid="guest-note">
      Guest chat · deleted after {hours} h.{" "}
      <Link href="/register?from=guest" className="text-fg underline underline-offset-2">Create a free account</Link> to keep it and use it on other devices.
    </p>
  );
}

/** Plain statement of where this message goes. History and files are always stored on this computer. */
function DataFlowNote({ model, search }: { model: ModelOpt | null; search: string | null }) {
  if (!model) return null;
  const searchPart = search ? ` · search queries go to ${search}` : "";
  return (
    <p className="mt-2 text-center text-xs text-muted" data-testid="data-flow-note">
      {model.local ? (
        <>🔒 Answered on this computer ({model.label}){searchPart}. Your history stays here.</>
      ) : (
        <>
          To answer, your message and recent chat are sent to <span className="text-fg">{model.host ?? model.provider}</span>
          {searchPart}. Your history and files stay on this computer.{" "}
          <Link href="/settings?tab=storage" className="underline underline-offset-2">Details</Link>
        </>
      )}
    </p>
  );
}
