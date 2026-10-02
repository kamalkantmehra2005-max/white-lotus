import path from "node:path";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { describe, expect, it } from "vitest";
import { MIGRATIONS } from "@/lib/database/migrations.generated";
import { sslFor } from "@/lib/database/cloud-migrate";

describe("embedded migrations (online edition)", () => {
  it("match the drizzle/ folder exactly — run `npm run db:embed` after generating a migration", () => {
    const fromDisk = readMigrationFiles({ migrationsFolder: path.join(process.cwd(), "drizzle") });
    expect(MIGRATIONS).toEqual(fromDisk);
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(6);
  });

  it("include the web_vault table and sequence", () => {
    const all = MIGRATIONS.flatMap((m) => m.sql).join("\n");
    expect(all).toMatch(/CREATE TABLE "web_vault"/);
    expect(all).toMatch(/CREATE SEQUENCE IF NOT EXISTS "web_vault_seq"/);
  });

  it("picks TLS from the connection string", () => {
    expect(sslFor("postgresql://u:p@ep-x.neon.tech/neondb?sslmode=require")).toBe("require");
    expect(sslFor("postgresql://u:p@ep-x.neon.tech/neondb?sslmode=verify-full")).toBe("verify-full");
    expect(sslFor("postgresql://u:p@ep-x.neon.tech/neondb")).toBe("require");
    expect(sslFor("postgres://postgres:postgres@127.0.0.1:5544/postgres?sslmode=disable")).toBe(false);
    expect(sslFor("postgres://postgres@localhost/db")).toBe(false);
  });
});
