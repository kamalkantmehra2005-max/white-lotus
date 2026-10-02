/**
 * Verification tool: load with NODE_OPTIONS="--require ./scripts/dev/egress-guard.cjs" to record (and block)
 * every outgoing network connection to anything other than this computer / the local network.
 * Attempts are appended as JSON lines to $EGRESS_LOG (default: ./egress-attempts.log).
 */
/* eslint-disable @typescript-eslint/no-require-imports -- plain CommonJS preload for NODE_OPTIONS --require */
const net = require("node:net");
const fs = require("node:fs");
const LOG = process.env.EGRESS_LOG || "egress-attempts.log";
const local = (h) =>
  !h || h === "localhost" || h === "::1" || h === "::" || /^127\./.test(h) || /^0\.0\.0\.0$/.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || h.endsWith(".localhost");
const orig = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  let host;
  const a0 = args[0];
  if (Array.isArray(a0)) host = a0[0]?.host;
  else if (a0 && typeof a0 === "object") host = a0.host || (a0.path ? "unix-socket" : undefined);
  else if (typeof a0 === "number" || /^\d+$/.test(String(a0))) host = typeof args[1] === "string" ? args[1] : "localhost";
  else if (typeof a0 === "string") host = "unix-socket";
  if (host !== "unix-socket" && !local(host)) {
    fs.appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, host }) + "\n");
    process.nextTick(() => this.destroy(new Error(`egress blocked: ${host}`)));
    return this;
  }
  return orig.apply(this, args);
};
