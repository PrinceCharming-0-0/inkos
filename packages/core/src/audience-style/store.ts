import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import yaml from "js-yaml";
import { AudienceStyleTagSchema, isSafeAudienceStyleTagId, type AudienceStyleTag } from "../models/audience-style-tag.js";
import { commitAtomicFileSet } from "../utils/atomic-file-set.js";

export type AudienceStyleErrorCode =
  | "invalidId" | "nameRequired" | "invalidKind" | "invalidLanguage" | "invalidData"
  | "duplicateId" | "duplicateName" | "immutableId" | "notFound" | "projectNotFound"
  | "invalidProject" | "loadFailed" | "saveFailed" | "deleteFailed" | "copyFailed";

export class AudienceStyleError extends Error {
  constructor(readonly code: AudienceStyleErrorCode, readonly status: number) {
    super(code);
    this.name = "AudienceStyleError";
  }
}

const DIRECTORY = "audience-style-tags";
const writes = new Map<string, Promise<unknown>>();

// Serialize mutations to protect name/id uniqueness and project read-modify-write.
async function serialize<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const previous = writes.get(root) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);
  writes.set(root, next);
  try { return await next; }
  finally { if (writes.get(root) === next) writes.delete(root); }
}

function validateId(id: string): void {
  if (!isSafeAudienceStyleTagId(id) || id !== id.trim()) throw new AudienceStyleError("invalidId", 400);
}

function parseInput(input: unknown): AudienceStyleTag {
  const result = AudienceStyleTagSchema.safeParse(input);
  if (result.success) return result.data;
  const field = result.error.issues[0]?.path[0];
  const code = field === "id" ? "invalidId" : field === "name" ? "nameRequired"
    : field === "kind" ? "invalidKind" : field === "language" ? "invalidLanguage" : "invalidData";
  throw new AudienceStyleError(code, 400);
}

function filePath(root: string, id: string): string {
  validateId(id);
  return join(root, DIRECTORY, `${id}.md`);
}

export async function readAudienceStyleTag(root: string, id: string): Promise<AudienceStyleTag> {
  const path = filePath(root, id);
  let raw: string;
  try { raw = await readFile(path, "utf-8"); }
  catch (error) {
    throw new AudienceStyleError((error as NodeJS.ErrnoException).code === "ENOENT" ? "notFound" : "loadFailed",
      (error as NodeJS.ErrnoException).code === "ENOENT" ? 404 : 500);
  }
  try {
    const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/);
    if (!match) throw new Error();
    const tag = AudienceStyleTagSchema.parse(yaml.load(match[1]));
    if (tag.id !== id) throw new Error();
    return tag;
  } catch { throw new AudienceStyleError("invalidData", 500); }
}

export async function listAudienceStyleTags(root: string): Promise<AudienceStyleTag[]> {
  let files: string[];
  try { files = await readdir(join(root, DIRECTORY)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new AudienceStyleError("loadFailed", 500);
  }
  return Promise.all(files.filter((file) => file.endsWith(".md")).sort()
    .map((file) => readAudienceStyleTag(root, file.slice(0, -3))));
}

async function save(root: string, tag: AudienceStyleTag): Promise<void> {
  try {
    await commitAtomicFileSet({ rootDir: root, writes: [{
      relativePath: `${DIRECTORY}/${tag.id}.md`,
      content: `---\n${yaml.dump(tag, { noRefs: true, lineWidth: -1 })}---\n`,
    }] });
  } catch { throw new AudienceStyleError("saveFailed", 500); }
}

async function assertUnique(root: string, tag: AudienceStyleTag, edit: boolean): Promise<void> {
  const tags = await listAudienceStyleTags(root);
  if (!edit && tags.some((other) => other.id === tag.id)) throw new AudienceStyleError("duplicateId", 409);
  if (tags.some((other) => other.id !== tag.id && other.language === tag.language && other.name === tag.name)) {
    throw new AudienceStyleError("duplicateName", 409);
  }
}

export function createAudienceStyleTag(root: string, input: unknown): Promise<AudienceStyleTag> {
  return serialize(root, async () => {
    const tag = parseInput(input);
    await assertUnique(root, tag, false);
    await save(root, tag);
    return tag;
  });
}

export function updateAudienceStyleTag(root: string, id: string, input: unknown): Promise<AudienceStyleTag> {
  return serialize(root, async () => {
    await readAudienceStyleTag(root, id);
    const tag = parseInput(input);
    if (tag.id !== id) throw new AudienceStyleError("immutableId", 400);
    await assertUnique(root, tag, true);
    await save(root, tag);
    return tag;
  });
}

export function deleteAudienceStyleTag(root: string, id: string): Promise<void> {
  return serialize(root, async () => {
    await readAudienceStyleTag(root, id);
    try { await commitAtomicFileSet({ rootDir: root, writes: [], deletes: [`${DIRECTORY}/${id}.md`] }); }
    catch { throw new AudienceStyleError("deleteFailed", 500); }
    // Like genre deletion, do not rewrite project associations. Copied snapshots survive.
  });
}

export function copyAudienceStyleTagToProject(root: string, id: string): Promise<{ alreadyCopied: boolean }> {
  return serialize(root, async () => {
    const tag = await readAudienceStyleTag(root, id);
    let content: string;
    try { content = await readFile(join(root, "inkos.json"), "utf-8"); }
    catch (error) {
      throw new AudienceStyleError((error as NodeJS.ErrnoException).code === "ENOENT" ? "projectNotFound" : "copyFailed",
        (error as NodeJS.ErrnoException).code === "ENOENT" ? 404 : 500);
    }
    let raw: Record<string, unknown>;
    let snapshots: AudienceStyleTag[];
    try {
      raw = JSON.parse(content);
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error();
      snapshots = raw.audienceStyleTags === undefined ? [] : AudienceStyleTagSchema.array().parse(raw.audienceStyleTags);
    } catch { throw new AudienceStyleError("invalidProject", 500); }
    if (snapshots.some((snapshot) => snapshot.id === tag.id)) return { alreadyCopied: true };
    // Preserve unknown project fields and existing snapshots verbatim.
    raw.audienceStyleTags = [...(raw.audienceStyleTags as unknown[] | undefined ?? []), tag];
    try {
      await commitAtomicFileSet({ rootDir: root, writes: [{ relativePath: "inkos.json", content: JSON.stringify(raw, null, 2) }] });
    } catch { throw new AudienceStyleError("copyFailed", 500); }
    return { alreadyCopied: false };
  });
}
