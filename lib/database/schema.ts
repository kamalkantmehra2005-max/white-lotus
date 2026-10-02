/**
 * WHITE-LOTUS relational schema (PostgreSQL, Drizzle ORM).
 * Every user-owned row carries user_id; data-access helpers ALWAYS filter by it.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { AdapterAccountType } from "next-auth/adapters";

const id = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());
const createdAt = () => timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true, mode: "date" })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date());


export const roleEnum = pgEnum("role", ["user", "admin"]);
export const messageRoleEnum = pgEnum("message_role", ["system", "user", "assistant", "tool"]);
export const documentStatusEnum = pgEnum("document_status", ["pending", "processing", "ready", "failed"]);
export const memoryScopeEnum = pgEnum("memory_scope", ["user", "project"]);
export const projectMemberRoleEnum = pgEnum("project_member_role", ["owner", "editor", "viewer"]);

// ---------------- Auth (Auth.js adapter-compatible) ----------------

export const users = pgTable(
  "users",
  {
    id: id(),
    email: text("email").notNull(),
    emailVerified: timestamp("email_verified", { withTimezone: true, mode: "date" }),
    name: text("name"),
    image: text("image"),
    passwordHash: text("password_hash"),
    role: roleEnum("role").default("user").notNull(),
    blocked: boolean("blocked").default(false).notNull(),
    blockedReason: text("blocked_reason"),
    // Incremented to invalidate every session of this user (password change, "sign out everywhere", block).
    sessionVersion: integer("session_version").default(0).notNull(),
    lastActiveAt: timestamp("last_active_at", { withTimezone: true, mode: "date" }),
    // Guest (no-signup) identities: temporary, limited, deleted automatically at guest_expires_at.
    isGuest: boolean("is_guest").default(false).notNull(),
    guestExpiresAt: timestamp("guest_expires_at", { withTimezone: true, mode: "date" }),
    // Online edition: salt + PBKDF2 iterations for the browser-side key derivation (end-to-end encrypted sync).
    // The server only ever receives a derived login secret, never the password or the vault key.
    vaultSalt: text("vault_salt"),
    vaultKdfIterations: integer("vault_kdf_iterations"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("users_email_idx").on(sql`lower(${t.email})`),
    index("users_created_idx").on(t.createdAt),
    index("users_guest_expiry_idx").on(t.guestExpiresAt).where(sql`${t.isGuest}`),
  ],
);

export const accounts = pgTable(
  "accounts",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").$type<AdapterAccountType>().notNull(),
    provider: text("provider").notNull(),
    providerAccountId: text("provider_account_id").notNull(),
    refresh_token: text("refresh_token"),
    access_token: text("access_token"),
    expires_at: integer("expires_at"),
    token_type: text("token_type"),
    scope: text("scope"),
    id_token: text("id_token"),
    session_state: text("session_state"),
  },
  (t) => [primaryKey({ columns: [t.provider, t.providerAccountId] }), index("accounts_user_idx").on(t.userId)],
);

export const sessions = pgTable("sessions", {
  sessionToken: text("session_token").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expires: timestamp("expires", { withTimezone: true, mode: "date" }).notNull(),
});

export const verificationTokens = pgTable(
  "verification_tokens",
  {
    identifier: text("identifier").notNull(),
    token: text("token").notNull(),
    expires: timestamp("expires", { withTimezone: true, mode: "date" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.identifier, t.token] })],
);

export const profiles = pgTable("profiles", {
  id: id(),
  userId: text("user_id")
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: "cascade" }),
  displayName: text("display_name"),
  bio: text("bio"),
  timezone: text("timezone"),
  locale: text("locale"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const userSettings = pgTable("user_settings", {
  id: id(),
  userId: text("user_id")
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: "cascade" }),
  theme: text("theme").default("system").notNull(),
  defaultModel: text("default_model"),
  defaultMode: text("default_mode").default("quick").notNull(),
  memoryEnabled: boolean("memory_enabled").default(true).notNull(),
  webSearchDefault: boolean("web_search_default").default(false).notNull(),
  customInstructions: text("custom_instructions"),
  responseStyle: text("response_style"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// ---------------- Projects ----------------

export const projects = pgTable(
  "projects",
  {
    id: id(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    instructions: text("instructions"),
    settings: jsonb("settings").$type<Record<string, unknown>>().default({}).notNull(),
    archived: boolean("archived").default(false).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("projects_owner_idx").on(t.ownerId, t.updatedAt)],
);

export const projectMembers = pgTable(
  "project_members",
  {
    id: id(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: projectMemberRoleEnum("role").default("viewer").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("project_members_unique").on(t.projectId, t.userId), index("project_members_user_idx").on(t.userId)],
);

// ---------------- Conversations ----------------

export const conversations = pgTable(
  "conversations",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    projectId: text("project_id").references(() => projects.id, { onDelete: "set null" }),
    title: text("title").default("New chat").notNull(),
    mode: text("mode").default("quick").notNull(),
    model: text("model"),
    archived: boolean("archived").default(false).notNull(),
    pinned: boolean("pinned").default(false).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("conversations_user_idx").on(t.userId, t.archived, t.updatedAt.desc()),
    index("conversations_project_idx").on(t.projectId),
    // title is AES-GCM ciphertext (see lib/security/encryption.ts); searched after decryption, never indexed in plaintext
  ],
);

export type MessageSource = { id: number; title: string; url: string; snippet?: string; publishedAt?: string };
export type MessageMetadata = {
  sources?: MessageSource[];
  provenance?: Array<"model" | "web" | "user_file" | "tool" | "memory">;
  activity?: string[]; // safe, user-facing summary of what the assistant did (never private chain-of-thought)
  error?: { code: string; message: string };
  stopped?: boolean;
  mode?: string;
  attachmentIds?: string[];
  /** Web searches that actually ran for this answer (honesty: shown in the UI). */
  searchQueries?: string[];
};

export const messages = pgTable(
  "messages",
  {
    id: id(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    role: messageRoleEnum("role").notNull(),
    content: text("content").notNull(),
    metadata: jsonb("metadata").$type<MessageMetadata>().default({}).notNull(),
    searchTokens: text("search_tokens").array().default(sql`'{}'::text[]`).notNull(),
    model: text("model"),
    provider: text("provider"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    latencyMs: integer("latency_ms"),
    createdAt: createdAt(),
  },
  (t) => [
    index("messages_conversation_idx").on(t.conversationId, t.createdAt),
    // content + metadata are AES-GCM ciphertext; search uses the keyed blind index below (HMAC'd word tokens)
    index("messages_tokens_idx").using("gin", t.searchTokens),
  ],
);

// ---------------- Files ----------------

export const documents = pgTable(
  "documents",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    projectId: text("project_id").references(() => projects.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    mimeType: text("mime_type").notNull(),
    status: documentStatusEnum("status").default("pending").notNull(),
    error: text("error"),
    charCount: integer("char_count").default(0).notNull(),
    chunkCount: integer("chunk_count").default(0).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("documents_user_idx").on(t.userId, t.createdAt), index("documents_project_idx").on(t.projectId)],
);

export const documentChunks = pgTable(
  "document_chunks",
  {
    id: id(),
    documentId: text("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    content: text("content").notNull(),
    tokenCount: integer("token_count").default(0).notNull(),
    // content is AES-GCM ciphertext; retrieval uses the keyed blind index (HMAC'd word tokens), never plaintext.
    searchTokens: text("search_tokens").array().default(sql`'{}'::text[]`).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("chunks_document_idx").on(t.documentId, t.ordinal),
    index("chunks_user_idx").on(t.userId),
    index("chunks_tokens_idx").using("gin", t.searchTokens),
  ],
);

export const attachments = pgTable(
  "attachments",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    messageId: text("message_id").references(() => messages.id, { onDelete: "set null" }),
    documentId: text("document_id").references(() => documents.id, { onDelete: "set null" }),
    fileName: text("file_name").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    storageKey: text("storage_key").notNull().unique(),
    kind: text("kind").$type<"image" | "document" | "code" | "data">().notNull(),
    // Quarantine workflow: pending → clean | infected | unscanned (no scanner configured) | error
    scanStatus: text("scan_status").$type<"pending" | "clean" | "infected" | "unscanned" | "error">().default("pending").notNull(),
    scanEngine: text("scan_engine"),
    scannedAt: timestamp("scanned_at", { withTimezone: true, mode: "date" }),
    sha256: text("sha256"),
    // upload = you added it · generated = saved from an AI answer ("Save as file")
    origin: text("origin").$type<"upload" | "generated">().default("upload").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("attachments_user_idx").on(t.userId, t.createdAt), index("attachments_message_idx").on(t.messageId)],
);

// ---------------- Search history (local) ----------------
// Every web search WHITE-LOTUS runs for you, kept on this computer. The query text is AES-GCM encrypted.
export const searchHistory = pgTable(
  "search_history",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id").references(() => conversations.id, { onDelete: "set null" }),
    query: text("query").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("search_history_user_idx").on(t.userId, t.createdAt)],
);

// ---------------- Memory ----------------

export const memories = pgTable(
  "memories",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
    scope: memoryScopeEnum("scope").default("user").notNull(),
    content: text("content").notNull(),
    source: text("source").$type<"user" | "assistant">().default("user").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("memories_user_idx").on(t.userId, t.scope), index("memories_project_idx").on(t.projectId)],
);

// ---------------- Usage / admin / observability ----------------

export const usageRecords = pgTable(
  "usage_records",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").$type<"message" | "search" | "upload" | "tool">().notNull(),
    model: text("model"),
    provider: text("provider"),
    inputTokens: integer("input_tokens").default(0).notNull(),
    outputTokens: integer("output_tokens").default(0).notNull(),
    latencyMs: integer("latency_ms"),
    success: boolean("success").default(true).notNull(),
    errorCode: text("error_code"),
    createdAt: createdAt(),
  },
  (t) => [
    index("usage_user_kind_idx").on(t.userId, t.kind, t.createdAt),
    index("usage_created_idx").on(t.createdAt),
    index("usage_model_idx").on(t.model),
  ],
);

export const modelSettings = pgTable("model_settings", {
  id: id(),
  modelId: text("model_id").notNull().unique(),
  displayName: text("display_name").notNull(),
  enabled: boolean("enabled").default(true).notNull(),
  isDefault: boolean("is_default").default(false).notNull(),
  config: jsonb("config").$type<Record<string, unknown>>().default({}).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const systemSettings = pgTable("system_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: updatedAt(),
});

export const toolCalls = pgTable(
  "tool_calls",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    messageId: text("message_id").references(() => messages.id, { onDelete: "set null" }),
    toolName: text("tool_name").notNull(),
    input: jsonb("input").notNull(),
    output: jsonb("output"),
    success: boolean("success").default(true).notNull(),
    error: text("error"),
    durationMs: integer("duration_ms"),
    createdAt: createdAt(),
  },
  (t) => [
    index("tool_calls_user_idx").on(t.userId, t.createdAt),
    index("tool_calls_message_idx").on(t.messageId),
    index("tool_calls_name_idx").on(t.toolName, t.createdAt),
  ],
);

export const errorLogs = pgTable(
  "error_logs",
  {
    id: id(),
    scope: text("scope").notNull(),
    code: text("code").notNull(),
    message: text("message").notNull(),
    userId: text("user_id"),
    requestId: text("request_id"),
    createdAt: createdAt(),
  },
  (t) => [index("error_logs_created_idx").on(t.createdAt), index("error_logs_scope_idx").on(t.scope, t.createdAt)],
);

/**
 * Server-side session registry. Every signed-in browser/device gets a row; the session JWT only carries its id.
 * Revoking a row (sign out, sign out everywhere, admin block) ends that session on its next request.
 */
export const userSessions = pgTable(
  "user_sessions",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // Coarse, privacy-preserving device label (browser + OS), not the full user agent.
    device: text("device").default("Unknown device").notNull(),
    // Truncated IP (/24 for IPv4, /48 for IPv6) — enough to recognise a location, not to identify a person.
    ipPrefix: text("ip_prefix"),
    createdAt: createdAt(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
    revokedReason: text("revoked_reason"),
  },
  (t) => [index("user_sessions_user_idx").on(t.userId, t.revokedAt), index("user_sessions_expires_idx").on(t.expiresAt)],
);

export const rateLimitBuckets = pgTable(
  "rate_limit_buckets",
  {
    key: text("key").primaryKey(),
    count: integer("count").default(0).notNull(),
    resetAt: timestamp("reset_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (t) => [index("rate_limit_reset_idx").on(t.resetAt)],
);

/**
 * Online edition: end-to-end encrypted sync copies (one row per conversation / settings item).
 * `ct` is AES-256-GCM ciphertext made in the browser with a key the server never sees.
 * `seq` is a global change counter, so a device can ask for "everything changed since N".
 */
export const webVault = pgTable(
  "web_vault",
  {
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    itemId: text("item_id").notNull(),
    seq: bigint("seq", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
    deleted: boolean("deleted").default(false).notNull(),
    iv: text("iv").notNull(),
    ct: text("ct").notNull(),
    bytes: integer("bytes").notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.itemId] }), index("web_vault_user_seq_idx").on(t.userId, t.seq)],
);

export type User = typeof users.$inferSelect;
export type Conversation = typeof conversations.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type Project = typeof projects.$inferSelect;
export type Memory = typeof memories.$inferSelect;
export type Document = typeof documents.$inferSelect;
export type Attachment = typeof attachments.$inferSelect;
export type UserSettingsRow = typeof userSettings.$inferSelect;
