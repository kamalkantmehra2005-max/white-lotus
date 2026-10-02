"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Activity, Archive, Ban, Database, Globe, RefreshCw, ShieldCheck, Smartphone, UserPlus, Users } from "lucide-react";
import { CREATOR } from "@/config/creator";
import { Button, Card, Input, Switch } from "@/components/ui/primitives";
import { PageShell } from "@/components/ui/page";
import { useToast } from "@/components/ui/toast";
import { api } from "@/lib/client/api";
import { cn } from "@/lib/client/cn";

type Overview = {
  totals: { users: number; blockedUsers: number; conversations: number; messages: number; activeUsers24h: number };
  byModel: Array<{ model: string | null; requests: number; inputTokens: string | null; outputTokens: string | null; avgLatencyMs: number | null; failures: number }>;
  errors24h: Array<{ code: string | null; n: number }>;
  toolStats: Array<{ tool: string; calls: number; avgMs: number | null; failures: number }>;
  daily: Array<{ day: string; messages: number; searches: number }>;
  health: { database: boolean; models: string[]; searchProviders: string[]; uptimeSec: number; memoryMb: number; node: string };
  limits: Record<string, number>;
  recentErrors: Array<{ id: string; scope: string; code: string; message: string; createdAt: string }>;
};
type AdminModel = { id: string; label: string; provider: string; enabled: boolean; isDefault: boolean; capabilities: { vision: boolean; tools: boolean; reasoning: boolean } };
type Sys = { appUrl: string; edition?: "local" | "cloud"; remoteAccess: "off" | "tailscale" | "custom"; viewingFrom: string; singleUser: boolean; offlineMode: boolean; version: string };
type U = { id: string; email: string; name: string | null; role: string; blocked: boolean; createdAt: string; lastActiveAt: string | null; conversations: number; messagesToday: number };

const LIMIT_LABELS: Record<string, string> = { dailyMessages: "Daily messages / user", dailySearches: "Daily web searches / user", dailyUploads: "Daily uploads / user", fileLimit: "Stored files / user", maxUploadMb: "Max upload size (MB)", maxContextTokens: "Max context tokens", maxOutputTokens: "Max output tokens", perMinute: "Messages per minute" };

export function AdminPage() {
  const [o, setO] = useState<Overview | null>(null);
  const [users, setUsers] = useState<U[]>([]);
  const [q, setQ] = useState("");
  const [limits, setLimits] = useState<Record<string, number>>({});
  const [models, setModels] = useState<AdminModel[]>([]);
  const [sys, setSys] = useState<Sys | null>(null);
  const [nu, setNu] = useState({ name: "", email: "", password: "", role: "user" as "user" | "admin" });
  const toast = useToast();

  const load = useCallback(async () => {
    try {
      const [ov, us, ms, sy] = await Promise.all([
        api<Overview>("/api/admin/stats"),
        api<{ users: U[] }>(`/api/admin/users?q=${encodeURIComponent(q)}`),
        api<{ models: AdminModel[] }>("/api/admin/models"),
        api<Sys>("/api/admin/system"),
      ]);
      setO(ov);
      setSys(sy);
      setModels(ms.models);
      setLimits(ov.limits);
      setUsers(us.users);
    } catch (e) {
      toast((e as Error).message, "error");
    }
  }, [q, toast]);
  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);

  const saveModel = (m: AdminModel, patch: Partial<AdminModel>) => {
    const next = { ...m, ...patch };
    api("/api/admin/models", { method: "PUT", json: { modelId: next.id, enabled: next.enabled, displayName: next.label, isDefault: next.isDefault } })
      .then(load)
      .catch((e) => toast(e.message, "error"));
  };
  const addUser = () =>
    api("/api/admin/users", { method: "POST", json: nu })
      .then(() => (toast(`Account created for ${nu.email}`, "success"), setNu({ name: "", email: "", password: "", role: "user" }), load()))
      .catch((e) => toast(e.message, "error"));
  const setUser = (id: string, patch: Partial<U>) => api(`/api/admin/users/${id}`, { method: "PATCH", json: patch }).then(load).catch((e) => toast(e.message, "error"));
  const maxDaily = Math.max(1, ...(o?.daily.map((d) => d.messages) ?? [1]));

  return (
    <PageShell title="Admin / Creator" description="Settings, users, data and backups. Visible only to the owner. Message content is never shown here." actions={<Button variant="outline" onClick={load}><RefreshCw size={15} /> Refresh</Button>}>
      {!o ? <div className="h-40 animate-pulse rounded-2xl bg-surface" /> : (
        <div className="space-y-4">
          <Card className="flex flex-col gap-1 border-accent/30 sm:flex-row sm:items-center sm:justify-between" >
            <div data-testid="creator-card">
              <div className="text-xs uppercase tracking-wide text-muted">Creator</div>
              <div className="text-lg font-semibold">Created by {CREATOR.name}</div>
              <div className="text-sm text-muted">{CREATOR.role}</div>
            </div>
            <div className="text-xs text-muted">WHITE-LOTUS v{sys?.version ?? "1.0.0"}</div>
          </Card>

          {sys?.edition === "cloud" ? (
            <Card>
              <h2 className="mb-2 flex items-center gap-2 font-medium"><Globe size={16} /> Online edition</h2>
              <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
                <li>Address: <span className="font-mono text-xs">{sys.appUrl}</span></li>
                <li>Conversations are stored in each user&apos;s browser on their own device. Nothing is kept on the server for “without account” use.</li>
                <li>Signed-in users get end-to-end encrypted sync copies; the server (and you) can&apos;t read them.</li>
                <li>The hosted database holds only accounts, sessions, limits, usage counts and those encrypted copies.</li>
              </ul>
            </Card>
          ) : (
          <div className="grid gap-4 lg:grid-cols-2">
              <Card>
                <h2 className="mb-3 flex items-center gap-2 font-medium"><Globe size={16} /> Access from anywhere</h2>
                {sys && (
                  <dl className="grid grid-cols-[auto,1fr] gap-x-4 gap-y-1.5 text-sm">
                    <dt className="text-muted">Status</dt>
                    <dd data-testid="remote-status">{sys.remoteAccess === "off" ? "Off — only this computer" : sys.remoteAccess === "tailscale" ? "On — private (Tailscale, your devices only)" : "On — custom address"}</dd>
                    <dt className="text-muted">Address</dt><dd className="break-all font-mono text-xs">{sys.appUrl}</dd>
                    <dt className="text-muted">You are on</dt><dd>{sys.viewingFrom}</dd>
                    <dt className="text-muted">Offline mode</dt><dd>{sys.offlineMode ? "On (nothing leaves the computer)" : "Off"}</dd>
                  </dl>
                )}
                <p className="mt-3 text-xs text-muted">
                  {sys?.remoteAccess === "off" ? <>To use WHITE-LOTUS from your phone, run <code>npm run local -- remote on</code> on this computer (needs the free Tailscale app). </> : null}
                  <Smartphone size={12} className="inline" /> On your phone: open the address, then “Add to Home screen” to install the app. Guide: docs/MOBILE-AND-REMOTE.md
                </p>
              </Card>
              <Card>
                <h2 className="mb-3 flex items-center gap-2 font-medium"><Archive size={16} /> Data & backups</h2>
                <p className="text-sm text-muted">Everything is stored encrypted on this computer. Create or restore encrypted backups, move the data folder, see what leaves this computer, or delete everything.</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Link href="/settings?tab=storage"><Button variant="secondary" size="sm">Open Privacy & storage</Button></Link>
                  <Link href="/settings?tab=data"><Button variant="ghost" size="sm">Export (ZIP / JSON)</Button></Link>
                </div>
              </Card>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            {[["Users", o.totals.users, Users], ["Active (24h)", o.totals.activeUsers24h, Activity], ["Conversations", o.totals.conversations, Database], ["Messages", o.totals.messages, Database], ["Blocked", o.totals.blockedUsers, Ban]].map(([label, n, Icon]) => {
              const I = Icon as typeof Users;
              return (
                <Card key={label as string} className="p-4">
                  <div className="flex items-center gap-1.5 text-xs text-muted"><I size={13} /> {label as string}</div>
                  <div className="mt-1 text-2xl font-semibold tabular-nums">{(n as number).toLocaleString()}</div>
                </Card>
              );
            })}
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <h2 className="mb-3 font-medium">Messages · last 7 days</h2>
              {o.daily.length === 0 ? <p className="text-sm text-muted">No usage yet.</p> : (
                <div className="flex h-32 items-end gap-2">
                  {o.daily.map((d) => (
                    <div key={d.day} className="flex flex-1 flex-col items-center gap-1" title={`${d.day}: ${d.messages} messages, ${d.searches} searches`}>
                      <div className="w-full rounded-t-md bg-accent/80" style={{ height: `${Math.max(4, (d.messages / maxDaily) * 100)}%` }} />
                      <span className="text-[10px] text-muted">{d.day.slice(5)}</span>
                    </div>
                  ))}
                </div>
              )}
            </Card>
            <Card>
              <h2 className="mb-3 flex items-center gap-2 font-medium"><ShieldCheck size={16} /> System health</h2>
              <dl className="grid grid-cols-2 gap-y-1.5 text-sm">
                <dt className="text-muted">Database</dt><dd className={o.health.database ? "text-fg" : "text-danger"}>{o.health.database ? "Connected" : "Unreachable"}</dd>
                <dt className="text-muted">Models</dt><dd className="truncate">{o.health.models.join(", ") || <span className="text-danger">none configured</span>}</dd>
                <dt className="text-muted">Search</dt><dd>{o.health.searchProviders.join(", ") || "not configured"}</dd>
                <dt className="text-muted">Uptime</dt><dd>{Math.floor(o.health.uptimeSec / 3600)}h {Math.floor((o.health.uptimeSec % 3600) / 60)}m</dd>
                <dt className="text-muted">Memory (RSS)</dt><dd>{o.health.memoryMb} MB</dd>
                <dt className="text-muted">Errors (24h)</dt><dd>{o.errors24h.reduce((a, e) => a + Number(e.n), 0)} {o.errors24h.length > 0 && <span className="text-xs text-muted">({o.errors24h.map((e) => `${e.code}: ${e.n}`).join(", ")})</span>}</dd>
              </dl>
            </Card>
          </div>

          <Card>
            <h2 className="mb-3 font-medium">Model usage · 7 days</h2>
            <Table head={["Model", "Requests", "Input tok", "Output tok", "Avg latency", "Failures"]} rows={o.byModel.map((m) => [m.model ?? "—", m.requests, Number(m.inputTokens ?? 0).toLocaleString(), Number(m.outputTokens ?? 0).toLocaleString(), m.avgLatencyMs ? `${(m.avgLatencyMs / 1000).toFixed(1)}s` : "—", m.failures])} />
            <h2 className="mb-3 mt-6 font-medium">Tool usage · 7 days</h2>
            <Table head={["Tool", "Calls", "Avg time", "Failures"]} rows={o.toolStats.map((t) => [t.tool, t.calls, t.avgMs ? `${t.avgMs} ms` : "—", t.failures])} />
          </Card>

          <Card>
            <h2 className="mb-1 font-medium">Models</h2>
            <p className="mb-4 text-sm text-muted">Models whose provider credentials are configured on the server. Disable, rename, or choose the default.</p>
            {models.length === 0 ? (
              <p className="text-sm text-danger">No AI provider is configured. Set a provider API key (or a local model URL) in the server environment.</p>
            ) : (
              <div className="divide-y divide-border">
                {models.map((m) => (
                  <div key={m.id} className="flex flex-wrap items-center gap-3 py-2.5">
                    <Switch label={`Enable ${m.label}`} checked={m.enabled} onChange={(v) => saveModel(m, { enabled: v, isDefault: v ? m.isDefault : false })} />
                    <Input defaultValue={m.label} className="h-9 w-48" maxLength={80} onBlur={(e) => e.target.value.trim() && e.target.value !== m.label && saveModel(m, { label: e.target.value.trim() })} aria-label={`Display name for ${m.id}`} />
                    <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted">
                      {m.id}
                      {m.capabilities.vision ? " · vision" : ""}
                      {m.capabilities.tools ? " · tools" : ""}
                      {m.capabilities.reasoning ? " · reasoning" : ""}
                    </span>
                    <Button size="sm" variant={m.isDefault ? "secondary" : "ghost"} disabled={!m.enabled || m.isDefault} onClick={() => saveModel(m, { isDefault: true })}>
                      {m.isDefault ? "Default" : "Make default"}
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card>
            <h2 className="mb-3 font-medium">Recent errors</h2>
            {o.recentErrors.length === 0 ? (
              <p className="text-sm text-muted">No server errors recorded.</p>
            ) : (
              <ul className="space-y-1.5 text-sm">
                {o.recentErrors.map((e) => (
                  <li key={e.id} className="flex gap-3">
                    <span className="shrink-0 text-xs text-muted tabular-nums">{new Date(e.createdAt).toLocaleString()}</span>
                    <span className="shrink-0 font-mono text-xs">{e.scope}</span>
                    <span className="shrink-0 text-xs text-danger">{e.code}</span>
                    <span className="min-w-0 truncate text-xs text-muted" title={e.message}>{e.message}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <h2 className="mb-1 font-medium">Usage limits</h2>
            <p className="mb-4 text-sm text-muted">Overrides the environment defaults at runtime. 0 = unlimited. Admins are exempt.</p>
            <div className="grid gap-3 sm:grid-cols-2">
              {Object.keys(LIMIT_LABELS).map((k) => (
                <label key={k} className="flex items-center justify-between gap-3 text-sm">
                  <span>{LIMIT_LABELS[k]}</span>
                  <Input type="number" min={0} className="h-9 w-32" value={limits[k] ?? 0} onChange={(e) => setLimits({ ...limits, [k]: Number(e.target.value) })} />
                </label>
              ))}
            </div>
            <div className="mt-4 flex justify-end"><Button onClick={() => api("/api/admin/limits", { method: "PUT", json: limits }).then(() => toast("Limits saved", "success")).catch((e) => toast(e.message, "error"))}>Save limits</Button></div>
          </Card>

          <Card>
            <div className="mb-3 flex items-center justify-between gap-3">
              <h2 className="font-medium">Users</h2>
              <Input placeholder="Search email or name" value={q} onChange={(e) => setQ(e.target.value)} className="h-9 max-w-xs" />
            </div>
            {sys?.edition !== "cloud" && (<>
            <form
              className="mb-4 grid gap-2 rounded-xl border border-border p-3 sm:grid-cols-[1fr,1fr,1fr,auto,auto]"
              onSubmit={(e) => {
                e.preventDefault();
                addUser();
              }}
            >
              <Input placeholder="Name" aria-label="New user name" value={nu.name} onChange={(e) => setNu({ ...nu, name: e.target.value })} required className="h-9" />
              <Input placeholder="Email" aria-label="New user email" type="email" value={nu.email} onChange={(e) => setNu({ ...nu, email: e.target.value })} required className="h-9" />
              <Input placeholder="Temporary password" aria-label="New user password" type="password" autoComplete="new-password" value={nu.password} onChange={(e) => setNu({ ...nu, password: e.target.value })} required minLength={8} className="h-9" />
              <select aria-label="New user role" className="h-9 rounded-lg border border-border bg-bg px-2 text-sm" value={nu.role} onChange={(e) => setNu({ ...nu, role: e.target.value as "user" | "admin" })}>
                <option value="user">User</option>
                <option value="admin">Admin</option>
              </select>
              <Button type="submit" size="sm" className="h-9"><UserPlus size={14} /> Add user</Button>
            </form>
            <p className="-mt-2 mb-3 text-xs text-muted">Public sign-up stays closed. People you add here share this computer&apos;s encrypted data folder but can&apos;t see each other&apos;s chats or files.</p>
            </>)}
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-muted"><tr><th className="py-2 pr-3 font-medium">User</th><th className="py-2 pr-3 font-medium">Role</th><th className="py-2 pr-3 font-medium">Chats</th><th className="py-2 pr-3 font-medium">Today</th><th className="py-2 pr-3 font-medium">Last active</th><th /></tr></thead>
                <tbody className="divide-y divide-border">
                  {users.map((u) => (
                    <tr key={u.id} className={cn(u.blocked && "opacity-60")}>
                      <td className="py-2 pr-3"><div className="font-medium">{u.name ?? "—"}</div><div className="text-xs text-muted">{u.email}</div></td>
                      <td className="py-2 pr-3">{u.role}</td>
                      <td className="py-2 pr-3 tabular-nums">{u.conversations}</td>
                      <td className="py-2 pr-3 tabular-nums">{u.messagesToday}</td>
                      <td className="py-2 pr-3 text-muted">{u.lastActiveAt ? new Date(u.lastActiveAt).toLocaleString() : "never"}</td>
                      <td className="whitespace-nowrap py-2 text-right">
                        <Button size="sm" variant="ghost" onClick={() => setUser(u.id, { role: u.role === "admin" ? "user" : "admin" })}>{u.role === "admin" ? "Revoke admin" : "Make admin"}</Button>
                        <Button size="sm" variant={u.blocked ? "outline" : "ghost"} className={cn(!u.blocked && "text-danger")} onClick={() => setUser(u.id, { blocked: !u.blocked })}>{u.blocked ? "Unblock" : "Block"}</Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      )}
    </PageShell>
  );
}

function Table({ head, rows }: { head: string[]; rows: Array<Array<string | number>> }) {
  if (!rows.length) return <p className="text-sm text-muted">No data yet.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-muted"><tr>{head.map((h) => <th key={h} className="py-1.5 pr-4 font-medium">{h}</th>)}</tr></thead>
        <tbody className="divide-y divide-border">{rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className="py-1.5 pr-4 tabular-nums">{c}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}
