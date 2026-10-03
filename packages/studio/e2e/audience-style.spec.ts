import { test, expect, type Page } from "@playwright/test";
import { routeToHash, type HashRoute } from "../src/hooks/use-hash-route";

interface Tag {
  id: string; name: string; kind: "audience" | "style"; language: string; source?: "builtin" | "project";
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
      return route.fulfill(json({ language: state.language, languageExplicit: true, projectRoot: "/test-project" }));
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
  test("Sidebar always opens the empty list, including from a missing detail", async ({ page }) => {
    await mockApi(page, [], "zh");
    const listHash = routeToHash({ page: "audience-style" });
    const menu = page.locator("aside").getByRole("button", { name: "受众与风格", exact: true });
    await page.goto(`/${routeToHash({ page: "chat" })}`);
    await menu.click();
    await expect(page).toHaveURL((url) => url.hash === listHash);
    await expect(page.getByText("暂无受众与风格标签，创建第一个标签开始。", { exact: true })).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await page.goto(`/${routeToHash({ page: "audience-style", tagId: "missing" })}`);
    await expect(page.getByRole("alert")).toContainText("标签不存在或已被删除");
    await menu.click();
    await expect(page).toHaveURL((url) => url.hash === listHash);
    await expect(page.getByText("暂无受众与风格标签，创建第一个标签开始。", { exact: true })).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
  });

  const menuRoutes: { name: string; route: HashRoute }[] = [
    { name: "list", route: { page: "audience-style" } },
    { name: "create", route: { page: "audience-style", mode: "create" } },
    { name: "encoded detail", route: { page: "audience-style", tagId: "标签 new" } },
    { name: "edit", route: { page: "audience-style", tagId: "标签 new", mode: "edit" } },
  ];
  for (const { name, route } of menuRoutes) {
    test(`Sidebar stays active on ${name} and returns to list`, async ({ page }) => {
      await mockApi(page, [{ ...sample, id: "标签 new" }]);
      await page.goto(`/${routeToHash(route)}`);
      const menu = page.locator("aside").getByRole("button", { name: "Audience/Style", exact: true });
      await expect(menu).toHaveClass(/shadow-sm/);
      if (route.page === "audience-style" && route.mode) {
        await expect(page.getByLabel("Name", { exact: true })).toHaveValue(route.mode === "edit" ? sample.name : "");
      } else if (route.page === "audience-style" && route.tagId) {
        await expect(page.getByRole("heading", { name: sample.name, exact: true })).toBeVisible();
      } else {
        await expect(page.getByRole("article", { name: sample.name })).toBeVisible();
      }
      await menu.click();
      await expect(page).toHaveURL((url) => url.hash === routeToHash({ page: "audience-style" }));
      await expect(page.getByRole("article", { name: sample.name })).toBeVisible();
      await expect(menu).toHaveClass(/shadow-sm/);
    });
  }

  test("new tag save dialog returns to the list and has no old detail button", async ({ page }) => {
    const state = await mockApi(page);
    await page.goto("/#/audience-style/new");
    await page.getByRole("button", { name: "中", exact: true }).click();
    await page.getByRole("textbox", { name: /^ID/ }).fill("saved-dialog-tag");
    await page.getByLabel("名称", { exact: true }).fill("弹窗标签");
    state.fail = "POST";
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    state.fail = "";
    await page.getByRole("button", { name: "保存", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "标签已保存。" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "查看详情", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("button", { name: "查看详情", exact: true })).toHaveCount(0);
    await page.locator("aside").getByRole("button", { name: "受众与风格", exact: true }).click();
    await page.getByRole("button", { name: "新建标签", exact: true }).click();
    await page.getByRole("textbox", { name: /^ID/ }).fill("return-list-tag");
    await page.getByLabel("名称", { exact: true }).fill("返回列表标签");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await dialog.getByRole("button", { name: "返回列表主页", exact: true }).click();
    await expect(page).toHaveURL(/#\/audience-style$/);
    await expect(page.getByRole("article", { name: "返回列表标签" })).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("list metadata displays ID, language and builtin/project source", async ({ page }) => {
    await mockApi(page, [
      { ...sample, source: "builtin" },
      { ...sample, id: "project-style", name: "Project style", language: "en", source: "project" },
      { ...sample, id: "legacy-style", name: "Legacy style", language: "en" },
    ]);
    await page.goto("/#/audience-style");
    await expect(page.getByRole("article", { name: sample.name }).getByText(`${sample.id} · ${sample.language} · builtin`, { exact: true })).toBeVisible();
    await expect(page.getByRole("article", { name: "Project style" }).getByText("project-style · en · project", { exact: true })).toBeVisible();
    await expect(page.getByRole("article", { name: "Legacy style" }).getByText("legacy-style · en · project", { exact: true })).toBeVisible();
  });

  test("menu, language switching, type filters and empty state", async ({ page }) => {
    const state = await mockApi(page, [sample, { ...sample, id: "style-b", name: "Style test", kind: "style", language: "en" }]);
    await page.goto("/#/audience-style");
    await expect(page.getByRole("heading", { name: "Audience/Style", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "New Tag", exact: true })).toHaveCount(1);
    await expect(page.locator("aside").getByRole("button", { name: "Audience/Style", exact: true })).toHaveClass(/shadow-sm/);
    await page.getByLabel("Filter by type").selectOption("style");
    await expect(page.getByRole("article", { name: "Style test" })).toBeVisible();
    await expect(page.getByRole("article", { name: sample.name })).toHaveCount(0);
    await page.getByLabel("Filter by type").selectOption("audience");
    state.tags = state.tags.filter((tag) => tag.kind === "audience");
    await page.reload();
    await page.getByLabel("Filter by type").selectOption("style");
    await expect(page.getByText("No tags match this filter.", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "New Tag", exact: true })).toHaveCount(1);
    await page.getByRole("button", { name: "中", exact: true }).click();
    await expect(page.getByRole("heading", { name: "受众与风格", exact: true })).toBeVisible();
    await expect(page.locator("aside").getByText("受众与风格", { exact: true })).toBeVisible();
    await page.getByLabel("按类型筛选").selectOption("audience");
    await expect(page.getByRole("article", { name: sample.name })).toBeVisible();
    state.tags = [];
    await page.reload();
    await expect(page.getByText("暂无受众与风格标签，创建第一个标签开始。")).toBeVisible();
    await expect(page.getByRole("button", { name: "新建标签", exact: true })).toHaveCount(2);
    // The second button is the explicit action inside the empty list panel.
    await page.getByRole("button", { name: "新建标签", exact: true }).last().click();
    await expect(page).toHaveURL(/#\/audience-style\/new$/);
    await expect(page.getByText("唯一且稳定的标识，保存后不可修改。", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("combobox", { name: "内容语言", exact: true })).toHaveValue("zh");
    await expect(page.getByRole("combobox", { name: "内容语言", exact: true }).locator("option")).toHaveText(["zh", "en"]);
    await expect(page.getByLabel("人物关系与常见元素 (逗号分隔)", { exact: true })).toHaveValue("");
    await expect(page.getByLabel("避免或限制元素 (逗号分隔)", { exact: true })).toHaveValue("");
  });

  test("all ten form fields, comma-separated editing, validation, detail Markdown and immutable id", async ({ page }) => {
    const state = await mockApi(page, [sample]);
    await page.goto("/#/audience-style/new");
    await expect(page.getByText("A unique, stable identifier. It cannot change after saving.", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("combobox", { name: "Content Language", exact: true })).toHaveValue("en");
    await expect(page.getByRole("combobox", { name: "Content Language", exact: true }).locator("option")).toHaveText(["zh", "en"]);
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
    const relationships = page.getByLabel("Relationships and Common Elements (comma-separated)", { exact: true });
    const avoid = page.getByLabel("Elements to Avoid or Limit (comma-separated)", { exact: true });
    await relationships.fill("  Relationship ， , Common element  ,， ");
    await avoid.fill("  Avoid  ， ， Limit ， ");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("alert")).toHaveText("Use either Chinese or English commas within each field; do not mix them.");
    expect(state.tags).toHaveLength(1);
    await relationships.fill("  Relationship , , Common element , ");
    await avoid.fill("Avoid, Limit， ");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("alert")).toHaveText("Use either Chinese or English commas within each field; do not mix them.");
    expect(state.tags).toHaveLength(1);
    await avoid.fill("  Avoid ， ， Limit ， ");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Tag saved." })).toBeVisible();
    expect(state.tags.at(-1)).toEqual({ id: "new-tag", name: "New tag", kind: "style", language: "zh", description: "Description\nSecond line", readerExperience: "Readers\nExperience", narrativeStyle: "Style\nPacing", relationshipAndElements: ["Relationship", "Common element"], avoidElements: ["Avoid", "Limit"], creativeBrief: "# Preview\n\n- Brief item" });
    const savedDialog = page.getByRole("dialog", { name: "Tag saved." });
    await expect(savedDialog).toBeVisible();
    await expect(savedDialog.getByRole("button", { name: "Back to List Home", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "View Details", exact: true })).toHaveCount(1);
    await savedDialog.getByRole("button", { name: "View Details", exact: true }).click();
    await expect(page).toHaveURL(/#\/audience-style\/tags\/new-tag$/);
    await expect(page.getByRole("combobox", { name: "Filter by type" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Preview", exact: true })).toBeVisible();
    await expect(page.getByRole("listitem").filter({ hasText: "Relationship" })).toBeVisible();
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await expect(page).toHaveURL(/#\/audience-style\/tags\/new-tag\/edit$/);
    await expect(page.getByRole("article")).toHaveCount(0);
    await expect(page.getByRole("combobox", { name: "Filter by type" })).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: /^ID/ })).toBeDisabled();
    await expect(relationships).toHaveValue("Relationship, Common element");
    await expect(avoid).toHaveValue("Avoid，Limit");
    await page.reload();
    await expect(relationships).toHaveValue("Relationship, Common element");
    await expect(avoid).toHaveValue("Avoid，Limit");
    await relationships.fill(" Relationship ， Revised element， ， ");
    await avoid.fill("");
    await page.getByLabel("Name", { exact: true }).fill("Edited");
    state.fail = "PUT";
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("alert")).toHaveText("Failed to save the tag. Please retry.");
    await page.reload();
    await expect(relationships).toHaveValue("Relationship, Common element");
    await expect(avoid).toHaveValue("Avoid，Limit");
    await relationships.fill("Relationship，Revised element");
    await avoid.fill("");
    await page.getByLabel("Name", { exact: true }).fill("Edited");
    state.fail = "";
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("Tag saved.");
    expect(state.tags.at(-1)?.name).toBe("Edited");
    expect(state.tags.at(-1)?.relationshipAndElements).toEqual(["Relationship", "Revised element"]);
    expect(state.tags.at(-1)?.avoidElements).toEqual([]);
    await expect(relationships).toHaveValue("Relationship，Revised element");
    await page.reload();
    await expect(relationships).toHaveValue("Relationship，Revised element");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Edited", exact: true })).toBeVisible();
  });

  test("selecting a tag preserves delete confirmation/cancel/failure and copy/idempotence/failure", async ({ page }) => {
    const state = await mockApi(page, [sample]);
    await page.goto("/#/audience-style");
    const article = page.getByRole("article", { name: sample.name });
    await article.getByRole("button", { name: sample.name, exact: true }).click();
    const detailPanel = page.getByTestId("audience-style-detail");
    await detailPanel.getByRole("button", { name: "Copy to Project" }).click();
    await expect(page.getByRole("status")).toHaveText("Tag copied to the current project.");
    await detailPanel.getByRole("button", { name: "Copy to Project" }).click();
    await expect(page.getByRole("status")).toContainText("no duplicate was added");
    state.fail = "copy";
    await detailPanel.getByRole("button", { name: "Copy to Project" }).click();
    await expect(page.getByRole("alert")).toHaveText("Failed to copy the tag. Please retry.");
    state.fail = "";
    await detailPanel.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page.getByText(`Delete tag “${sample.name}”? Snapshots already copied to the project will be kept.`)).toBeVisible();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(state.deleted).toBe(0);
    await page.reload();
    await expect(page.getByRole("heading", { name: sample.name, exact: true })).toBeVisible();
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

  test("Chinese is the default after browser preferences are cleared", async ({ page }) => {
    await mockApi(page, [{ ...sample, relationshipAndElements: ["亲情", "友情"], avoidElements: ["暴力", "说教"] }]);
    await page.goto(`/${routeToHash({ page: "audience-style", tagId: sample.id, mode: "edit" })}`);
    const relationships = page.getByLabel("Relationships and Common Elements (comma-separated)", { exact: true });
    const avoid = page.getByLabel("Elements to Avoid or Limit (comma-separated)", { exact: true });
    await expect(relationships).toHaveValue("亲情，友情");
    await expect(avoid).toHaveValue("暴力，说教");
    await relationships.fill("亲情, 友情");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("Tag saved.");
    await page.reload();
    await expect(relationships).toHaveValue("亲情, 友情");
    await expect(avoid).toHaveValue("暴力，说教");
    await page.evaluate(() => window.localStorage.clear());
    await page.reload();
    await expect(relationships).toHaveValue("亲情，友情");
    await expect(avoid).toHaveValue("暴力，说教");
  });

  test("genre create and edit also accept Chinese and English commas", async ({ page }) => {
    await mockApi(page);
    let profile = {
      id: "genre-comma-test", name: "Comma genre", language: "zh",
      chapterTypes: [] as string[], fatigueWords: [] as string[],
      numericalSystem: false, powerScaling: false, eraResearch: false,
      pacingRule: "", auditDimensions: [],
    };
    let created = false;
    await page.route("**/api/v1/genres**", async (route) => {
      const request = route.request();
      if (request.method() === "POST") {
        profile = { ...profile, ...request.postDataJSON() };
        created = true;
      } else if (request.method() === "PUT") {
        profile = { ...profile, ...request.postDataJSON().profile };
      }
      const body = new URL(request.url()).pathname === "/api/v1/genres"
        ? { genres: created ? [{ id: profile.id, name: profile.name, language: profile.language, source: "project" }] : [] }
        : { profile, body: "" };
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
    });
    await page.goto(`/${routeToHash({ page: "chat" })}`);
    await page.locator("aside").getByRole("button", { name: "Genre", exact: true }).click();
    await page.getByRole("button", { name: "Create New Genre", exact: true }).click();
    const field = (label: string) => page.locator("label").filter({ hasText: new RegExp(`^${label}$`) }).locator("..").getByRole("textbox");
    await field("ID").fill(profile.id);
    await field("Name").fill(profile.name);
    const chapterTypes = field("Chapter Types \\(comma-separated\\)");
    const fatigueWords = field("Fatigue Words \\(comma-separated\\)");
    await chapterTypes.fill(" 开篇， ,发展, ，高潮 ");
    await fatigueWords.fill(" 震惊， ，不可思议， ");
    let mixedError = "";
    page.once("dialog", async (dialog) => { mixedError = dialog.message(); await dialog.accept(); });
    await page.getByRole("button", { name: "Create New Genre", exact: true }).last().click();
    await expect.poll(() => mixedError).toBe("Use either Chinese or English commas within each field; do not mix them.");
    expect(created).toBe(false);
    await chapterTypes.fill(" 开篇, ,发展, 高潮, ");
    await page.getByRole("button", { name: "Create New Genre", exact: true }).last().click();
    await expect(page.getByRole("heading", { name: profile.name, exact: true })).toBeVisible();
    expect(profile.chapterTypes).toEqual(["开篇", "发展", "高潮"]);
    expect(profile.fatigueWords).toEqual(["震惊", "不可思议"]);
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await expect(chapterTypes).toHaveValue("开篇, 发展, 高潮");
    await expect(fatigueWords).toHaveValue("震惊，不可思议");
    await page.reload();
    await page.locator("aside").getByRole("button", { name: "Genre", exact: true }).click();
    await page.getByRole("button", { name: /Comma genre/ }).click();
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await expect(chapterTypes).toHaveValue("开篇, 发展, 高潮");
    await expect(fatigueWords).toHaveValue("震惊，不可思议");
    await chapterTypes.fill("开篇，结局, ");
    mixedError = "";
    page.once("dialog", async (dialog) => { mixedError = dialog.message(); await dialog.accept(); });
    await page.getByRole("button", { name: "Save Changes", exact: true }).click();
    await expect.poll(() => mixedError).toBe("Use either Chinese or English commas within each field; do not mix them.");
    expect(profile.chapterTypes).toEqual(["开篇", "发展", "高潮"]);
    await chapterTypes.fill("开篇，结局， ");
    await fatigueWords.fill("");
    await page.getByRole("button", { name: "Save Changes", exact: true }).click();
    await expect(page.getByRole("button", { name: "Save Changes", exact: true })).toHaveCount(0);
    expect(profile.chapterTypes).toEqual(["开篇", "结局"]);
    expect(profile.fatigueWords).toEqual([]);
  });

  test("loading remains explicit until the API returns", async ({ page }) => {
    const state = await mockApi(page, [sample]);
    let release!: () => void;
    state.pendingLoad = new Promise<void>((resolve) => { release = resolve; });
    await page.goto("/#/audience-style");
    await expect(page.getByText("Loading...", { exact: true })).toBeVisible();
    const panel = page.getByTestId("audience-style-layout");
    const loadingHeight = (await panel.boundingBox())!.height;
    await expect(page.getByText("No audience/style tags yet. Create your first tag to get started.")).toHaveCount(0);
    release();
    state.pendingLoad = null;
    await expect(page.getByRole("article", { name: sample.name })).toBeVisible();
    expect((await panel.boundingBox())!.height).toBeCloseTo(loadingHeight, 1);
  });

  test("list uses genre container, typography, controls, borders and row spacing", async ({ page }, testInfo) => {
    await mockApi(page, [{ ...sample, source: "project" }]);
    await page.route("**/api/v1/genres**", (route) => route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ genres: [{ id: "reference", name: "Reference genre", language: "en", source: "project" }] }),
    }));
    await page.goto("/#/audience-style");
    await page.locator("aside").getByRole("button", { name: "Genre", exact: true }).click();
    const genreHeading = page.getByRole("heading", { name: "Genre", exact: true });
    await expect(genreHeading).toBeVisible();
    const style = (element: HTMLElement) => {
      const css = getComputedStyle(element);
      return {
        fontSize: css.fontSize, fontFamily: css.fontFamily, fontWeight: css.fontWeight,
        color: css.color, background: css.backgroundColor, borderColor: css.borderTopColor,
        borderRadius: css.borderRadius, padding: css.padding, rowGap: css.rowGap,
      };
    };
    const genreContainer = await genreHeading.locator("../..").locator("..").boundingBox();
    const headingStyle = await genreHeading.evaluate(style);
    const createStyle = await page.getByRole("button", { name: "Create New Genre", exact: true }).evaluate(style);
    const genreRow = page.getByRole("button", { name: "Reference genre reference · en · project" });
    const rowStyle = await genreRow.evaluate(style);
    const panelStyle = await genreRow.locator("..").evaluate(style);
    const genreGrid = genreRow.locator("../..");
    const genreColumns = await genreGrid.evaluate((element) => getComputedStyle(element).gridTemplateColumns);
    const genreGap = await genreGrid.evaluate((element) => getComputedStyle(element).gap);
    const genreDetailStyle = await genreGrid.locator(":scope > div").last().evaluate(style);
    await page.getByRole("button", { name: "Create New Genre", exact: true }).click();
    const inputStyle = await page.locator("main input[type=text]").first().evaluate(style);
    const genreSelect = page.locator("main select");
    expect((await genreSelect.boundingBox())!.width).toBe((await genreSelect.locator("..").boundingBox())!.width);

    await page.locator("aside").getByRole("button", { name: "Audience/Style", exact: true }).click();
    const heading = page.getByRole("heading", { name: "Audience/Style", exact: true });
    const container = await heading.locator("../..").locator("..").boundingBox();
    expect(container!.x).toBe(genreContainer!.x);
    expect(container!.width).toBe(genreContainer!.width);
    expect(await heading.evaluate(style)).toEqual(headingStyle);
    expect(await page.getByRole("button", { name: "New Tag", exact: true }).evaluate(style)).toEqual(createStyle);
    const article = page.getByRole("article", { name: sample.name });
    const actualRowStyle = await article.getByRole("button", { name: sample.name, exact: true }).evaluate(style);
    expect(actualRowStyle.padding).toBe(rowStyle.padding);
    const grid = page.getByTestId("audience-style-layout");
    expect(await grid.evaluate((element) => getComputedStyle(element).gridTemplateColumns)).toBe(genreColumns);
    expect(await grid.evaluate((element) => getComputedStyle(element).gap)).toBe(genreGap);
    const detailPanel = page.getByTestId("audience-style-detail");
    const detailStyle = await detailPanel.evaluate(style);
    for (const key of ["borderColor", "borderRadius", "padding"] as const) {
      expect(detailStyle[key]).toBe(genreDetailStyle[key]);
    }
    await expect(detailPanel).toHaveText("Select a tag to view its details.");
    await expect(page.getByRole("heading", { name: sample.name, exact: true })).toHaveCount(0);
    const actualPanelStyle = await article.locator("..").evaluate(style);
    expect(actualPanelStyle.borderColor).toBe(panelStyle.borderColor);
    expect(actualPanelStyle.borderRadius).toBe(panelStyle.borderRadius);
    const filter = page.getByRole("combobox", { name: "Filter by type" });
    const filterStyle = await filter.evaluate(style);
    for (const key of ["fontSize", "color", "background", "borderColor", "borderRadius", "padding"] as const) {
      expect(filterStyle[key]).toBe(inputStyle[key]);
    }
    expect((await filter.boundingBox())!.width).toBe((await filter.locator("..").boundingBox())!.width);
    expect((await filter.boundingBox())!.y).toBeGreaterThan((await heading.boundingBox())!.y);
    expect((await article.boundingBox())!.y).toBeGreaterThan((await filter.boundingBox())!.y);
    await expect(article.getByText("Audience", { exact: true })).toBeVisible();
    await expect(article.getByText("Description", { exact: true })).toBeVisible();
    await expect(detailPanel.getByRole("button")).toHaveCount(0);
    await expect(article.getByText("Markdown item")).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("audience-list-desktop.png") });
    await article.getByRole("button", { name: sample.name, exact: true }).click();
    await expect(page.getByRole("heading", { name: sample.name, exact: true })).toBeVisible();
    await expect(article.getByRole("button", { name: sample.name, exact: true })).toHaveAttribute("aria-current", "page");
    await expect(article.getByRole("button", { name: sample.name, exact: true })).toHaveClass(/bg-primary\/10/);
    await expect(detailPanel.getByRole("button", { name: "Delete", exact: true })).toHaveClass(/bg-destructive/);
    await page.screenshot({ path: testInfo.outputPath("audience-detail-desktop.png") });
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await expect(page).toHaveURL(/#\/audience-style\/tags\/tag-a\/edit$/);
  });

  test("explicit selection, filtering, browser history and sidebar keep the list route unselected", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.addInitScript(() => localStorage.setItem("inkos:studio:theme", "light"));
    const first = { ...sample, id: "tag-a", name: "受众示例", source: "builtin" as const };
    const second = { ...sample, id: "style-b", name: "风格示例", kind: "style" as const, source: "project" as const };
    await mockApi(page, [first, second], "zh");
    const requests: string[] = [];
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (path.startsWith("/api/v1/audience-style-tags/")) requests.push(path);
    });
    await page.goto("/#/audience-style");
    const detailPanel = page.getByTestId("audience-style-detail");
    const firstButton = page.getByRole("button", { name: first.name, exact: true });
    const secondButton = page.getByRole("button", { name: second.name, exact: true });
    await expect(firstButton).toBeVisible();
    await expect(detailPanel).toHaveText("选择标签查看详情。");
    expect(requests).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath("audience-split-list-zh.png") });
    await firstButton.click();
    await expect(page).toHaveURL(/#\/audience-style\/tags\/tag-a$/);
    await expect(detailPanel.getByRole("heading", { name: first.name, exact: true })).toBeVisible();
    await expect(firstButton).toHaveAttribute("aria-current", "page");
    await secondButton.click();
    await expect(page).toHaveURL(/#\/audience-style\/tags\/style-b$/);
    await expect(detailPanel.getByRole("heading", { name: second.name, exact: true })).toBeVisible();
    await expect(secondButton).toHaveAttribute("aria-current", "page");
    await expect(firstButton).not.toHaveAttribute("aria-current", "page");
    await page.getByLabel("按类型筛选").selectOption("style");
    await expect(firstButton).toHaveCount(0);
    await expect(secondButton).toBeVisible();
    await expect(detailPanel.getByRole("heading", { name: second.name, exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("audience-split-detail-zh.png") });
    await page.goBack();
    await expect(page).toHaveURL(/#\/audience-style\/tags\/tag-a$/);
    await expect(detailPanel.getByRole("heading", { name: first.name, exact: true })).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(/#\/audience-style$/);
    await expect(detailPanel).toHaveText("选择标签查看详情。");
    await expect(page.locator("main [aria-current=page]")).toHaveCount(0);
    await secondButton.click();
    await page.locator("aside").getByRole("button", { name: "受众与风格", exact: true }).click();
    await expect(page).toHaveURL(/#\/audience-style$/);
    await expect(detailPanel).toHaveText("选择标签查看详情。");
  });

  for (const width of [1280, 640, 390]) {
    test(`long content and actions stay inside the module at ${width}px${width === 390 ? " (isolated from fixed sidebar)" : ""}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      const longTag = {
        ...sample, id: "long-id-".repeat(20), name: "LongUnbrokenName".repeat(20),
        description: "LongUnbrokenDescription".repeat(50),
        readerExperience: "LongUnbrokenExperience".repeat(30),
        relationshipAndElements: ["LongUnbrokenElement".repeat(30)],
        creativeBrief: `# Brief\n\n${"LongUnbrokenBrief".repeat(40)}\n\n\`\`\`text\n${"LongCode".repeat(80)}\n\`\`\``,
      };
      await mockApi(page, [longTag]);
      await page.goto("/#/audience-style");
      if (width === 390) {
        // The existing app shell reserves 260px for the sidebar on every viewport.
        // Isolate this module to verify its phone-width layout without changing that shell.
        await page.addStyleTag({ content: "aside { display: none; }" });
      }
      const assertContained = async () => {
        const main = page.locator("main");
        expect(await main.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
        const bounds = (await main.boundingBox())!;
        const targets = main.locator("h1, article, select, input, textarea, button");
        for (const target of await targets.all()) {
          const rect = (await target.boundingBox())!;
          expect(rect.x).toBeGreaterThanOrEqual(bounds.x - 1);
          expect(rect.x + rect.width).toBeLessThanOrEqual(bounds.x + bounds.width + 1);
        }
      };
      const article = page.getByRole("article", { name: longTag.name });
      await expect(article).toBeVisible();
      await assertContained();
      const filter = page.getByRole("combobox", { name: "Filter by type" });
      expect((await filter.boundingBox())!.width).toBe((await page.getByTestId("audience-style-layout").boundingBox())!.width);
      const listPanel = (await page.getByTestId("audience-style-list").boundingBox())!;
      const detailPanel = (await page.getByTestId("audience-style-detail").boundingBox())!;
      if (width >= 1024) {
        expect(listPanel.width).toBe(250);
        expect(detailPanel.x).toBeCloseTo(listPanel.x + listPanel.width + 24, 1);
        expect(detailPanel.y).toBeCloseTo(listPanel.y, 1);
      } else {
        expect(detailPanel.x).toBeCloseTo(listPanel.x, 1);
        expect(detailPanel.y).toBeGreaterThanOrEqual(listPanel.y + listPanel.height + 23);
      }
      await page.screenshot({ path: testInfo.outputPath("audience-list-long-content.png") });
      await article.getByRole("button", { name: longTag.name, exact: true }).click();
      await expect(page).toHaveURL((url) => url.hash === routeToHash({ page: "audience-style", tagId: longTag.id }));
      await expect(page.getByRole("heading", { name: longTag.name, exact: true })).toBeVisible();
      await assertContained();
      await expect(page.getByTestId("audience-style-detail").getByRole("button", { name: "Copy to Project" })).toBeVisible();
      await page.getByTestId("audience-style-detail").scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath("audience-detail-long-content.png") });
      await page.getByRole("button", { name: "Edit", exact: true }).click();
      await expect(page.getByLabel("Name", { exact: true })).toHaveValue(longTag.name);
      await assertContained();
      const save = (await page.getByRole("button", { name: "Save", exact: true }).boundingBox())!;
      const cancel = (await page.getByRole("button", { name: "Cancel", exact: true }).boundingBox())!;
      expect(cancel.y).toBe(save.y);
    });
  }

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
    await expect(page.getByTestId("audience-style-detail").getByRole("alert")).toContainText("Failed to load tags");
    await expect(page.getByTestId("audience-style-list").getByRole("alert")).toContainText("Failed to load tags");
    state.fail = "";
    await page.getByTestId("audience-style-list").getByRole("button", { name: "Refresh", exact: true }).click();
    await page.getByTestId("audience-style-detail").getByRole("button", { name: "Refresh", exact: true }).click();
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
