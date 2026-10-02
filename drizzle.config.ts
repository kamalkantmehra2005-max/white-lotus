import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./lib/database/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL ?? "postgres://localhost:5432/white_lotus" },
  strict: true,
});
