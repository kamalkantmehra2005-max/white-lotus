import { lookup } from "node:dns/promises";
import { lookup as lookupCb, type LookupAddress } from "node:dns";
import { isIP } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";

/**
 * SSRF protection for every server-side fetch of a user- or model-supplied URL.
 *  - only http/https, default ports 80/443 (plus explicitly allowed)
 *  - no credentials in URL
 *  - hostname resolved via DNS and EVERY resolved address checked against private/reserved ranges
 *  - redirects followed manually (max 5) with re-validation at every hop
 *  - response size and time bounded
 */
export class UrlBlockedError extends Error {
  constructor(public reason: string) {
    super(`URL blocked: ${reason}`);
  }
}

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
}
const V4_BLOCKED: Array<[string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local incl. cloud metadata 169.254.169.254
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const n = ipv4ToInt(ip);
    return V4_BLOCKED.some(([base, bits]) => {
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      return (n & mask) === (ipv4ToInt(base) & mask);
    });
  }
  if (v === 6) {
    const a = ip.toLowerCase().replace(/^\[|\]$/g, "");
    if (a === "::" || a === "::1") return true;
    const mapped = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(a)) return true; // hex-form mapped v4 — reject conservatively
    if (/^f[cd]/.test(a)) return true; // unique local fc00::/7
    if (/^fe[89ab]/.test(a)) return true; // link-local fe80::/10
    if (/^ff/.test(a)) return true; // multicast
    if (a.startsWith("64:ff9b:")) return true; // NAT64
    if (a.startsWith("2001:db8")) return true; // documentation
    return false;
  }
  return true; // not an IP → treat as unsafe
}

const BLOCKED_HOSTNAMES = [/^localhost$/i, /\.localhost$/i, /\.local$/i, /\.internal$/i, /^metadata\.google\.internal$/i];

export type ValidateOptions = { allowPrivate?: boolean; resolver?: (host: string) => Promise<string[]> };

async function defaultResolver(host: string): Promise<string[]> {
  const res = await lookup(host, { all: true, verbatim: true });
  return res.map((r) => r.address);
}

/** Validate URL syntax and destination. Returns the parsed URL. Throws UrlBlockedError. */
export async function validateUrl(input: string, opts: ValidateOptions = {}): Promise<URL> {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new UrlBlockedError("invalid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new UrlBlockedError("only http(s) URLs are allowed");
  if (url.username || url.password) throw new UrlBlockedError("credentials in URL are not allowed");
  if (url.port && !["80", "443"].includes(url.port)) throw new UrlBlockedError("non-standard ports are not allowed");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host || host.length > 253) throw new UrlBlockedError("invalid host");
  if (opts.allowPrivate) return url;
  if (BLOCKED_HOSTNAMES.some((r) => r.test(host))) throw new UrlBlockedError("internal hostnames are not allowed");
  // Numeric-looking hosts (e.g. "2130706433", "0x7f.1") are normalised by WHATWG URL to dotted v4; isIP handles them.
  const addrs = isIP(host) ? [host] : await (opts.resolver ?? defaultResolver)(host).catch(() => {
    throw new UrlBlockedError("host could not be resolved");
  });
  if (addrs.length === 0) throw new UrlBlockedError("host could not be resolved");
  for (const a of addrs) if (isPrivateAddress(a)) throw new UrlBlockedError("private or reserved network address");
  return url;
}

export type SafeFetchResult = { url: string; status: number; contentType: string; body: string; truncated: boolean };

/**
 * Connection-time IP pinning: the socket may only connect to an address that passes isPrivateAddress().
 * This closes the DNS-rebinding gap between "validate" and "connect".
 */
function guardedLookup(allowPrivate: boolean) {
  return (hostname: string, options: object, cb: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void) => {
    lookupCb(hostname, { ...options, all: true, verbatim: true }, (err, addresses) => {
      if (err) return cb(err, "", 0);
      const list = (addresses as LookupAddress[]).filter((a) => allowPrivate || !isPrivateAddress(a.address));
      if (!list.length) return cb(Object.assign(new Error("blocked private address"), { code: "EBLOCKED" }), "", 0);
      if ((options as { all?: boolean }).all) cb(null, list);
      else cb(null, list[0].address, list[0].family);
    });
  };
}
const agents = new Map<boolean, Agent>();
function agentFor(allowPrivate: boolean) {
  let a = agents.get(allowPrivate);
  if (!a) {
    a = new Agent({ connect: { lookup: guardedLookup(allowPrivate) as never, timeout: 8_000 }, headersTimeout: 10_000, bodyTimeout: 10_000 });
    agents.set(allowPrivate, a);
  }
  return a;
}

/**
 * Fetch a URL safely: validate → connect only to validated public IPs → follow redirects manually,
 * re-validating every hop → cap size and time.
 */
export async function safeFetch(
  input: string,
  { maxBytes = 2_000_000, timeoutMs = 10_000, allowPrivate = false, accept = "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5" } = {},
): Promise<SafeFetchResult> {
  let current = input;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    for (let hop = 0; hop < 6; hop++) {
      const url = await validateUrl(current, { allowPrivate });
      const res = await undiciFetch(url, {
        redirect: "manual",
        signal: ctrl.signal,
        dispatcher: agentFor(allowPrivate),
        headers: { "User-Agent": "WHITE-LOTUS/1.0 (+reader)", Accept: accept },
      }).catch((e: unknown) => {
        const cause = (e as { cause?: { code?: string } }).cause;
        if (cause?.code === "EBLOCKED") throw new UrlBlockedError("private or reserved network address");
        throw e;
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        await res.body?.cancel().catch(() => {});
        if (!loc) throw new UrlBlockedError("redirect without location");
        current = new URL(loc, url).toString();
        continue;
      }
      const contentType = res.headers.get("content-type") ?? "";
      const reader = res.body?.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      let truncated = false;
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > maxBytes) {
            truncated = true;
            chunks.push(value.slice(0, value.byteLength - (total - maxBytes)));
            await reader.cancel();
            break;
          }
          chunks.push(value);
        }
      }
      const body = new TextDecoder("utf-8", { fatal: false }).decode(Buffer.concat(chunks));
      return { url: url.toString(), status: res.status, contentType, body, truncated };
    }
    throw new UrlBlockedError("too many redirects");
  } finally {
    clearTimeout(timer);
  }
}
