/** Minimal, spec-compliant-enough Server-Sent Events parser for provider streams. */
export type SSEMessage = { event?: string; data: string };

export async function* parseSSE(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<SSEMessage> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let event: string | undefined;
  let data: string[] = [];
  const flush = (): SSEMessage | null => {
    if (data.length === 0) {
      event = undefined;
      return null;
    }
    const m = { event, data: data.join("\n") };
    event = undefined;
    data = [];
    return m;
  };
  try {
    while (true) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.search(/\r?\n/)) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + (buf[idx] === "\r" ? 2 : 1));
        if (line === "") {
          const m = flush();
          if (m) yield m;
        } else if (line.startsWith(":")) {
          continue;
        } else {
          const c = line.indexOf(":");
          const field = c === -1 ? line : line.slice(0, c);
          const val = c === -1 ? "" : line.slice(c + 1).replace(/^ /, "");
          if (field === "data") data.push(val);
          else if (field === "event") event = val;
        }
      }
    }
    if (buf.trim()) {
      for (const line of buf.split(/\r?\n/)) if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    const m = flush();
    if (m) yield m;
  } finally {
    reader.releaseLock();
  }
}

/** Newline-delimited JSON (used by some local servers). */
export async function* parseNDJSON(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) yield JSON.parse(line);
    }
  }
  if (buf.trim()) yield JSON.parse(buf);
}
