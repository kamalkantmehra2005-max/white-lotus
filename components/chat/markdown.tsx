"use client";

import { memo, useState, type ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { Check, Copy, ImageIcon } from "lucide-react";
import type { MessageSource } from "@/lib/database/schema";

/**
 * Safe Markdown: raw HTML is NOT rendered (no rehype-raw), URLs are restricted to http(s)/mailto,
 * external links open with rel="noopener noreferrer nofollow". Citation markers [n] become source chips.
 */
const SAFE_PROTOCOL = /^(https?:|mailto:|#)/i;
function urlTransform(url: string) {
  const u = defaultUrlTransform(url);
  return SAFE_PROTOCOL.test(u) ? u : "";
}

/** Turn [1] / [1][2] / [1, 2] into links to #cite-n outside of code. */
export function linkCitations(md: string, max: number): string {
  if (max === 0) return md;
  return md
    .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .map((seg, i) =>
      i % 2 === 1
        ? seg
        : seg.replace(/\[(\d{1,2}(?:\s*,\s*\d{1,2})*)\](?!\()/g, (m, nums: string) => {
            const ids = nums.split(",").map((n) => Number(n.trim()));
            if (ids.some((n) => n < 1 || n > max)) return m;
            return ids.map((n) => `[${n}](#cite-${n})`).join("");
          }),
    )
    .join("");
}

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (node && typeof node === "object" && "props" in node) return textOf((node as { props: { children?: ReactNode } }).props.children);
  return "";
}

function CodeBlock({ children }: { children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const child = Array.isArray(children) ? children[0] : children;
  const className = (child as { props?: { className?: string } })?.props?.className ?? "";
  const lang = className.match(/language-([\w+-]+)/)?.[1] ?? "text";
  const code = textOf(children).replace(/\n$/, "");
  return (
    <div className="code-block group my-4 overflow-hidden rounded-xl border border-border bg-[#16161c]">
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-1.5 text-xs text-white/60">
        <span className="font-mono">{lang}</span>
        <button
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-white/10 hover:text-white"
          onClick={() => {
            void navigator.clipboard.writeText(code);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          aria-label="Copy code"
        >
          {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre>{children}</pre>
    </div>
  );
}

export const Markdown = memo(function Markdown({ content, sources = [] }: { content: string; sources?: MessageSource[] }) {
  return (
    <div className="prose-wl">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        urlTransform={urlTransform}
        components={{
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
          a: ({ href, children }) => {
            const cite = href?.match(/^#cite-(\d+)$/);
            if (cite) {
              const s = sources.find((x) => x.id === Number(cite[1]));
              if (!s) return <>{children}</>;
              return (
                <a
                  href={s.url}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                  title={s.title}
                  className="!no-underline mx-0.5 inline-flex h-[1.15rem] min-w-[1.15rem] -translate-y-0.5 items-center justify-center rounded-md bg-accent/15 px-1 align-middle text-[0.7rem] font-semibold !text-accent hover:bg-accent/25"
                >
                  {cite[1]}
                </a>
              );
            }
            if (!href) return <>{children}</>;
            const external = /^https?:/i.test(href);
            return (
              <a href={href} {...(external ? { target: "_blank", rel: "noopener noreferrer nofollow" } : {})}>
                {children}
              </a>
            );
          },
          // Never auto-load remote images from model output: an injected image URL could leak data in its query string.
          // Show a link the user can choose to open instead.
          img: ({ src, alt }) => {
            if (typeof src !== "string" || !/^https:/i.test(src)) return null;
            let host = "";
            try {
              host = new URL(src).hostname;
            } catch {
              return null;
            }
            return (
              <a href={src} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-xs !no-underline">
                <ImageIcon size={12} /> {alt || "Image"} <span className="text-muted">({host})</span>
              </a>
            );
          },
        }}
      >
        {linkCitations(content, sources.length)}
      </ReactMarkdown>
    </div>
  );
});
