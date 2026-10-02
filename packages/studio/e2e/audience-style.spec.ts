import { test, expect, type Page } from "@playwright/test";

interface Tag {
  id: string; name: string; kind: "audience" | "style"; language: string;
  description?: string; readerExperience?: string; narrativeStyle?: string;
  relationshipAndElements?: string[]; avoidElements?: string[]; creativeBrief?: string;
}
const sample: Tag = { id: "tag-a", name: "Audience test", kind: "audience", language: "zh", description: "Description", creativeBrief: "# Test brief\n\n- Markdown item" };

async function mockApi(page: Page, initial: Tag[] = [], initialLanguage = "en") {
  const state = {
    tags: [...initial], language: initialLanguage, copies: new Set<string>(), fail: "", deleted: 0,
    pendingLoad: null as Promise<void> | null,
  };
  const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/api/v1", "");
    const method = request.method();
    if (path === "/events") return route.fulfill({ status: 200, contentType: "text/event-stream", body: "" });
    if (path === "/project") {
      if (method === "PUT") state.language = request.postDataJSON().language;
      return route.fulfill(json({ language: state.language, languageExplicit: true }));
    }
    if (path === "/books") return route.fulfill(json({ books: [] }));
    if (path === "/interactive-films") return route.fulfill(json({ films: [] }));
    if (path === "/sessions") return route.fulfill(json({ sessions: [] }));
    if (path === "/services") return route.fulfill(json({ services: [] }));
    if (path === "/skills") return route.fulfill(json({ skills: [] }));
    if (path.startsWith("/audience-style-tags")) {
      if (method === "GET" && state.pendingLoad) await state.pendingLoad;
      if (state.fail === method || (state.fail === "copy" && path.endsWith("/copy"))) return route.abort("failed");
      if (path === "/audience-style-tags") return route.fulfill(json({ tags: state.tags }));
      if (path === "/audience-style-tags/create") {
        const tag = request.postDataJSON() as Tag;
        state.tags.push(tag);
        return route.fulfill(json({ tag }, 201));
      }
      const id = decodeURIComponent(path.split("/")[2]);
      const tag = state.tags.find((tag) => tag.id === id);
      if (!tag) return route.fulfill(json({ error: { code: "notFound", message: "Tag not found or already deleted." } }, 404));
      if (path.endsWith("/copy")) {
        const alreadyCopied = state.copies.has(id);
        state.copies.add(id);
        return route.fulfill(json({ ok: true, alreadyCopied }));
      }
      if (method === "PUT") {
        const next = request.postDataJSON() as Tag;
        state.tags = state.tags.map((item) => item.id === id ? next : item);
        return route.fulfill(json({ tag: next }));
      }
      if (method === "DELETE") {
        state.deleted++;
        state.tags = state.tags.filter((item) => item.id !== id);
        return route.fulfill(json({ ok: true }));
      }
      return route.fulfill(json({ tag }));
    }
    return route.fulfill(json({}));
  });
  return state;
}

test.describe("Audience/style Studio", () => {
  test("menu, language switching, type filters and empty state", async ({ page }) => {
    const state = await mockApi(page, [sample, { ...sample, id: "style-b", name: "Style test", kind: "style", language: "en" }]);
    await page.goto("/#/audience-style");
    await expect(page.getByRole("heading", { name: "Audience/Style", exact: true })).toBeVisible();
    await expect(page.locator("aside").getByRole("button", { name: "Audience/Style", exact: true })).toHaveClass(/shadow-sm/);
    await page.getByLabel("Filter by type").selectOption("style");
    await expect(page.getByRole("article", { name: "Style test" })).toBeVisible();
    await expect(page.getByRole("article", { name: sample.name })).toHaveCount(0);
    await page.getByRole("button", { name: "中", exact: true }).click();
    await expect(page.getByRole("heading", { name: "受众与风格", exact: true })).toBeVisible();
    await expect(page.locator("aside").getByText("受众与风格", { exact: true })).toBeVisible();
    await page.getByLabel("按类型筛选").selectOption("audience");
    await expect(page.getByRole("article", { name: sample.name })).toBeVisible();
    state.tags = [];
    await page.reload();
    await expect(page.getByText("暂无受众与风格标签，创建第一个标签开始。")).toBeVisible();
    await page.getByRole("button", { name: "新建标签", exact: true }).last().click();
    await expect(page.getByRole("combobox", { name: "内容语言", exact: true })).toHaveValue("zh");
  });

  test("all ten form fields, list editing, validation, detail Markdown and immutable id", async ({ page }) => {
    const state = await mockApi(page, [sample]);
    await page.goto("/#/audience-style/new");
    await expect(page.getByRole("combobox", { name: "Content Language", exact: true })).toHaveValue("en");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("Enter a valid ID");
    await page.getByRole("textbox", { name: /^ID/ }).fill("tag-a");
    await page.getByLabel("Name", { exact: true }).fill("New tag");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("This ID already exists");
    await page.getByRole("textbox", { name: /^ID/ }).fill("new-tag");
    await page.getByLabel("Name", { exact: true }).fill(sample.name);
    await page.getByRole("combobox", { name: "Content Language", exact: true }).selectOption("zh");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("already exists in the same content language");
    await page.getByLabel("Name", { exact: true }).fill("  New tag  ");
    await page.getByRole("combobox", { name: "Type", exact: true }).selectOption("style");
    await page.getByLabel("Description", { exact: true }).fill("Description\nSecond line");
    await page.getByLabel("Readers and Reading Experience", { exact: true }).fill("Readers\nExperience");
    await page.getByLabel("Narrative Style", { exact: true }).fill("Style\nPacing");
    await page.getByLabel("Creative Brief (Markdown)", { exact: false }).fill("# Preview\n\n- Brief item");
    const relationships = page.locator("fieldset").filter({ has: page.locator("legend", { hasText: "Relationships and Common Elements" }) }).last();
    await relationships.getByRole("button", { name: "Add Item" }).click();
    await page.getByRole("textbox", { name: "Relationships and Common Elements 1", exact: true }).fill("  Relationship  ");
    await relationships.getByRole("button", { name: "Add Item" }).click();
    await page.getByRole("textbox", { name: "Relationships and Common Elements 2", exact: true }).fill("Remove this");
    await page.getByRole("button", { name: "Remove Item Relationships and Common Elements 2", exact: true }).click();
    const avoid = page.locator("fieldset").filter({ has: page.locator("legend", { hasText: "Elements to Avoid or Limit" }) }).last();
    await avoid.getByRole("button", { name: "Add Item" }).click();
    await page.getByRole("textbox", { name: "Elements to Avoid or Limit 1", exact: true }).fill("  Avoid  ");
    await avoid.getByRole("button", { name: "Add Item" }).click();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("Tag saved.");
    expect(state.tags.at(-1)).toEqual({ id: "new-tag", name: "New tag", kind: "style", language: "zh", description: "Description\nSecond line", readerExperience: "Readers\nExperience", narrativeStyle: "Style\nPacing", relationshipAndElements: ["Relationship"], avoidElements: ["Avoid"], creativeBrief: "# Preview\n\n- Brief item" });
    await page.getByRole("button", { name: "View Details" }).click();
    await expect(page.getByRole("heading", { name: "Preview", exact: true })).toBeVisible();
    await expect(page.getByRole("listitem").filter({ hasText: "Relationship" })).toBeVisible();
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await expect(page.getByRole("textbox", { name: /^ID/ })).toBeDisabled();
    await page.getByLabel("Name", { exact: true }).fill("Edited");
    state.fail = "PUT";
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("alert")).toHaveText("Failed to save the tag. Please retry.");
    state.fail = "";
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("Tag saved.");
    expect(state.tags.at(-1)?.name).toBe("Edited");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Edited", exact: true })).toBeVisible();
  });

  test("delete confirmation/cancel/failure and copy/idempotence/failure from list and detail", async ({ page }) => {
    const state = await mockApi(page, [sample]);
    await page.goto("/#/audience-style");
    const article = page.getByRole("article", { name: sample.name });
    await article.getByRole("button", { name: "Copy to Project" }).click();
    await expect(page.getByRole("status")).toHaveText("Tag copied to the current project.");
    await article.getByRole("button", { name: "Copy to Project" }).click();
    await expect(page.getByRole("status")).toContainText("no duplicate was added");
    state.fail = "copy";
    await article.getByRole("button", { name: "Copy to Project" }).click();
    await expect(page.getByRole("alert")).toHaveText("Failed to copy the tag. Please retry.");
    state.fail = "";
    await article.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page.getByText(`Delete tag “${sample.name}”? Snapshots already copied to the project will be kept.`)).toBeVisible();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(state.deleted).toBe(0);
    await article.getByRole("button", { name: sample.name, exact: true }).click();
    await page.getByRole("button", { name: "Copy to Project" }).click();
    await expect(page.getByRole("status")).toContainText("already in the project");
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    state.fail = "DELETE";
    await page.getByRole("button", { name: "Delete", exact: true }).last().click();
    await expect(page.getByRole("alert")).toHaveText("Failed to delete the tag. Please retry.");
    state.fail = "";
    page.on("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByRole("button", { name: "Delete", exact: true }).last().click();
    await expect(page).toHaveURL(/#\/audience-style$/);
    await expect(page.getByText("No audience/style tags yet. Create your first tag to get started.")).toBeVisible();
    expect(state.copies.size).toBe(1);
    expect(state.deleted).toBe(1);
  });

  test("loading remains explicit until the API returns", async ({ page }) => {
    const state = await mockApi(page, [sample]);
    let release!: () => void;
    state.pendingLoad = new Promise<void>((resolve) => { release = resolve; });
    await page.goto("/#/audience-style");
    await expect(page.getByText("Loading...", { exact: true })).toBeVisible();
    release();
    state.pendingLoad = null;
    await expect(page.getByRole("article", { name: sample.name })).toBeVisible();
  });

  test("list/detail load failure and retry, missing tag, create cancellation and save failure", async ({ page }) => {
    const state = await mockApi(page, [sample]);
    state.fail = "GET";
    await page.goto("/#/audience-style");
    await expect(page.getByRole("alert")).toContainText("Failed to load tags");
    state.fail = "";
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(page.getByRole("article", { name: sample.name })).toBeVisible();
    await page.goto("/#/audience-style/tags/missing");
    await expect(page.getByRole("alert")).toContainText("Tag not found or already deleted");
    state.fail = "GET";
    await page.goto("/#/audience-style/tags/tag-a");
    await expect(page.getByRole("alert")).toContainText("Failed to load tags");
    state.fail = "";
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(page.getByRole("heading", { name: sample.name, exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Back to List" }).click();
    await page.getByRole("button", { name: "New Tag", exact: true }).click();
    await page.getByRole("textbox", { name: /^ID/ }).fill("new-tag");
    await page.getByLabel("Name", { exact: true }).fill("New tag");
    state.fail = "POST";
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("alert")).toHaveText("Failed to save the tag. Please retry.");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(state.tags).toHaveLength(1);
  });
});
