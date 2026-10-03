import { test, expect, type Page } from "@playwright/test";

const SESSION_ID = "e2e-proposal-session";
const instruction = "世界观：浮空城；主角：修理师；核心冲突：能源枯竭；额外要求：保留方言\n未识别的自由文本";
const createBook = { title: "旧书名", genre: "fantasy", platform: "qidian", language: "zh", targetChapters: 80, chapterWordCount: 2000 };
const proposal = (payload: unknown = { createBook }, text = instruction, sameSession = true) => ({
  id: "proposal-1", tool: "propose_action", label: "Confirm action", status: "completed", startedAt: 1,
  details: { kind: "proposed_action", action: "create_book", targetSessionKind: "book-create", sameSession,
    title: "建书确认", summary: "请检查故事设定", instruction: text, actionPayload: payload },
});

// Same route/recorder pattern as reasoning-effort.spec.ts: exercise the real
// ChatPage -> sendMessage -> /agent body without contacting any model.
async function openChat(page: Page, options: { payload?: unknown; text?: string; sameSession?: boolean; messages?: unknown[] } = {}) {
  const bodies: Record<string, any>[] = [];
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api\/v1/, "");
    const json = (body: unknown) => route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
    if (path === "/events") return route.fulfill({ contentType: "text/event-stream", body: "" });
    if (path === "/project") return json({ language: "en", languageExplicit: true });
    if (path === "/books") return json({ books: [] });
    if (path === "/services") return json({ services: [{ service: "test", connected: true }] });
    if (path === "/services/config") return json({ service: "test", defaultModel: "test", services: [{ service: "test", models: ["test"] }] });
    if (path === "/sessions") {
      if (route.request().method() === "POST") return json({ session: { sessionId: "e2e-new-session", bookId: null, sessionKind: "book-create" } });
      return json({ sessions: [{ sessionId: SESSION_ID, bookId: null, sessionKind: "chat", title: "Proposal", messageCount: 1, createdAt: 1, updatedAt: 2 }] });
    }
    if (path === `/sessions/${SESSION_ID}`) return json({ session: {
      sessionId: SESSION_ID, bookId: null, sessionKind: "chat", title: "Proposal",
      messages: options.messages ?? [{ role: "assistant", content: "", timestamp: 1, toolExecutions: [proposal(options.payload, options.text, options.sameSession)] }],
    } });
    if (path === "/agent") { bodies.push(route.request().postDataJSON()); return json({ response: "ok" }); }
    return json({});
  });
  await page.goto("/#/chat");
  await expect(page.getByPlaceholder("Enter command...")).toBeVisible();
  return bodies;
}

for (const sameSession of [true, false]) {
  test(`edited book values reach the actual execution request (${sameSession ? "same" : "new"} session) and lock`, async ({ page }) => {
    const bodies = await openChat(page, { sameSession });
    await page.getByRole("textbox", { name: "Book title", exact: true }).fill("新书名");
    await page.getByRole("textbox", { name: "Genre", exact: true }).fill("mystery");
    await page.getByRole("spinbutton", { name: "Target chapters", exact: true }).fill("120");
    await page.getByRole("textbox", { name: "世界观", exact: true }).fill("海底城\n潮汐能源");
    await page.getByRole("textbox", { name: "主角", exact: true }).fill("潜水员");
    await page.getByTestId("confirm-action").click();
    await expect.poll(() => bodies.length).toBe(1);
    expect(bodies[0]).toMatchObject({ actionSource: "button", requestedIntent: "create_book", sessionKind: "book-create",
      sessionId: sameSession ? SESSION_ID : "e2e-new-session",
      actionPayload: { createBook: { ...createBook, title: "新书名", genre: "mystery", targetChapters: 120 } },
    });
    expect(bodies[0].instruction).toContain("世界观：海底城");
    expect(bodies[0].instruction).toContain("潮汐能源");
    expect(bodies[0].instruction).toContain("主角：潜水员");
    expect(bodies[0].instruction).toContain("能源枯竭");
    expect(bodies[0].instruction).toContain("保留方言");
    expect(bodies[0].instruction).toContain("未识别的自由文本");
    if (sameSession) {
      await expect(page.getByText("Executed", { exact: true })).toBeVisible();
      await expect(page.getByRole("textbox", { name: "Book title", exact: true })).toBeDisabled();
      await expect(page.getByRole("textbox", { name: "Book title", exact: true })).toHaveValue("新书名");
      await expect(page.getByTestId("confirm-action")).toHaveCount(0);
    }
  });
}

test("known fields and labelled story sections have readable controls on a narrow screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openChat(page);
  for (const name of ["Book title", "Genre", "世界观", "主角", "核心冲突"]) {
    await expect(page.getByRole("textbox", { name, exact: true })).toBeVisible();
  }
  await expect(page.getByRole("combobox", { name: "Platform", exact: true })).toBeVisible();
  await expect(page.getByRole("spinbutton", { name: "Words per chapter", exact: true })).toHaveValue("2000");
  const editor = page.getByTestId("create-book-editor");
  expect(await editor.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
});

test("cancel locks the editor and sends no creation payload", async ({ page }) => {
  const bodies = await openChat(page);
  await page.getByRole("textbox", { name: "Book title", exact: true }).fill("取消的书");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect.poll(() => bodies.length).toBe(1);
  expect(bodies[0].requestedIntent).toBeUndefined();
  expect(bodies[0].actionPayload).toBeUndefined();
  await expect(page.getByText("Cancelled", { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Book title", exact: true })).toBeDisabled();
});

test("legacy free text and missing fields remain editable and are sent intact", async ({ page }) => {
  const bodies = await openChat(page, { payload: {}, text: "旧格式没有字段，保留全部设定" });
  await page.getByRole("textbox", { name: "Book title", exact: true }).fill("补充书名");
  await page.getByRole("textbox", { name: "Creation instruction", exact: true }).fill("旧格式修改后的完整设定\n未知内容");
  await page.getByTestId("confirm-action").click();
  await expect.poll(() => bodies.length).toBe(1);
  expect(bodies[0].actionPayload.createBook).toEqual({ title: "补充书名" });
  expect(bodies[0].instruction).toContain("旧格式修改后的完整设定");
  expect(bodies[0].instruction).toContain("未知内容");
});

test("additional payload fields stay readable, editable and enter the instruction without violating the strict schema", async ({ page }) => {
  const bodies = await openChat(page, { payload: { createBook: { ...createBook, customSetting: { city: "云城" } } } });
  const extra = page.getByRole("textbox", { name: "customSetting", exact: true });
  await expect(extra).toHaveValue('{\n  "city": "云城"\n}');
  await extra.fill("额外的城市设定");
  await page.getByTestId("confirm-action").click();
  await expect.poll(() => bodies.length).toBe(1);
  expect(bodies[0].instruction).toContain("customSetting：额外的城市设定");
  expect(bodies[0].actionPayload.createBook).toEqual(createBook);
});
