/**
 * Where a request came from. Edge/Node-safe (headers only).
 *  • "loopback": typed into a browser on this computer (http://127.0.0.1 / localhost), not forwarded by a proxy.
 *  • anything else arrived through Tailscale serve (or another proxy) from another device.
 */
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export function hostnameOf(host: string | null): string {
  if (!host) return "";
  const h = host.trim().toLowerCase();
  if (h.startsWith("[")) return h.slice(0, h.indexOf("]") + 1);
  return h.split(":")[0];
}

const isLoopbackIp = (ip: string) => /^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+|\[::1\])$/i.test(ip.trim());

/**
 * Next.js itself fills in x-forwarded-for/host/proto for direct requests (with 127.0.0.1 and the local host), so
 * those headers alone don't mean "remote". A request is remote when any hop or host is not this computer.
 */
export function isLoopbackRequest(h: Headers): boolean {
  if (h.get("cf-connecting-ip") || h.get("tailscale-user-login") || h.get("forwarded")) return false;
  const xff = h.get("x-forwarded-for");
  if (xff && !xff.split(",").every(isLoopbackIp)) return false;
  const xfh = h.get("x-forwarded-host");
  if (xfh && !LOOPBACK.has(hostnameOf(xfh.split(",")[0]))) return false;
  return LOOPBACK.has(hostnameOf(h.get("host")));
}

/** Hosts a same-origin browser request may carry in its Origin header. */
export function allowedOriginHosts(h: Headers, publicUrl: string): Set<string> {
  const out = new Set<string>();
  for (const v of [h.get("host"), h.get("x-forwarded-host")]) if (v) out.add(v.split(",")[0].trim().toLowerCase());
  if (publicUrl) {
    try {
      out.add(new URL(publicUrl).host.toLowerCase());
    } catch {
      /* ignore a malformed setting */
    }
  }
  return out;
}
