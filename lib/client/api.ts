"use client";

/** Typed fetch helper for the browser. Surfaces the server's friendly error message. */
export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
    public retryable = false,
  ) {
    super(message);
  }
}

export async function api<T = unknown>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, headers, ...rest } = init;
  const res = await fetch(path, {
    ...rest,
    headers: { ...(json !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  if (!res.ok) {
    let err: { code?: string; message?: string; retryable?: boolean } = {};
    try {
      err = ((await res.json()) as { error?: typeof err }).error ?? {};
    } catch {
      /* non-JSON */
    }
    if (res.status === 401 && err.code === "guest_ended" && typeof window !== "undefined") {
      window.location.assign(new URL("/?ended=guest", window.location.origin).toString());
    } else if (res.status === 401 && typeof window !== "undefined" && !window.location.pathname.startsWith("/login")) {
      // Session ended server-side (signed out elsewhere, idle timeout, expired): go back to sign-in.
      // Full navigation on purpose: drops all in-memory confidential state from the page.
      window.location.assign(new URL(`/login?expired=1&callbackUrl=${encodeURIComponent(window.location.pathname)}`, window.location.origin).toString());
    }
    throw new ApiError(err.code ?? "error", err.message ?? "WHITE-LOTUS couldn't complete that request. Please try again.", res.status, err.retryable);
  }
  return (await res.json()) as T;
}

/** Tiny global event bus to refresh lists (e.g., sidebar after a new chat). */
export const bus = {
  emit(name: "conversations:changed" | "projects:changed") {
    window.dispatchEvent(new CustomEvent(name));
  },
  on(name: "conversations:changed" | "projects:changed", fn: () => void) {
    window.addEventListener(name, fn);
    return () => window.removeEventListener(name, fn);
  },
};

/** Download a file via a short-lived signed link: the link is minted only after the server checks ownership. */
export async function downloadFile(id: string) {
  const { url } = await api<{ url: string; expiresAt: string }>(`/api/files/${encodeURIComponent(id)}/link`, { method: "POST" });
  const a = document.createElement("a");
  a.href = url;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}
