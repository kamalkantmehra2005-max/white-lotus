#!/usr/bin/env node
/**
 * Mock OpenAI-compatible AI server + SearXNG-compatible search, for development and automated tests.
 * No API keys needed. Run:  node scripts/mock-ai-server.mjs   (listens on :4010)
 * Then set:
 *   CUSTOM_OPENAI_BASE_URL=http://127.0.0.1:4010/v1  CUSTOM_OPENAI_NAME=custom
 *   DEFAULT_MODEL=custom:mock-model  FALLBACK_MODEL=custom:mock-fallback
 *   SEARXNG_URL=http://127.0.0.1:4010  SEARCH_PROVIDERS=searxng
 *
 * Behaviour (deterministic):
 *  - "calculate <expr>"       → calls the calculator tool, then reports the result
 *  - "fail primary"           → mock-model returns HTTP 500 (tests FALLBACK_MODEL)
 *  - "slow"                   → streams slowly (tests the Stop button)
 *  - <web_sources> in prompt  → answers citing [1] and [2]
 *  - <user_files> in prompt   → quotes the start of the file
 *  - image attached           → reports how many images it sees
 *  - title / query-planner system prompts → returns a title / JSON queries
 *  - otherwise                → "Echo: <your message>"
 */
import http from "node:http";

const PORT = Number(process.env.MOCK_PORT ?? 4010);

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter((p) => p.type === "text").map((p) => p.text).join("\n");
  return "";
}

function plan(body) {
  const msgs = body.messages ?? [];
  const system = msgs.filter((m) => m.role === "system").map((m) => textOf(m.content)).join("\n");
  const last = msgs[msgs.length - 1] ?? {};
  const lastUser = [...msgs].reverse().find((m) => m.role === "user");
  const userText = textOf(lastUser?.content);
  const images = Array.isArray(lastUser?.content) ? lastUser.content.filter((p) => p.type === "image_url").length : 0;

  if (system.includes("Write a 3–6 word title")) return { text: "Mock Conversation Title" };
  if (system.includes("You write web search queries")) return { text: '["mock query one", "mock query two"]' };
  if (last.role === "tool") {
    let data = {};
    const raw = String(last.content).replace(/^<tool_output[^>]*>\n?/, "").replace(/\n?<\/tool_output>$/, "");
    try { data = JSON.parse(raw); } catch { /* ignore */ }
    return { text: data.result !== undefined ? `The calculator says **${data.result}**.` : `Tool returned: ${String(last.content).slice(0, 200)}` };
  }
  const calc = userText.match(/calculate\s+(.+)$/im);
  if (calc && body.tools?.some((t) => t.function?.name === "calculator")) {
    return { tool: { name: "calculator", arguments: JSON.stringify({ expression: calc[1].trim() }) } };
  }
  if (userText.includes("<web_sources")) return { text: "Here is what the sources say. The mock result is confirmed [1], and a second source agrees [2]." };
  if (userText.includes("<user_files>")) {
    const file = userText.split("<user_files>")[1]?.split("</user_files>")[0] ?? "";
    return { text: `The document says: "${file.replace(/^###[^\n]*\n/, "").trim().slice(0, 80)}"` };
  }
  if (images) return { text: `I can see ${images} image${images > 1 ? "s" : ""}.` };
  const plain = userText.trim();
  return { text: `Echo: ${plain}`, slow: /\bslow\b/i.test(plain) };
}

function sse(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // Test double for MALWARE_SCANNER=http (NOT a scanner): flags the standard EICAR test string only.
  if (req.method === "POST" && url.pathname === "/scan") {
    if (req.headers.authorization !== "Bearer test-scan-token") {
      res.writeHead(401);
      res.end();
      return;
    }
    const parts = [];
    for await (const c of req) parts.push(c);
    const infected = Buffer.concat(parts).includes(Buffer.from("EICAR-STANDARD-ANTIVIRUS-TEST-FILE"));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(infected ? { clean: false, signature: "Mock.EICAR" } : { clean: true }));
    return;
  }
  if (req.method === "GET" && url.pathname === "/search") {
    const q = url.searchParams.get("q") ?? "";
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      results: [1, 2, 3].map((n) => ({ title: `Mock result ${n} for ${q}`, url: `http://127.0.0.1:${PORT}/page/${n}?q=${encodeURIComponent(q)}`, content: `Snippet ${n}: the mock fact about ${q}.`, publishedDate: "2026-01-0" + n })),
    }));
    return;
  }
  if (req.method === "GET" && url.pathname.startsWith("/page/")) {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<html><head><title>Mock page ${url.pathname.split("/")[2]}</title></head><body><nav>menu</nav><article><h1>Mock article</h1><p>This is the mock article body with the key fact.</p></article><script>alert(1)</script></body></html>`);
    return;
  }
  if (req.method === "GET" && url.pathname === "/v1/models") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "mock-model" }, { id: "mock-fallback" }] }));
    return;
  }
  if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
    let raw = "";
    for await (const c of req) raw += c;
    const body = JSON.parse(raw || "{}");
    const lastUser = [...(body.messages ?? [])].reverse().find((m) => m.role === "user");
    if (body.model === "mock-model" && /fail primary/i.test(textOf(lastUser?.content))) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "mock primary failure" } }));
      return;
    }
    const p = plan(body);
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    const id = `chatcmpl-${Date.now()}`;
    if (p.tool) {
      sse(res, { id, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: p.tool.name, arguments: "" } }] } }] });
      sse(res, { id, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: p.tool.arguments } }] } }] });
      sse(res, { id, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
    } else {
      const words = (body.model === "mock-fallback" ? `[fallback] ${p.text}` : p.text).split(/(\s+)/);
      for (const w of words) {
        if (res.destroyed) return;
        sse(res, { id, choices: [{ index: 0, delta: { content: w } }] });
        await new Promise((r) => setTimeout(r, p.slow ? 150 : 2));
      }
      sse(res, { id, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    }
    sse(res, { id, choices: [], usage: { prompt_tokens: 42, completion_tokens: 17 } });
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(PORT, "127.0.0.1", () => console.log(`Mock AI + search server on http://127.0.0.1:${PORT}`));
