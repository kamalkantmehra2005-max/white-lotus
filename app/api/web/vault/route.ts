import { NextResponse } from "next/server";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import { z } from "zod";
import { env } from "@/config/env";
import { requireAccount } from "@/lib/auth";
import { db, rowsOf } from "@/lib/database/client";
import { webVault } from "@/lib/database/schema";
import { AppError, handle } from "@/lib/errors";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { assertCloud } from "@/lib/web/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * End-to-end encrypted sync for signed-in users. The browser encrypts each conversation (AES-256-GCM, key derived
 * from the password on the device) before sending it; the server stores opaque ciphertext it cannot read.
 *   GET  ?since=<seq>   → changes after seq (pull)
 *   POST { items }      → upload changes; last write (by updatedAt) wins per item (push)
 *   DELETE              → remove every sync copy of this account (devices keep their own local data)
 */
const B64 = /^[A-Za-z0-9+/_=-]+$/;
const MAX_ITEM = 1_500_000;
const item = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  updatedAt: z.number().int().nonnegative(),
  deleted: z.boolean().default(false),
  iv: z.string().max(32).regex(B64),
  ct: z.string().max(MAX_ITEM).regex(/^[A-Za-z0-9+/_=-]*$/),
});

export const GET = handle(async (req: Request) => {
  await assertCloud();
  const user = await requireAccount("Sync");
  await enforceRateLimit(`vault:get:${user.id}`, 120, 60);
  const since = Number(new URL(req.url).searchParams.get("since") ?? 0) || 0;
  const rows = await db
    .select({ id: webVault.itemId, seq: webVault.seq, updatedAt: webVault.updatedAt, deleted: webVault.deleted, iv: webVault.iv, ct: webVault.ct })
    .from(webVault)
    .where(and(eq(webVault.userId, user.id), gt(webVault.seq, since)))
    .orderBy(asc(webVault.seq))
    .limit(200);
  const cursor = rows.length ? rows[rows.length - 1].seq : since;
  return NextResponse.json({ items: rows, cursor, more: rows.length === 200 }, { headers: { "cache-control": "no-store" } });
});

export const POST = handle(async (req: Request) => {
  await assertCloud();
  const user = await requireAccount("Sync");
  await enforceRateLimit(`vault:post:${user.id}`, 60, 60);
  const { items } = z.object({ items: z.array(item).min(1).max(50) }).parse(await req.json());
  const [{ used }] = rowsOf<{ used: number }>(await db.execute(sql`select coalesce(sum(bytes),0)::bigint as used from web_vault where user_id = ${user.id}`)).map((r) => ({ used: Number(r.used) }));
  const incoming = items.reduce((a, i) => a + i.ct.length, 0);
  if (used + incoming > env.WEB_VAULT_MAX_MB * 1024 * 1024) throw new AppError("vault_full", `Sync storage is full (${env.WEB_VAULT_MAX_MB} MB). Delete old chats to free space; they stay on this device.`, 413);
  const accepted: string[] = [];
  for (const i of items) {
    const deletedCt = i.deleted ? "" : i.ct; // tombstones keep no content
    const r = await db.execute(sql`
      insert into web_vault (user_id, item_id, seq, updated_at, deleted, iv, ct, bytes)
      values (${user.id}, ${i.id}, nextval('web_vault_seq'), ${i.updatedAt}, ${i.deleted}, ${i.iv}, ${deletedCt}, ${deletedCt.length})
      on conflict (user_id, item_id) do update
        set seq = excluded.seq, updated_at = excluded.updated_at, deleted = excluded.deleted, iv = excluded.iv, ct = excluded.ct, bytes = excluded.bytes
        where web_vault.updated_at < excluded.updated_at
      returning item_id`);
    if (rowsOf(r).length) accepted.push(i.id);
  }
  return NextResponse.json({ accepted });
});

export const DELETE = handle(async () => {
  await assertCloud();
  const user = await requireAccount("Sync");
  await db.delete(webVault).where(eq(webVault.userId, user.id));
  return NextResponse.json({ ok: true });
});
