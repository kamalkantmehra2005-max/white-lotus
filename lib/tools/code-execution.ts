import "server-only";
import { Worker } from "node:worker_threads";

/**
 * JavaScript code execution in a worker thread with a fresh vm context, no require/process/fetch,
 * a hard timeout and memory caps.
 *
 * SECURITY: Node's vm is NOT a hard security boundary. This tool is DISABLED by default
 * (ENABLE_CODE_EXECUTION=false) and should only be enabled for trusted, self-hosted deployments —
 * or replaced with an isolated sandbox service (Firecracker, gVisor, e2b, Judge0). The interface stays the same.
 */
const WORKER_SRC = `
const { parentPort, workerData } = require("node:worker_threads");
const vm = require("node:vm");
const logs = [];
const fmt = (v) => { try { return typeof v === "string" ? v : JSON.stringify(v); } catch { return String(v); } };
const sandbox = Object.create(null);
sandbox.console = { log: (...a) => { if (logs.length < 200) logs.push(a.map(fmt).join(" ")); } };
sandbox.Math = Math; sandbox.JSON = JSON; sandbox.Date = Date; sandbox.Array = Array; sandbox.Object = Object;
sandbox.Number = Number; sandbox.String = String; sandbox.Map = Map; sandbox.Set = Set; sandbox.RegExp = RegExp;
const ctx = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
try {
  const result = new vm.Script(workerData.code, { filename: "user.js" }).runInContext(ctx, { timeout: workerData.timeout });
  parentPort.postMessage({ ok: true, result: fmt(result), logs });
} catch (e) {
  parentPort.postMessage({ ok: false, error: String(e && e.message || e).slice(0, 500), logs });
}`;

export function runJavaScript(code: string, timeoutMs = 3000): Promise<{ ok: boolean; result?: string; error?: string; logs: string[] }> {
  return new Promise((resolve) => {
    const w = new Worker(WORKER_SRC, {
      eval: true,
      workerData: { code: code.slice(0, 20_000), timeout: timeoutMs },
      resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, codeRangeSizeMb: 16 },
      env: {},
    });
    const kill = setTimeout(() => {
      void w.terminate();
      resolve({ ok: false, error: "Execution timed out", logs: [] });
    }, timeoutMs + 500);
    w.once("message", (m) => {
      clearTimeout(kill);
      void w.terminate();
      resolve(m);
    });
    w.once("error", (e) => {
      clearTimeout(kill);
      resolve({ ok: false, error: e.message.slice(0, 300), logs: [] });
    });
  });
}
