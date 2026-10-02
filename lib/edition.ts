/**
 * Which edition is running. Edge-safe (reads process.env only).
 *  • "local": the launcher on your own computer (PGlite in your data folder).
 *  • "cloud": the online web app (e.g. Vercel + a hosted Postgres). Conversations are NOT stored on the server:
 *    they live in each device's browser storage; signed-in users get an end-to-end encrypted sync copy.
 */
export type Edition = "local" | "cloud";

export function edition(): Edition {
  const e = process.env.WHITE_LOTUS_EDITION;
  if (e === "cloud" || e === "local") return e;
  return process.env.DATABASE_URL && process.env.WHITE_LOTUS_LAUNCHER !== "1" ? "cloud" : "local";
}

export const isCloud = () => edition() === "cloud";
