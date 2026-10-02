import "server-only";
import { env } from "@/config/env";
import { logger } from "@/lib/observability/logger";

/**
 * Transactional email over HTTPS (no SMTP library, so no SMTP-injection surface).
 * Supported: Resend (RESEND_API_KEY) and Postmark (POSTMARK_SERVER_TOKEN).
 * Dev fallback: when nothing is configured and NODE_ENV=development, the message is printed to the server console.
 */
export type Mail = { to: string; subject: string; text: string; html?: string };

export function isMailConfigured() {
  return Boolean(env.RESEND_API_KEY || env.POSTMARK_SERVER_TOKEN) || env.NODE_ENV === "development";
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function simpleHtml(text: string, link?: { href: string; label: string }) {
  return `<div style="font-family:system-ui,sans-serif;max-width:520px;margin:auto;padding:24px;color:#111">
<p style="letter-spacing:.14em;font-weight:600">WHITE-LOTUS</p>
${text.split("\n\n").map((p) => `<p style="line-height:1.6">${escapeHtml(p)}</p>`).join("")}
${link ? `<p><a href="${escapeHtml(link.href)}" style="display:inline-block;background:#111;color:#fff;padding:10px 18px;border-radius:10px;text-decoration:none">${escapeHtml(link.label)}</a></p>` : ""}
</div>`;
}

export async function sendMail(m: Mail): Promise<boolean> {
  if (!/^[^\s@<>"]+@[^\s@<>"]+$/.test(m.to)) return false; // header-injection guard
  try {
    if (env.RESEND_API_KEY) {
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: env.MAIL_FROM, to: [m.to], subject: m.subject, text: m.text, html: m.html }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!r.ok) throw new Error(`resend ${r.status}`);
      return true;
    }
    if (env.POSTMARK_SERVER_TOKEN) {
      const r = await fetch("https://api.postmarkapp.com/email", {
        method: "POST",
        headers: { "X-Postmark-Server-Token": env.POSTMARK_SERVER_TOKEN, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ From: env.MAIL_FROM, To: m.to, Subject: m.subject, TextBody: m.text, HtmlBody: m.html, MessageStream: "outbound" }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!r.ok) throw new Error(`postmark ${r.status}`);
      return true;
    }
    if (env.NODE_ENV === "development") {
      // Development only: print so you can click the link. Never happens in production.
      console.log(`\n[dev mail] To: ${m.to}\nSubject: ${m.subject}\n\n${m.text}\n`);
      return true;
    }
    return false;
  } catch (e) {
    logger.error("mail.send_failed", { error: e });
    return false;
  }
}
