import "server-only";
import { and, count, desc, eq } from "drizzle-orm";
import { db } from "@/lib/database/client";
import { conversations, projectMembers, projects } from "@/lib/database/schema";
import { Errors } from "@/lib/errors";
import { decryptOr, encrypt, encryptNullable } from "@/lib/security/encryption";
import { AAD } from "@/lib/security/fields";

/**
 * Projects data layer. Project name, description and instructions often identify clients/matters,
 * so all three are AES-256-GCM encrypted at rest and only decrypted for the owner.
 */
type Row = typeof projects.$inferSelect;
export type ProjectInput = { name?: string; description?: string | null; instructions?: string | null };

export function openProject<T extends Pick<Row, "ownerId" | "name"> & Partial<Pick<Row, "description" | "instructions">>>(p: T): T {
  return {
    ...p,
    name: decryptOr(p.name, AAD.projectName(p.ownerId), "Project"),
    ...(p.description !== undefined ? { description: p.description ? decryptOr(p.description, AAD.projectDesc(p.ownerId), "") : p.description } : {}),
    ...(p.instructions !== undefined ? { instructions: p.instructions ? decryptOr(p.instructions, AAD.project(p.ownerId), "") : p.instructions } : {}),
  };
}

function seal(userId: string, d: ProjectInput) {
  return {
    ...(d.name !== undefined ? { name: encrypt(d.name, AAD.projectName(userId)) } : {}),
    ...(d.description !== undefined ? { description: encryptNullable(d.description, AAD.projectDesc(userId)) } : {}),
    ...(d.instructions !== undefined ? { instructions: encryptNullable(d.instructions, AAD.project(userId)) } : {}),
  };
}

export async function listProjects(userId: string) {
  const rows = await db
    .select({ id: projects.id, ownerId: projects.ownerId, name: projects.name, description: projects.description, updatedAt: projects.updatedAt, conversations: count(conversations.id) })
    .from(projects)
    .leftJoin(conversations, and(eq(conversations.projectId, projects.id), eq(conversations.archived, false)))
    .where(and(eq(projects.ownerId, userId), eq(projects.archived, false)))
    .groupBy(projects.id)
    .orderBy(desc(projects.updatedAt));
  return rows.map(openProject).map((p) => ({ id: p.id, name: p.name, description: p.description, updatedAt: p.updatedAt, conversations: p.conversations }));
}

export async function getProject(userId: string, id: string) {
  const [p] = await db.select().from(projects).where(and(eq(projects.id, id), eq(projects.ownerId, userId))).limit(1);
  if (!p) throw Errors.notFound("Project");
  return openProject(p);
}

export async function findProject(userId: string, id: string) {
  const [p] = await db.select().from(projects).where(and(eq(projects.id, id), eq(projects.ownerId, userId))).limit(1);
  return p ? openProject(p) : null;
}

export async function createProject(userId: string, d: Required<Pick<ProjectInput, "name">> & ProjectInput) {
  const [p] = await db.insert(projects).values({ ownerId: userId, name: "", ...seal(userId, d) }).returning();
  await db.insert(projectMembers).values({ projectId: p.id, userId, role: "owner" });
  return openProject(p);
}

export async function updateProject(userId: string, id: string, d: ProjectInput & { archived?: boolean; settings?: Record<string, unknown> }) {
  const { archived, settings, ...text } = d;
  const [p] = await db
    .update(projects)
    .set({ ...seal(userId, text), ...(archived !== undefined ? { archived } : {}), ...(settings !== undefined ? { settings } : {}) })
    .where(and(eq(projects.id, id), eq(projects.ownerId, userId)))
    .returning();
  if (!p) throw Errors.notFound("Project");
  return openProject(p);
}

export async function deleteProject(userId: string, id: string) {
  const r = await db.delete(projects).where(and(eq(projects.id, id), eq(projects.ownerId, userId))).returning({ id: projects.id });
  if (!r.length) throw Errors.notFound("Project");
}
