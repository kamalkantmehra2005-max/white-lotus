/**
 * Associated-data (AAD) labels for every encrypted field, in one place so they can't drift.
 * A ciphertext only decrypts with the exact label it was written with — so data can't be moved between
 * users/conversations/fields in the database without detection.
 *
 * What is encrypted (and why) — see docs/CONFIDENTIALITY.md:
 *   conversations.title ................ may name clients/matters
 *   messages.content, messages.metadata  the confidential core (questions, answers, sources, search queries)
 *   document_chunks.content ............ extracted document text
 *   documents.title, attachments.file_name  file names often identify matters
 *   projects.name / description / instructions
 *   memories.content, user_settings.custom_instructions / response_style
 *   search_history.query ............... what you searched for
 * Not encrypted (needed for login, lookups or ordering): emails, user names, timestamps, ids, sizes, MIME types.
 */
export const AAD = {
  title: (userId: string) => `${userId}:title`,
  message: (conversationId: string) => `conv:${conversationId}:msg`,
  messageMeta: (conversationId: string) => `conv:${conversationId}:meta`,
  chunk: (userId: string) => `${userId}:chunk`,
  file: (userId: string) => `${userId}:file`,
  project: (userId: string) => `${userId}:proj`,
  projectName: (userId: string) => `${userId}:projname`,
  projectDesc: (userId: string) => `${userId}:projdesc`,
  memory: (userId: string) => `${userId}:mem`,
  customInstructions: (userId: string) => `${userId}:ci`,
  responseStyle: (userId: string) => `${userId}:rs`,
  search: (userId: string) => `${userId}:search`,
} as const;
