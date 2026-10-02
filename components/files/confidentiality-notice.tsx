"use client";

import { ShieldAlert, X } from "lucide-react";
import { useSyncExternalStore } from "react";

const KEY = "wl.confidentialityNotice.dismissed";
const subscribe = (cb: () => void) => {
  window.addEventListener("storage", cb);
  return () => window.removeEventListener("storage", cb);
};
const read = () => {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
};

/**
 * Plain-language notice shown before people upload confidential material. It states what WHITE-LOTUS does and
 * does NOT do — no claims of privilege, compliance or absolute confidentiality.
 */
export function ConfidentialityNotice() {
  const dismissed = useSyncExternalStore(subscribe, read, () => true);
  if (dismissed) return null;
  return (
    <div className="mb-6 flex gap-3 rounded-2xl border border-border bg-surface p-4 text-sm" role="note">
      <ShieldAlert size={18} className="mt-0.5 shrink-0 text-accent" />
      <div className="min-w-0 flex-1 space-y-1.5">
        <p className="font-medium">Before uploading highly confidential or privileged documents</p>
        <p className="text-muted">
          Your files are stored only on this computer, in your WHITE-LOTUS data folder, each one encrypted. They&apos;re scanned before use when a
          local scanner (ClamAV) is set up. When you ask about a file, its relevant text is sent to the AI model you chose — if that&apos;s a cloud
          AI, check its data-retention terms, or use a local model (Ollama) so nothing leaves this computer. WHITE-LOTUS doesn&apos;t by itself
          establish legal privilege or regulatory compliance.
        </p>
      </div>
      <button
        aria-label="Dismiss notice"
        className="self-start rounded-md p-1 text-muted hover:text-fg"
        onClick={() => {
          try {
            localStorage.setItem(KEY, "1");
            window.dispatchEvent(new StorageEvent("storage", { key: KEY }));
          } catch {
            /* storage unavailable: notice simply stays */
          }
        }}
      >
        <X size={14} />
      </button>
    </div>
  );
}
