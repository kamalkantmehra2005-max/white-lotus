"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowUp, Check, ChevronDown, Globe, Mic, MicOff, Paperclip, Square, Telescope } from "lucide-react";
import { IconButton } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { ACCEPT_ATTR } from "@/lib/files/validate";
import { api } from "@/lib/client/api";
import { cn } from "@/lib/client/cn";
import { AttachmentChip, type UiAttachment } from "./message";

export type ModelOpt = { id: string; label: string; provider: string; capabilities: { vision: boolean; tools: boolean; reasoning: boolean }; local?: boolean; host?: string | null };
export type ModeOpt = { id: string; label: string; description: string };
export type ComposerState = { mode: string; model: string | null; webSearch: boolean; deepResearch: boolean };

type Pending = UiAttachment & { status: "uploading" | "ready" | "error"; localId: string };

const SLASH = [
  { cmd: "/quick", desc: "Quick mode — fast answers", mode: "quick" },
  { cmd: "/think", desc: "Think mode — deeper reasoning", mode: "think" },
  { cmd: "/research", desc: "Research mode — web + citations", mode: "research" },
  { cmd: "/code", desc: "Code mode", mode: "code" },
  { cmd: "/creative", desc: "Creative mode", mode: "creative" },
  { cmd: "/analyze", desc: "Analyze files, data and images", mode: "analyze" },
  { cmd: "/web", desc: "Toggle web search for this message", toggle: "web" as const },
  { cmd: "/deep", desc: "Toggle deep research", toggle: "deep" as const },
];

type SpeechRec = { start: () => void; stop: () => void; onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null; onend: (() => void) | null; continuous: boolean; interimResults: boolean };

export function Composer({
  state,
  setState,
  models,
  modes,
  features,
  busy,
  onSend,
  onStop,
  droppedFiles,
  projectId,
  guest = false,
}: {
  state: ComposerState;
  setState: (s: ComposerState) => void;
  models: ModelOpt[];
  modes: ModeOpt[];
  features: { webSearch: boolean };
  busy: boolean;
  onSend: (text: string, attachments: UiAttachment[]) => void;
  onStop: () => void;
  droppedFiles: File[] | null;
  projectId?: string | null;
  /** Guest session: files need an account (confidential documents are never accepted anonymously). */
  guest?: boolean;
}) {
  const toast = useToast();
  const [text, setText] = useState("");
  const [files, setFiles] = useState<Pending[]>([]);
  const [slashIdx, setSlashIdx] = useState(0);
  const [listening, setListening] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const recRef = useRef<SpeechRec | null>(null);

  const slashOpen = text.startsWith("/") && !text.includes(" ") && text.length < 12;
  const slashMatches = slashOpen ? SLASH.filter((s) => s.cmd.startsWith(text.toLowerCase())) : [];

  // Auto-grow the textarea. Re-measure when its width changes (mobile layout settles after first paint).
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    const fit = () => {
      ta.style.height = "0px";
      ta.style.height = `${Math.min(ta.scrollHeight, 240)}px`;
    };
    fit();
    let lastWidth = ta.clientWidth;
    const ro = new ResizeObserver(() => {
      if (ta.clientWidth !== lastWidth) {
        lastWidth = ta.clientWidth;
        fit();
      }
    });
    ro.observe(ta);
    return () => ro.disconnect();
  }, [text]);

  useEffect(() => {
    if (droppedFiles?.length) void upload(droppedFiles);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [droppedFiles]);

  useEffect(() => {
    const focus = () => taRef.current?.focus();
    window.addEventListener("chat:focus", focus);
    return () => window.removeEventListener("chat:focus", focus);
  }, []);

  async function upload(list: File[]) {
    if (guest) {
      toast("File uploads need a free account — documents are only accepted from signed-in users.", "error");
      return;
    }
    const items = list.slice(0, 10 - files.length);
    for (const f of items) {
      const localId = crypto.randomUUID();
      const kind = f.type.startsWith("image/") ? "image" : "document";
      setFiles((p) => [...p, { id: localId, localId, fileName: f.name || "pasted-image.png", mimeType: f.type, kind, status: "uploading" }]);
      const fd = new FormData();
      fd.append("file", f, f.name || "pasted-image.png");
      if (projectId) fd.append("projectId", projectId);
      try {
        const r = await api<{ file: UiAttachment }>("/api/files", { method: "POST", body: fd });
        setFiles((p) => p.map((x) => (x.localId === localId ? { ...r.file, localId, status: "ready" } : x)));
      } catch (e) {
        toast((e as Error).message, "error");
        setFiles((p) => p.filter((x) => x.localId !== localId));
      }
    }
  }

  function applySlash(s: (typeof SLASH)[number]) {
    if (s.mode) setState({ ...state, mode: s.mode });
    if (s.toggle === "web") setState({ ...state, webSearch: !state.webSearch });
    if (s.toggle === "deep") setState({ ...state, deepResearch: !state.deepResearch });
    setText("");
  }

  const uploading = files.some((f) => f.status === "uploading");
  const canSend = !busy && !uploading && (text.trim().length > 0 || files.some((f) => f.status === "ready"));

  function submit() {
    if (!canSend) return;
    onSend(
      text.trim(),
      files.filter((f) => f.status === "ready").map(({ id, fileName, mimeType, kind }) => ({ id, fileName, mimeType, kind })),
    );
    setText("");
    setFiles([]);
  }

  function toggleMic() {
    const W = window as unknown as { SpeechRecognition?: new () => SpeechRec; webkitSpeechRecognition?: new () => SpeechRec };
    const Ctor = W.SpeechRecognition ?? W.webkitSpeechRecognition;
    if (!Ctor) return toast("Voice input isn't supported in this browser.", "error");
    if (listening) {
      recRef.current?.stop();
      return;
    }
    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = false;
    const base = text;
    rec.onresult = (e) => {
      let t = "";
      for (let i = 0; i < e.results.length; i++) t += e.results[i][0].transcript;
      setText((base ? base + " " : "") + t);
    };
    rec.onend = () => setListening(false);
    recRef.current = rec;
    rec.start();
    setListening(true);
  }

  const model = models.find((m) => m.id === state.model) ?? models[0];

  return (
    <div className="relative">
      {slashMatches.length > 0 && (
        <div className="absolute bottom-full left-0 mb-2 w-72 rounded-xl border border-border bg-elevated p-1 shadow-xl" role="listbox">
          {slashMatches.map((s, i) => (
            <button key={s.cmd} role="option" aria-selected={i === slashIdx} onMouseDown={(e) => (e.preventDefault(), applySlash(s))} className={cn("flex w-full items-center justify-between rounded-lg px-3 py-1.5 text-left text-sm", i === slashIdx && "bg-surface")}>
              <span className="font-mono">{s.cmd}</span>
              <span className="truncate pl-3 text-xs text-muted">{s.desc}</span>
            </button>
          ))}
        </div>
      )}

      <div className="rounded-3xl border border-border bg-elevated shadow-[0_2px_20px_-8px_rgba(0,0,0,0.15)] transition-colors focus-within:border-accent/50">
        {files.length > 0 && (
          <div className="flex flex-wrap gap-2 px-3 pt-3">
            {files.map((f) => (
              <AttachmentChip key={f.localId} a={f} status={f.status} onRemove={() => setFiles((p) => p.filter((x) => x.localId !== f.localId))} />
            ))}
          </div>
        )}
        <textarea
          ref={taRef}
          value={text}
          onChange={(e) => (setText(e.target.value), setSlashIdx(0))}
          onPaste={(e) => {
            const imgs = [...e.clipboardData.files].filter((f) => f.type.startsWith("image/"));
            if (imgs.length) {
              e.preventDefault();
              void upload(imgs);
            }
          }}
          onKeyDown={(e) => {
            if (slashMatches.length) {
              if (e.key === "ArrowDown") return e.preventDefault(), setSlashIdx((i) => (i + 1) % slashMatches.length);
              if (e.key === "ArrowUp") return e.preventDefault(), setSlashIdx((i) => (i - 1 + slashMatches.length) % slashMatches.length);
              if (e.key === "Enter" || e.key === "Tab") return e.preventDefault(), applySlash(slashMatches[slashIdx]);
            }
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          rows={1}
          placeholder="Message WHITE-LOTUS…"
          aria-label="Message WHITE-LOTUS"
          className="block max-h-60 w-full resize-none bg-transparent px-4 pb-2 pt-3.5 text-base leading-relaxed sm:text-[0.95rem] outline-none placeholder:text-muted focus-visible:outline-none"
        />
        <div className="flex items-center gap-0.5 px-1.5 pb-2 sm:gap-1 sm:px-2">
          <input ref={fileRef} type="file" multiple hidden accept={ACCEPT_ATTR} onChange={(e) => (e.target.files && void upload([...e.target.files]), (e.target.value = ""))} />
          <IconButton label={guest ? "Attach files (needs a free account)" : "Attach files"} onClick={() => (guest ? void upload([]) : fileRef.current?.click())}>
            <Paperclip size={17} />
          </IconButton>
          <IconButton label={features.webSearch ? (state.webSearch ? "Web search on" : "Search the web") : "Web search isn't configured"} active={state.webSearch} disabled={!features.webSearch} onClick={() => setState({ ...state, webSearch: !state.webSearch })}>
            <Globe size={17} />
          </IconButton>
          <IconButton label={state.deepResearch ? "Deep research on" : "Deep research"} active={state.deepResearch} disabled={!features.webSearch} onClick={() => setState({ ...state, deepResearch: !state.deepResearch })}>
            <Telescope size={17} />
          </IconButton>
          <Picker
            label="Mode"
            value={state.mode}
            options={modes.map((m) => ({ id: m.id, label: m.label, hint: m.description }))}
            onChange={(mode) => setState({ ...state, mode })}
          />
          {models.length > 0 && (
            <Picker
              label="Model"
              value={model?.id ?? ""}
              options={models.map((m) => ({ id: m.id, label: m.label, hint: `${m.provider}${m.capabilities.vision ? " · vision" : ""}${m.capabilities.reasoning ? " · reasoning" : ""}` }))}
              onChange={(id) => setState({ ...state, model: id })}
              className="min-w-0"
            />
          )}
          <div className="flex-1" />
          <IconButton label={listening ? "Stop dictation" : "Dictate"} active={listening} onClick={toggleMic}>
            {listening ? <MicOff size={17} /> : <Mic size={17} />}
          </IconButton>
          {busy ? (
            <button onClick={onStop} aria-label="Stop generating" className="flex h-9 w-9 items-center justify-center rounded-full bg-fg text-bg transition-opacity hover:opacity-85">
              <Square size={14} fill="currentColor" />
            </button>
          ) : (
            <button onClick={submit} disabled={!canSend} aria-label="Send message" className="flex h-9 w-9 items-center justify-center rounded-full bg-fg text-bg transition-opacity hover:opacity-85 disabled:opacity-25">
              <ArrowUp size={18} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Picker({ label, value, options, onChange, className }: { label: string; value: string; options: { id: string; label: string; hint?: string }[]; onChange: (id: string) => void; className?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const cur = options.find((o) => o.id === value);
  return (
    <div ref={ref} className={cn("relative inline-flex", className)}>
      <button onClick={() => setOpen((o) => !o)} aria-label={`${label}: ${cur?.label}`} aria-expanded={open} className="inline-flex h-8 max-w-[92px] items-center gap-1 rounded-lg px-1.5 text-sm text-muted hover:bg-surface hover:text-fg sm:max-w-[150px] sm:px-2">
        <span className="truncate">{cur?.label ?? label}</span>
        <ChevronDown size={14} className="shrink-0" />
      </button>
      {open && (
        <div className="absolute bottom-full left-0 z-50 mb-2 max-h-80 w-64 max-w-[80vw] overflow-y-auto rounded-xl border border-border bg-elevated p-1 shadow-xl" role="listbox" aria-label={label}>
          {options.map((o) => (
            <button key={o.id} role="option" aria-selected={o.id === value} onClick={() => (onChange(o.id), setOpen(false))} className="flex w-full items-start gap-2 rounded-lg px-3 py-2 text-left hover:bg-surface">
              <Check size={14} className={cn("mt-0.5 shrink-0", o.id === value ? "opacity-100" : "opacity-0")} />
              <span className="min-w-0">
                <span className="block text-sm">{o.label}</span>
                {o.hint && <span className="block truncate text-xs text-muted">{o.hint}</span>}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
