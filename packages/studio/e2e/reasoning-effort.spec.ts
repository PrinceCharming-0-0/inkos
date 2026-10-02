import { test, expect, type Page, type Locator } from "@playwright/test";

/**
 * Studio Chat reasoning-effort slider. Every /api/v1 call is mocked so the
 * spec is deterministic: two configured services, one persisted session
 * (chat or play), and a recorder for the real /agent request bodies.
 */

type SessionKind = "chat" | "play";

interface AgentBody {
  readonly reasoningEffort?: string;
  readonly model?: string;
  readonly service?: string;
  readonly instruction?: string;
}

const SESSION_ID = "e2e-effort-session";
const LONG_MODEL = "alpha-extremely-long-model-identifier-for-truncation-checks-2026";
const STOPS = ["None", "Low", "Medium", "High", "XHigh", "Max"] as const;

async function mockApi(page: Page, kind: SessionKind) {
  const agentBodies: AgentBody[] = [];
  const json = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/^\/api\/v1/, "");

    if (path === "/events") {
      return route.fulfill({ status: 200, contentType: "text/event-stream", body: "" });
    }
    if (path === "/project") return route.fulfill(json({ language: "en", languageExplicit: true }));
    if (path === "/books") return route.fulfill(json({ books: [] }));
    if (path === "/interactive-films") return route.fulfill(json({ films: [] }));
    if (path === "/daemon") return route.fulfill(json({ running: false }));
    if (path === "/skills") return route.fulfill(json({ skills: [] }));
    if (path === "/services") {
      return route.fulfill(json({
        services: [
          { service: "svc-a", label: "Alpha", connected: true },
          { service: "svc-b", label: "Beta", connected: true },
        ],
      }));
    }
    if (path === "/services/config") {
      return route.fulfill(json({
        service: "svc-a",
        defaultModel: LONG_MODEL,
        services: [
          { service: "svc-a", models: [LONG_MODEL, "alpha-2"] },
          { service: "svc-b", models: ["beta-1"] },
        ],
      }));
    }
    if (path === "/sessions" && request.method() === "GET") {
      return route.fulfill(json({
        sessions: [{
          sessionId: SESSION_ID,
          bookId: null,
          sessionKind: kind,
          ...(kind === "play" ? { playMode: "open" } : {}),
          title: "Effort session",
          messageCount: 2,
          createdAt: 1,
          updatedAt: 2,
        }],
      }));
    }
    if (path === `/sessions/${SESSION_ID}`) {
      return route.fulfill(json({
        session: {
          sessionId: SESSION_ID,
          bookId: null,
          sessionKind: kind,
          ...(kind === "play" ? { playMode: "open" } : {}),
          title: "Effort session",
          messages: [
            { role: "user", content: "hello", timestamp: 1 },
            { role: "assistant", content: "hi there", timestamp: 2 },
          ],
        },
      }));
    }
    if (path === "/agent") {
      agentBodies.push(request.postDataJSON() as AgentBody);
      return route.fulfill(json({ response: "ok" }));
    }
    if (path.startsWith("/play/runs/")) return route.fulfill({ status: 404, body: "{}" });
    if (path === "/cover/config") return route.fulfill(json({ configured: false, providers: [] }));
    return route.fulfill(json({}));
  });

  return agentBodies;
}

/** Collects React render-loop failures (#185 / Maximum update depth) from console and page errors. */
function watchUpdateLoops(page: Page) {
  const failures: string[] = [];
  const isLoop = (text: string) => /Maximum update depth exceeded|Minified React error #185|error-decoder\.html\?invariant=185/.test(text);
  page.on("console", (message) => {
    if (message.type() === "error" && isLoop(message.text())) failures.push(message.text());
  });
  page.on("pageerror", (error) => {
    if (isLoop(String(error?.message ?? error))) failures.push(String(error));
  });
  return failures;
}

async function openChat(page: Page, kind: SessionKind) {
  const agentBodies = await mockApi(page, kind);
  await page.goto("/#/chat");
  const slider = page.getByRole("slider", { name: "Effort", exact: true });
  await expect(slider).toBeEnabled();
  await expect(page.getByTestId("model-picker-trigger")).toBeVisible();
  return { agentBodies, slider, value: page.getByTestId("reasoning-effort-value") };
}

async function expectStop(slider: Locator, value: Locator, label: string) {
  await expect(value).toHaveText(label);
  await expect(slider).toHaveAttribute("aria-valuetext", label);
  await expect(slider).toHaveValue(String(STOPS.indexOf(label as (typeof STOPS)[number])));
}

async function send(page: Page, text: string) {
  const textarea = page.getByPlaceholder("Enter command...");
  await textarea.fill(text);
  await textarea.press("Enter");
}

test.describe("chat reasoning effort slider", () => {
  test("starts at Medium and exposes a 0..5 step-1 range", async ({ page }) => {
    const { slider, value } = await openChat(page, "chat");
    await expect(slider).toHaveAttribute("min", "0");
    await expect(slider).toHaveAttribute("max", "5");
    await expect(slider).toHaveAttribute("step", "1");
    await expectStop(slider, value, "Medium");
  });

  test("every stop is selectable; None and Max reach the store and the request", async ({ page }) => {
    const { slider, value, agentBodies } = await openChat(page, "chat");
    for (const [index, label] of STOPS.entries()) {
      await slider.fill(String(index));
      await expectStop(slider, value, label);
    }

    await slider.fill("0");
    await send(page, "with none");
    await expect.poll(() => agentBodies.length).toBe(1);
    await slider.fill("5");
    await send(page, "with max");
    await expect.poll(() => agentBodies.length).toBe(2);
    expect(agentBodies.map((body) => body.reasoningEffort)).toEqual(["none", "max"]);
  });

  test("ArrowLeft/ArrowRight move one stop, Home → None, End → Max", async ({ page }) => {
    const { slider, value } = await openChat(page, "chat");
    await slider.focus();
    await slider.press("ArrowLeft");
    await expectStop(slider, value, "Low");
    await slider.press("ArrowLeft");
    await expectStop(slider, value, "None");
    await slider.press("ArrowLeft");
    await expectStop(slider, value, "None");
    await slider.press("ArrowRight");
    await expectStop(slider, value, "Low");
    await slider.press("End");
    await expectStop(slider, value, "Max");
    await slider.press("ArrowRight");
    await expectStop(slider, value, "Max");
    await slider.press("Home");
    await expectStop(slider, value, "None");
  });

  test("switching service/model keeps the session effort", async ({ page }) => {
    const { slider, value, agentBodies } = await openChat(page, "chat");
    await slider.fill("4");
    await expectStop(slider, value, "XHigh");

    await page.getByTestId("model-picker-trigger").click();
    await page.getByRole("menuitem", { name: "beta-1" }).click();
    await expect(page.getByTestId("model-picker-trigger")).toContainText("Beta · beta-1");
    await expectStop(slider, value, "XHigh");

    await page.getByTestId("model-picker-trigger").click();
    await page.getByRole("menuitem", { name: "alpha-2" }).click();
    await expect(page.getByTestId("model-picker-trigger")).toContainText("Alpha · alpha-2");
    await expectStop(slider, value, "XHigh");

    await send(page, "after switching");
    await expect.poll(() => agentBodies.length).toBe(1);
    expect(agentBodies[0]).toMatchObject({ reasoningEffort: "xhigh", service: "svc-a", model: "alpha-2" });
  });

  test("the request carries the stop shown at send time, not a later slider move", async ({ page }) => {
    const { slider, value, agentBodies } = await openChat(page, "chat");
    await slider.fill("3");
    await expectStop(slider, value, "High");

    // Hold the actual FileReader call until after the slider changes. A large
    // file alone does not prove serialization was still pending at that point.
    await page.evaluate(() => {
      const original = FileReader.prototype.readAsDataURL;
      FileReader.prototype.readAsDataURL = function (blob) {
        (window as any).__releaseEffortAttachment = () => original.call(this, blob);
      };
    });
    await page.locator('input[type="file"][accept]').setInputFiles({
      name: "notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.alloc(512 * 1024, "a"),
    });
    const textarea = page.getByPlaceholder("Enter command...");
    await textarea.fill("snapshot please");
    await textarea.press("Enter");
    await page.waitForFunction(() => typeof (window as any).__releaseEffortAttachment === "function");
    expect(agentBodies).toHaveLength(0);
    await slider.focus();
    await slider.press("Home");
    await expectStop(slider, value, "None");
    expect(agentBodies).toHaveLength(0);
    await page.evaluate(() => (window as any).__releaseEffortAttachment());

    await expect.poll(() => agentBodies.length).toBe(1);
    expect(agentBodies[0]?.reasoningEffort).toBe("high");

    await send(page, "next turn");
    await expect.poll(() => agentBodies.length).toBe(2);
    expect(agentBodies[1]?.reasoningEffort).toBe("none");
  });

  test("retry sends the failed snapshot despite a later slider change", async ({ page }) => {
    const { slider, value, agentBodies } = await openChat(page, "chat");
    // The first request fails at the application boundary; subsequent calls use
    // the normal recorder. The retry must replay effort, with a fresh request id.
    await page.route("**/api/v1/agent", async (route) => {
      agentBodies.push(route.request().postDataJSON() as AgentBody);
      await route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: { code: "AGENT_ERROR", message: "unsupported reasoning effort" } }) });
      await page.unroute("**/api/v1/agent");
    });
    await slider.fill("1");
    await send(page, "retry snapshot");
    const retry = page.getByRole("button", { name: "Retry last message", exact: true });
    await expect(retry).toBeVisible();
    await slider.fill("5");
    await expectStop(slider, value, "Max");
    await retry.click();
    await expect.poll(() => agentBodies.length).toBe(2);
    expect(agentBodies.map((body) => body.reasoningEffort)).toEqual(["low", "low"]);
    await expectStop(slider, value, "Max");
  });

  test("rapid continuous adjustment never triggers an update loop", async ({ page }) => {
    const failures = watchUpdateLoops(page);
    const { slider, value } = await openChat(page, "chat");

    await slider.focus();
    for (let i = 0; i < 40; i += 1) {
      await page.keyboard.press(i % 2 === 0 ? "End" : "Home");
      await page.keyboard.press("ArrowLeft");
      await page.keyboard.press("ArrowRight");
    }
    for (let i = 0; i < 30; i += 1) await slider.fill(String(i % 6));

    // Pointer drag across the full track and back.
    const box = await slider.boundingBox();
    expect(box).not.toBeNull();
    const y = box!.y + box!.height / 2;
    await page.mouse.move(box!.x + 2, y);
    await page.mouse.down();
    for (let step = 0; step <= 30; step += 1) await page.mouse.move(box!.x + (box!.width * step) / 30, y);
    for (let step = 30; step >= 0; step -= 1) await page.mouse.move(box!.x + (box!.width * step) / 30, y);
    await page.mouse.up();

    await slider.focus();
    await page.keyboard.press("End");
    await expectStop(slider, value, "Max");
    expect(failures).toEqual([]);
  });
});

// Viewports where the app shell (fixed sidebar) fits; below ~760px the shell
// itself clips the chat column, which predates and is independent of this control.
const VIEWPORTS = [768, 1024, 1280] as const;
// Composer widths forced directly, covering both sides of the 28rem (chat) and
// 38rem (play) container-query breakpoints plus very narrow composers.
const COMPOSER_WIDTHS = [240, 300, 360, 440, 520, 600, 640, 760] as const;

async function forceComposerWidth(page: Page, width: number) {
  await page.getByTestId("composer-footer").evaluate((footer, px) => {
    const box = footer.closest(".max-w-3xl") as HTMLElement | null;
    if (!box) throw new Error("composer container not found");
    box.style.maxWidth = `${px}px`;
  }, width);
}

async function expectComposerFooterClean(page: Page, kind: SessionKind) {
  const footer = page.getByTestId("composer-footer");
  await expect(footer).toBeVisible();
  const metrics = await footer.evaluate((el) => {
    const rect = (node: Element | null) => {
      if (!node) return null;
      const r = node.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    };
    const control = el.querySelector('[data-testid="reasoning-effort-control"]');
    const output = el.querySelector('[data-testid="reasoning-effort-value"]') as HTMLElement | null;
    const label = control?.querySelector("label") as HTMLElement | null;
    return {
      footer: rect(el),
      footerOverflow: el.scrollWidth - el.clientWidth,
      containerWidth: el.parentElement!.clientWidth - parseFloat(getComputedStyle(el.parentElement!).paddingLeft) - parseFloat(getComputedStyle(el.parentElement!).paddingRight),
      areas: getComputedStyle(el).gridTemplateAreas,
      model: rect(el.querySelector('[data-testid="model-picker-trigger"]')),
      control: rect(control),
      slider: rect(el.querySelector('input[type="range"]')),
      output: rect(output),
      outputClipped: output ? output.scrollWidth > output.clientWidth : true,
      labelClipped: label ? label.scrollWidth > label.clientWidth : true,
      world: rect(el.querySelector('[data-testid="view-world-button"]')),
    };
  });

  type Box = NonNullable<typeof metrics.footer>;
  const overlaps = (a: Box, b: Box) =>
    a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
  const inside = (inner: Box, outer: Box) =>
    inner.left >= outer.left - 0.5 && inner.right <= outer.right + 0.5;

  expect(metrics.footerOverflow).toBeLessThanOrEqual(0);
  const wide = metrics.containerWidth >= (kind === "play" ? 38 : 28) * 16;
  expect(metrics.areas).toBe(kind === "play"
    ? (wide ? '"model effort world"' : '"model world" "effort effort"')
    : (wide ? '"model effort"' : '"model" "effort"'));
  const viewportWidth = page.viewportSize()!.width;
  expect(metrics.footer!.right).toBeLessThanOrEqual(viewportWidth + 0.5);
  const parts = [metrics.model, metrics.control, ...(kind === "play" ? [metrics.world] : [])];
  for (const part of parts) {
    expect(part).not.toBeNull();
    expect(inside(part!, metrics.footer!)).toBe(true);
  }
  for (let i = 0; i < parts.length; i += 1) {
    for (let j = i + 1; j < parts.length; j += 1) {
      expect(overlaps(parts[i]!, parts[j]!)).toBe(false);
    }
  }
  expect(metrics.outputClipped).toBe(false);
  expect(metrics.labelClipped).toBe(false);
  expect(metrics.slider!.width).toBeGreaterThanOrEqual(60);
  expect(overlaps(metrics.slider!, metrics.output!)).toBe(false);
}

for (const kind of ["chat", "play"] as const) {
  test.describe(`${kind} composer layout`, () => {
    for (const width of VIEWPORTS) {
      test(`no overlap or overflow at ${width}px viewport`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        const { slider, value } = await openChat(page, kind);
        for (const stop of ["2", "4"]) {
          await slider.fill(stop);
          await expectComposerFooterClean(page, kind);
        }
        await expect(value).toHaveText("XHigh");
        await expect(page.getByPlaceholder("Enter command...")).toBeVisible();
        if (kind === "play") {
          await expect(page.getByTestId("view-world-button")).toBeVisible();
          await expect(page.getByRole("button", { name: "Auto illustration" })).toBeVisible();
        }
        await page.screenshot({ path: `test-results/reasoning-effort-${kind}-viewport-${width}.png` });
      });
    }

    test("narrow composer widths stay readable on both sides of the breakpoint", async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 900 });
      const { slider, value } = await openChat(page, kind);
      for (const width of COMPOSER_WIDTHS) {
        await forceComposerWidth(page, width);
        for (const [stop, label] of [["2", "Medium"], ["4", "XHigh"], ["0", "None"]] as const) {
          await slider.fill(stop);
          await expect(value).toHaveText(label);
          await expectComposerFooterClean(page, kind);
        }
        await page.getByTestId("composer-footer").screenshot({
          path: `test-results/reasoning-effort-${kind}-composer-${width}.png`,
        });
      }
      if (kind === "chat") {
        // Diagnostic evidence for the inherited fixed-sidebar shell. The
        // supported-width assertions above remain mandatory and unchanged.
        for (const width of [360, 600]) {
          await page.setViewportSize({ width, height: 900 });
          await forceComposerWidth(page, 760);
          const metrics = await page.getByTestId("composer-footer").evaluate((footer) => {
            const rect = footer.getBoundingClientRect();
            const sidebar = document.querySelector("aside")!.getBoundingClientRect();
            const control = footer.querySelector<HTMLElement>('[data-testid="reasoning-effort-control"]')!;
            const display = control.style.display;
            control.style.display = "none";
            const withoutControl = footer.getBoundingClientRect();
            control.style.display = display;
            return { viewport: innerWidth, sidebarWidth: sidebar.width, footerLeft: rect.left, footerRight: rect.right, footerWidth: rect.width, withoutEffortControlRight: withoutControl.right };
          });
          expect(metrics.withoutEffortControlRight).toBe(metrics.footerRight);
          console.log("Inherited shell diagnostic", JSON.stringify(metrics));
          await test.info().attach(`inherited-shell-${width}`, { body: JSON.stringify(metrics), contentType: "application/json" });
          await page.screenshot({ path: `test-results/reasoning-effort-inherited-shell-${width}.png` });
        }
      }
    });

    if (kind === "play") test("world panel toggle still works with the slider present", async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 900 });
      const { slider, value } = await openChat(page, kind);
      await slider.fill("5");
      await page.getByTestId("view-world-button").click();
      await expect(page.getByTestId("view-world-button")).toHaveClass(/bg-primary\/15/);
      await expectStop(slider, value, "Max");
      await expectComposerFooterClean(page, kind);
    });
  });
}
