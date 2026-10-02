"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Download, FileText, Image as ImageIcon, Trash2, Upload } from "lucide-react";
import { Button, IconButton } from "@/components/ui/primitives";
import { PageShell } from "@/components/ui/page";
import { useToast } from "@/components/ui/toast";
import { api, downloadFile } from "@/lib/client/api";
import { ACCEPT_ATTR } from "@/lib/files/validate";
import { ConfidentialityNotice } from "./confidentiality-notice";

type F = { id: string; fileName: string; sizeBytes: number; kind: string; createdAt: string; status: string | null; chunkCount: number | null; error: string | null; scanStatus: string; scanEngine: string | null };

const SCAN_LABEL: Record<string, { text: string; tone: string; title: string }> = {
  clean: { text: "Scanned · clean", tone: "text-fg", title: "Checked by the malware scanner before it was released from quarantine" },
  unscanned: { text: "Not scanned", tone: "text-muted", title: "No malware scanner (ClamAV) is set up on this computer" },
};

const fmt = (b: number) => (b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(0)} KB` : `${(b / 1048576).toFixed(1)} MB`);

export function FilesPage() {
  const [files, setFiles] = useState<F[] | null>(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  const toast = useToast();
  const load = useCallback(() => api<{ files: F[] }>("/api/files").then((r) => setFiles(r.files)).catch((e) => toast(e.message, "error")), [toast]);
  useEffect(() => void load(), [load]);

  async function upload(list: FileList) {
    setBusy(true);
    for (const f of [...list]) {
      const fd = new FormData();
      fd.append("file", f);
      await api("/api/files", { method: "POST", body: fd }).catch((e) => toast(`${f.name}: ${e.message}`, "error"));
    }
    setBusy(false);
    void load();
  }

  return (
    <PageShell
      title="Files"
      description="Private to your account. Files are validated, held in quarantine for a malware scan, then stored privately; names and extracted text are encrypted. Downloads use one-minute signed links."
      actions={
        <>
          <input ref={ref} type="file" hidden multiple accept={ACCEPT_ATTR} onChange={(e) => e.target.files && upload(e.target.files)} />
          <Button onClick={() => ref.current?.click()} disabled={busy}><Upload size={16} /> {busy ? "Uploading…" : "Upload"}</Button>
        </>
      }
    >
      <ConfidentialityNotice />
      {files === null ? (
        <div className="h-32 animate-pulse rounded-2xl bg-surface" />
      ) : files.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border p-10 text-center text-sm text-muted">No files yet. PDF, DOCX, PPTX, XLSX, CSV, JSON, Markdown, code and images are supported.</div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-border">
          <table className="w-full text-sm">
            <thead className="bg-surface text-left text-xs text-muted">
              <tr><th className="w-[45%] px-4 py-2 font-medium">Name</th><th className="hidden px-4 py-2 font-medium sm:table-cell">Size</th><th className="hidden px-4 py-2 font-medium md:table-cell">Status</th><th className="hidden px-4 py-2 font-medium md:table-cell">Uploaded</th><th /></tr>
            </thead>
            <tbody className="divide-y divide-border">
              {files.map((f) => (
                <tr key={f.id}>
                  <td className="max-w-0 px-4 py-2.5">
                    <div className="flex items-center gap-2 truncate">{f.kind === "image" ? <ImageIcon size={15} className="shrink-0 text-muted" /> : <FileText size={15} className="shrink-0 text-muted" />}<span className="truncate">{f.fileName}</span></div>
                    {f.error && <div className="mt-0.5 text-xs text-danger">{f.error}</div>}
                  </td>
                  <td className="hidden px-4 py-2.5 text-muted sm:table-cell">{fmt(f.sizeBytes)}</td>
                  <td className="hidden px-4 py-2.5 text-muted md:table-cell">
                    <div>{f.kind === "image" ? "image" : f.status === "ready" ? `indexed · ${f.chunkCount} parts` : f.status}</div>
                    <div className={`text-xs ${SCAN_LABEL[f.scanStatus]?.tone ?? "text-muted"}`} title={SCAN_LABEL[f.scanStatus]?.title}>{SCAN_LABEL[f.scanStatus]?.text ?? f.scanStatus}</div>
                  </td>
                  <td className="hidden px-4 py-2.5 text-muted md:table-cell">{new Date(f.createdAt).toLocaleDateString()}</td>
                  <td className="whitespace-nowrap px-2 py-2.5 text-right">
                    <IconButton label={`Download ${f.fileName}`} onClick={() => downloadFile(f.id).catch((e) => toast(e.message, "error"))}><Download size={15} /></IconButton>
                    <IconButton label={`Delete ${f.fileName}`} onClick={() => api(`/api/files/${f.id}`, { method: "DELETE" }).then(load).catch((e) => toast(e.message, "error"))}><Trash2 size={15} /></IconButton>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </PageShell>
  );
}
