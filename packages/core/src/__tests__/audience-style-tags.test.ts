import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as atomic from "../utils/atomic-file-set.js";
import { ProjectConfigSchema } from "../models/project.js";
import {
  createAudienceStyleTag, listAudienceStyleTags, readAudienceStyleTag,
  updateAudienceStyleTag, deleteAudienceStyleTag, copyAudienceStyleTagToProject,
} from "../audience-style/store.js";

const tag = {
  id: "test-tag", name: " Test tag ", kind: "audience", language: "zh",
  description: "A description: # & 'quoted'\nSecond line",
  readerExperience: "First line\n第二行", narrativeStyle: "Quiet\nMeasured",
  relationshipAndElements: [" relationship ", "", "element: # &"],
  avoidElements: [" avoid ", "   "], creativeBrief: "# Brief\n\n- One\n- Two\n---\nEnd",
};

describe("Audience/style tag storage", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "inkos-tags-")); });
  afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

  it("creates, lists, reads, updates and deletes all ten fields without time metadata", async () => {
    expect(await listAudienceStyleTags(root)).toEqual([]);
    const created = await createAudienceStyleTag(root, tag);
    expect(created).toEqual({ ...tag, name: "Test tag", relationshipAndElements: ["relationship", "element: # &"], avoidElements: ["avoid"] });
    expect(await readAudienceStyleTag(root, tag.id)).toEqual(created);
    expect(await listAudienceStyleTags(root)).toEqual([created]);
    const raw = await readFile(join(root, "audience-style-tags", `${tag.id}.md`), "utf-8");
    expect(raw).not.toMatch(/createdAt|updatedAt|created_at|updated_at/);
    expect(Object.keys(created)).toHaveLength(10);
    const updated = await updateAudienceStyleTag(root, tag.id, { ...created, kind: "style", name: "Edited", creativeBrief: "## Edited\nText" });
    expect(await readAudienceStyleTag(root, tag.id)).toEqual(updated);
    await deleteAudienceStyleTag(root, tag.id);
    expect(await listAudienceStyleTags(root)).toEqual([]);
    await expect(readAudienceStyleTag(root, tag.id)).rejects.toMatchObject({ code: "notFound" });
    await expect(updateAudienceStyleTag(root, tag.id, created)).rejects.toMatchObject({ code: "notFound" });
    await expect(deleteAudienceStyleTag(root, tag.id)).rejects.toMatchObject({ code: "notFound" });
  });

  it("rejects duplicate ids and names in the same language, including edit collisions", async () => {
    await createAudienceStyleTag(root, tag);
    await expect(createAudienceStyleTag(root, tag)).rejects.toMatchObject({ code: "duplicateId" });
    await expect(createAudienceStyleTag(root, { ...tag, id: "another" })).rejects.toMatchObject({ code: "duplicateName" });
    await createAudienceStyleTag(root, { ...tag, id: "english", language: "en" });
    await createAudienceStyleTag(root, { ...tag, id: "another", name: "Another" });
    await expect(updateAudienceStyleTag(root, "another", { ...tag, id: "another" })).rejects.toMatchObject({ code: "duplicateName" });
    await expect(updateAudienceStyleTag(root, tag.id, { ...tag, id: "changed" })).rejects.toMatchObject({ code: "immutableId" });
  });

  it("serializes concurrent creates so uniqueness cannot race", async () => {
    const results = await Promise.allSettled([createAudienceStyleTag(root, tag), createAudienceStyleTag(root, tag)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await listAudienceStyleTags(root)).toHaveLength(1);
  });

  it.each([
    [{ ...tag, kind: "genre" }, "invalidKind"], [{ ...tag, id: "../bad" }, "invalidId"],
    [{ ...tag, name: "   " }, "nameRequired"], [{ ...tag, language: "invalid" }, "invalidLanguage"],
    [{ ...tag, avoidElements: "bad" }, "invalidData"],
  ])("rejects invalid input %# without saving", async (input, code) => {
    await expect(createAudienceStyleTag(root, input)).rejects.toMatchObject({ code });
    expect(await listAudienceStyleTags(root)).toEqual([]);
  });

  it("reads missing optional fields and strips unknown metadata using existing schema policy", async () => {
    await mkdir(join(root, "audience-style-tags"));
    await writeFile(join(root, "audience-style-tags", "legacy.md"), "---\nid: legacy\nname: Legacy\nkind: style\ncreatedAt: ignored\n---\n");
    expect(await readAudienceStyleTag(root, "legacy")).toEqual({ id: "legacy", name: "Legacy", kind: "style", language: "zh" });
  });

  it("reports create/update/delete storage failures without losing saved data", async () => {
    const commit = vi.spyOn(atomic, "commitAtomicFileSet");
    commit.mockRejectedValueOnce(new Error("Storage unavailable"));
    await expect(createAudienceStyleTag(root, tag)).rejects.toMatchObject({ code: "saveFailed" });
    expect(await listAudienceStyleTags(root)).toEqual([]);
    const saved = await createAudienceStyleTag(root, tag);
    commit.mockRejectedValueOnce(new Error("Storage unavailable"));
    await expect(updateAudienceStyleTag(root, tag.id, { ...saved, name: "Changed" })).rejects.toMatchObject({ code: "saveFailed" });
    commit.mockRejectedValueOnce(new Error("Storage unavailable"));
    await expect(deleteAudienceStyleTag(root, tag.id)).rejects.toMatchObject({ code: "deleteFailed" });
    expect(await readAudienceStyleTag(root, tag.id)).toEqual(saved);
  });

  it("reports corrupt data rather than silently hiding it", async () => {
    await mkdir(join(root, "audience-style-tags"));
    await writeFile(join(root, "audience-style-tags", "broken.md"), "invalid");
    await expect(listAudienceStyleTags(root)).rejects.toMatchObject({ code: "invalidData" });
  });
});

describe("Audience/style project snapshots", () => {
  let root: string;
  const project = { name: "Old project", version: "0.1.0", llm: { provider: "openai", model: "test", baseUrl: "https://example.com/v1" }, custom: { keep: true }, genre: "existing" };
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-tag-project-"));
    await writeFile(join(root, "inkos.json"), JSON.stringify(project));
  });
  afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
  const readProject = () => readFile(join(root, "inkos.json"), "utf-8").then(JSON.parse);

  it("reads old projects without adding an empty field and accepts snapshot configuration", async () => {
    expect(ProjectConfigSchema.parse(project).audienceStyleTags).toBeUndefined();
    expect(await readProject()).not.toHaveProperty("audienceStyleTags");
    const saved = await createAudienceStyleTag(root, tag);
    expect(ProjectConfigSchema.parse({ ...project, audienceStyleTags: [saved] }).audienceStyleTags).toEqual([saved]);
  });

  it("copies multiple tags idempotently, preserves genre and unknown config, and keeps snapshots after edit/delete", async () => {
    const first = await createAudienceStyleTag(root, tag);
    const second = await createAudienceStyleTag(root, { ...tag, id: "second", name: "Second", kind: "style" });
    const results = await Promise.all([copyAudienceStyleTagToProject(root, first.id), copyAudienceStyleTagToProject(root, second.id)]);
    expect(results.every((result) => !result.alreadyCopied)).toBe(true);
    expect((await copyAudienceStyleTagToProject(root, first.id)).alreadyCopied).toBe(true);
    expect(await readProject()).toEqual({ ...project, audienceStyleTags: [first, second] });
    await updateAudienceStyleTag(root, first.id, { ...first, name: "New source" });
    await deleteAudienceStyleTag(root, first.id);
    expect(await readProject()).toEqual({ ...project, audienceStyleTags: [first, second] });
  });

  it("reports missing tag/project and corrupt project without overwriting config", async () => {
    await expect(copyAudienceStyleTagToProject(root, "missing")).rejects.toMatchObject({ code: "notFound" });
    await createAudienceStyleTag(root, tag);
    await rm(join(root, "inkos.json"));
    await expect(copyAudienceStyleTagToProject(root, tag.id)).rejects.toMatchObject({ code: "projectNotFound" });
    await writeFile(join(root, "inkos.json"), "corrupt");
    await expect(copyAudienceStyleTagToProject(root, tag.id)).rejects.toMatchObject({ code: "invalidProject" });
    expect(await readFile(join(root, "inkos.json"), "utf-8")).toBe("corrupt");
  });

  it("rejects corrupt snapshot configuration without replacing it", async () => {
    await createAudienceStyleTag(root, tag);
    const corrupt = { ...project, audienceStyleTags: ["not a snapshot"] };
    await writeFile(join(root, "inkos.json"), JSON.stringify(corrupt));
    await expect(copyAudienceStyleTagToProject(root, tag.id)).rejects.toMatchObject({ code: "invalidProject" });
    expect(await readProject()).toEqual(corrupt);
  });

  it("reports failed snapshot persistence and preserves original project", async () => {
    await createAudienceStyleTag(root, tag);
    vi.spyOn(atomic, "commitAtomicFileSet").mockRejectedValueOnce(new Error("Storage unavailable"));
    await expect(copyAudienceStyleTagToProject(root, tag.id)).rejects.toMatchObject({ code: "copyFailed" });
    expect(await readProject()).toEqual(project);
  });
});
