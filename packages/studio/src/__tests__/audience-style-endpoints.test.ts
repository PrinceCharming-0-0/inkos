import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { createStudioServer } from "../api/server.js";

const tag = { id: "test-tag", name: "Test", kind: "audience", language: "en", creativeBrief: "# Brief\nText" };
describe("Studio audience/style endpoints", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-tags-api-"));
    await writeFile(join(root, "inkos.json"), JSON.stringify({ language: "en", genre: "keep", custom: 42 }));
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });
  function request(path = "", method = "GET", body?: unknown) {
    return createStudioServer({} as never, root).request(`/api/v1/audience-style-tags${path}`, {
      method, headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}),
    });
  }
  it("lists, creates, reads, updates, filters and deletes tags", async () => {
    expect(await (await request()).json()).toEqual({ tags: [] });
    expect((await request("/create", "POST", tag)).status).toBe(201);
    expect(await (await request(`/${tag.id}`)).json()).toEqual({ tag });
    expect((await request(`/${tag.id}`, "PUT", { ...tag, kind: "style" })).status).toBe(200);
    expect(await (await request("?kind=audience")).json()).toEqual({ tags: [] });
    expect((await (await request("?kind=style")).json()).tags).toHaveLength(1);
    expect((await request(`/${tag.id}`, "DELETE")).status).toBe(200);
    expect((await request(`/${tag.id}`)).status).toBe(404);
  });
  it("returns structured localized validation and conflict errors", async () => {
    await request("/create", "POST", tag);
    const duplicate = await request("/create", "POST", tag);
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toEqual({ error: { code: "duplicateId", message: "This ID already exists. Use a different ID." } });
    const name = await request("/create", "POST", { ...tag, id: "other" });
    expect(name.status).toBe(409);
    expect((await name.json()).error.code).toBe("duplicateName");
    for (const [input, code] of [[{ ...tag, kind: "invalid" }, "invalidKind"], [{ ...tag, id: "../bad" }, "invalidId"], [{ ...tag, name: " " }, "nameRequired"]] as const) {
      const response = await request("/create", "POST", input);
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe(code);
    }
    expect((await request("?kind=invalid")).status).toBe(400);
    await writeFile(join(root, "inkos.json"), JSON.stringify({ language: "zh" }));
    expect((await (await request("/missing")).json()).error.message).toBe("标签不存在或已被删除。");
  });
  it("copies snapshots idempotently, preserves project config and retains snapshots on delete", async () => {
    await request("/create", "POST", tag);
    await request("/create", "POST", { ...tag, id: "second", name: "Second", kind: "style" });
    expect(await (await request(`/${tag.id}/copy`, "POST")).json()).toEqual({ ok: true, alreadyCopied: false });
    expect(await (await request(`/${tag.id}/copy`, "POST")).json()).toEqual({ ok: true, alreadyCopied: true });
    await request("/second/copy", "POST");
    const projectUpdate = await createStudioServer({} as never, root).request("/api/v1/project", {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ language: "zh" }),
    });
    expect(projectUpdate.status).toBe(200);
    await request(`/${tag.id}`, "DELETE");
    const config = JSON.parse(await readFile(join(root, "inkos.json"), "utf-8"));
    expect(config).toMatchObject({ genre: "keep", custom: 42, language: "zh" });
    expect(config.audienceStyleTags).toHaveLength(2);
    expect(config.audienceStyleTags[0]).toEqual(tag);
    expect((await request("/missing/copy", "POST")).status).toBe(404);
    await rm(join(root, "inkos.json"));
    const missing = await request("/second/copy", "POST");
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.code).toBe("projectNotFound");
  });
  it("reports malformed JSON, missing update/delete targets and storage failures", async () => {
    const app = createStudioServer({} as never, root);
    const malformed = await app.request("/api/v1/audience-style-tags/create", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" });
    expect(malformed.status).toBe(400);
    expect((await request("/missing", "PUT", tag)).status).toBe(404);
    expect((await request("/missing", "DELETE")).status).toBe(404);
    await writeFile(join(root, "audience-style-tags"), "blocks directory");
    expect((await request()).status).toBe(500);
  });
});
