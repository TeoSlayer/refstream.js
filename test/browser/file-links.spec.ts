import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import type * as Library from "../../src/index.js";

declare global {
  interface Window {
    fileFixture: { calls: { path: string; purpose: string; line?: number; column?: number }[]; session: Library.TerminalSession; snapshot: string; aborts: number; cancellations: number; revoked: number };
  }
}

async function openPreview(page: Page, path: string, mobile: boolean): Promise<void> {
  const link = page.locator('a[data-link-kind="file"]').filter({ hasText: path }).first();
  if (mobile) await link.tap(); else await link.hover();
  await expect(page.getByRole("dialog", { name: /File preview/ })).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.goto("/test/browser/harness.html"); await expect(page.getByRole("status")).toHaveText("Ready");
  await page.evaluate(async () => {
    await document.fonts.ready;
    const { terminal, library } = window.fixture;
    const session = new library.TerminalSession(terminal);
    window.fileFixture = { calls: [], session, snapshot: "", aborts: 0, cancellations: 0, revoked: 0 };
  });
});

test("hover or tap previews host-supplied text, highlights a file location and reauthorizes a complete download", async ({ page, isMobile }) => {
  const requests: string[] = []; page.on("request", request => requests.push(request.url()));
  const content = Array.from({ length: 55 }, (_, index) => index === 41 ? 'PRIVATE_PREVIEW_ONLY <img src="https://leak.invalid/secret">' : `line ${index + 1}`).join("\n");
  await page.evaluate(content => {
    const { terminal } = window.fixture;
    terminal.options.fileLinks = { resolve(reference, request) {
      window.fileFixture.calls.push({ path: reference.path, purpose: request.purpose, line: reference.line, column: reference.column });
      return reference.path === "src/notes.md" ? { name: "notes.md", body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(content)); controller.close(); } }), mimeType: "text/markdown" } : null;
    } };
    terminal.write("Agent wrote src/notes.md:42:7\r\n");
    window.fileFixture.snapshot = JSON.stringify(window.fileFixture.session.snapshot());
  }, content);
  await expect(page.getByRole("link", { name: "Preview src/notes.md:42:7" })).toBeVisible();
  expect(await page.evaluate(() => window.fileFixture.calls)).toEqual([]);
  await openPreview(page, "src/notes", isMobile);
  await expect(page.locator('.shell-file-text-line[data-highlight="true"]')).toContainText("PRIVATE_PREVIEW_ONLY");
  await expect(page.locator(".shell-file-content img, .shell-file-content script, .shell-file-content iframe")).toHaveCount(0);
  expect(await page.evaluate(() => JSON.stringify(window.fileFixture.session.snapshot()))).toBe(await page.evaluate(() => window.fileFixture.snapshot));
  expect(requests).toEqual([]);
  const received = page.waitForEvent("download"); await page.getByRole("button", { name: "Download", exact: true }).click();
  const download = await received; expect(download.suggestedFilename()).toBe("notes.md");
  expect(await readFile((await download.path())!, "utf8")).toBe(content);
  expect(await page.evaluate(() => window.fileFixture.calls)).toEqual([{ path: "src/notes.md", purpose: "preview", line: 42, column: 7 }, { path: "src/notes.md", purpose: "download", line: 42, column: 7 }]);
  expect(await page.evaluate(() => window.fixture.input)).toEqual([]);
  await page.getByRole("button", { name: "Close file preview" }).click();
  await expect(page.locator(".shell-file-preview")).toHaveCount(0);
});

test("URL previews require an explicit origin and send neither cookies nor referrers; redirects cannot leak", async ({ page, context }) => {
  const observed: { url: string; headers: Record<string, string> }[] = [];
  await context.addCookies([{ name: "session_secret", value: "do-not-send", url: "http://127.0.0.1:5203" }]);
  await page.route("**/authorized-file.txt", async route => { observed.push({ url: route.request().url(), headers: await route.request().allHeaders() }); await route.fulfill({ contentType: "text/plain", body: "authorized body" }); });
  await page.route("**/redirect-file.txt", async route => { observed.push({ url: route.request().url(), headers: await route.request().allHeaders() }); await route.continue(); });
  // Same-origin is allowed by the fixture's CSP, so CSP cannot mask a followed redirect.
  let leaked = false; await page.route("**/test/browser/redirect-target.txt?**", async route => { leaked = true; await route.abort(); });
  await page.evaluate(() => {
    const { terminal } = window.fixture;
    terminal.options.fileLinks = { resolve: () => ({ url: "/authorized-file.txt" }) };
    terminal.write("private/file.txt\r\n");
  });
  await page.getByRole("link", { name: "Preview private/file.txt" }).click();
  await expect(page.locator(".shell-file-content")).toContainText("not available"); expect(observed).toEqual([]);
  await page.evaluate(() => {
    window.fixture.terminal.options.fileLinks = { allowedOrigins: [location.origin], resolve: () => ({ url: "/authorized-file.txt" }) };
  });
  await page.getByRole("link", { name: "Preview private/file.txt" }).click();
  await expect(page.locator(".shell-file-text")).toHaveText(/authorized body/u);
  expect(observed).toHaveLength(1); expect(observed[0].headers.cookie).toBeUndefined(); expect(observed[0].headers.referer).toBeUndefined();
  await page.evaluate(() => {
    window.fixture.terminal.options.fileLinks = { allowedOrigins: [location.origin], resolve: () => ({ url: "/test/browser/redirect-file.txt" }) };
  });
  await page.getByRole("link", { name: "Preview private/file.txt" }).click();
  await expect(page.locator(".shell-file-content")).toContainText("not available"); expect(leaked).toBe(false);
  expect(observed).toHaveLength(2);
  expect(observed[1].headers.cookie).toBeUndefined(); expect(observed[1].headers.referer).toBeUndefined();
});

test("images and videos use revocable blob previews and active document types remain inert", async ({ page, isMobile }) => {
  const image = [...await readFile(new URL("./fixtures/image.png", import.meta.url))];
  const video = [...await readFile(new URL("./fixtures/video.mp4", import.meta.url))];
  await page.evaluate(({ image, video }) => {
    const original = URL.revokeObjectURL; URL.revokeObjectURL = url => { window.fileFixture.revoked++; original.call(URL, url); };
    const { terminal } = window.fixture;
    terminal.options.fileLinks = { resolve(reference) {
      if (reference.path === "assets/image.png") return { body: new Blob([new Uint8Array(image)], { type: "image/png" }) };
      if (reference.path === "assets/video.mp4") return { body: new Blob([new Uint8Array(video)], { type: "video/mp4" }) };
      return { mimeType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" onload="window.svgExecuted=true"><script>window.svgExecuted=true</script></svg>' };
    } };
    terminal.write("assets/image.png\r\nassets/video.mp4\r\nassets/active.svg\r\n");
  }, { image, video });
  await openPreview(page, "assets/image", isMobile);
  await expect.poll(() => page.locator(".shell-file-content img").evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(192);
  await expect(page.locator(".shell-file-content img")).toHaveAttribute("src", /^blob:/u);
  await page.getByRole("button", { name: "Close file preview" }).click();
  expect(await page.evaluate(() => window.fileFixture.revoked)).toBeGreaterThanOrEqual(1);
  await openPreview(page, "assets/video", isMobile);
  await expect(page.locator(".shell-file-content video")).toHaveAttribute("src", /^blob:/u);
  if (isMobile) expect(await page.evaluate(() => window.fixture.terminal.hasSelection())).toBe(false);
  expect(await page.locator(".shell-file-content video").evaluate((video: HTMLVideoElement) => ({ controls: video.controls, autoplay: video.autoplay }))).toEqual({ controls: true, autoplay: false });
  await expect.poll(() => page.locator(".shell-file-content").evaluate(node => {
    const video = node.querySelector("video"); return video ? video.videoWidth > 0 : node.textContent?.includes("cannot preview");
  })).toBe(true);
  await page.getByRole("button", { name: "Close file preview" }).click();
  await openPreview(page, "assets/active", isMobile);
  await expect(page.locator(".shell-file-text")).toContainText("<svg");
  await expect(page.locator(".shell-file-content svg, .shell-file-content iframe, .shell-file-content object")).toHaveCount(0);
  expect(await page.evaluate(() => "svgExecuted" in window)).toBe(false);
  const bounds = await page.getByRole("dialog", { name: /File preview/ }).boundingBox();
  const viewport = page.viewportSize()!; expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width + 1);
  await page.evaluate(() => { window.fixture.terminal.options.fileLinks = undefined; });
  await expect(page.locator(".shell-file-preview")).toHaveCount(0);
});

test("closing or resetting cancels pending host work and discards late preview streams", async ({ page }) => {
  await page.evaluate(() => {
    const { terminal } = window.fixture;
    terminal.options.fileLinks = { resolve(_reference, { signal }) {
      return new Promise(resolve => {
        signal.addEventListener("abort", () => {
          window.fileFixture.aborts++;
          resolve({ body: new ReadableStream({ cancel() { window.fileFixture.cancellations++; } }), mimeType: "text/plain" });
        }, { once: true });
      });
    } };
    terminal.write("src/pending.txt\r\n");
  });
  await page.getByRole("link", { name: "Preview src/pending.txt" }).click();
  await expect(page.locator(".shell-file-content")).toHaveText("Loading…");
  await page.evaluate(() => window.fixture.terminal.reset());
  await expect.poll(() => page.evaluate(() => window.fileFixture.aborts)).toBe(1);
  await expect.poll(() => page.evaluate(() => window.fileFixture.cancellations)).toBe(1);
  await expect(page.locator(".shell-file-preview")).toHaveCount(0);
});

test("a failed preview still downloads; host labels, actions, renderers and cleanup are honored", async ({ page }) => {
  await page.evaluate(() => {
    const state = window.fileFixture;
    window.fixture.terminal.options.fileLinks = {
      resolve(_reference, request) { if (request.purpose === "preview") throw new Error("Private backend detail must not appear"); return { body: "downloaded despite preview failure", name: "recover.txt", mimeType: "text/plain" }; },
      ui: { labels: { download: "Save file", close: "Dismiss preview", previewUnavailable: "No thumbnail" }, tooltips: false, actions: ["download", { id: "inspect", label: "Inspect reference", run({ content, reference }) { content.textContent = reference.path; } }, "close"],
        render({ container, content }) { container.dataset.hostPreview = "true"; content.dataset.hostContent = "true"; return { dispose() { state.cancellations++; } }; },
      },
    };
    window.fixture.terminal.write("private/recover.txt\r\n");
  });
  await page.getByRole("link", { name: "Preview private/recover.txt" }).click();
  await expect(page.locator('[data-host-content="true"]')).toContainText("No thumbnail");
  await expect(page.locator(".shell-file-preview")).not.toContainText("Private backend detail");
  const saved = page.waitForEvent("download"); await page.getByRole("button", { name: "Save file", exact: true }).click();
  expect(await readFile((await (await saved).path())!, "utf8")).toBe("downloaded despite preview failure");
  await page.getByRole("button", { name: "Inspect reference", exact: true }).click();
  await expect(page.locator('[data-host-content="true"]')).toHaveText("private/recover.txt");
  await page.getByRole("button", { name: "Dismiss preview", exact: true }).click();
  expect(await page.evaluate(() => window.fileFixture.cancellations)).toBe(1);
});

test("hover stays open while crossing the gap and entering Download", async ({ page, isMobile }) => {
  test.skip(isMobile, "Touch uses a pinned tap preview, not hover");
  await page.evaluate(() => { window.fixture.terminal.options.fileLinks = { resolve: () => ({ body: "hover preview", mimeType: "text/plain" }) }; window.fixture.terminal.write("docs/hover.txt\r\n"); });
  const source = page.getByRole("link", { name: "Preview docs/hover.txt" }); await source.hover();
  const card = page.locator(".shell-file-preview"); await expect(card).toBeVisible();
  await expect(page.locator(".shell-file-text")).toHaveText("hover preview");
  const from = (await source.boundingBox())!, to = (await card.boundingBox())!;
  const gap = to.y > from.y ? from.y + from.height + 4 : from.y - 4;
  await page.mouse.move(from.x + Math.min(from.width / 2, 20), gap);
  await page.waitForTimeout(800); await expect(card).toBeVisible();
  await page.getByRole("button", { name: "Download", exact: true }).hover();
  await page.waitForTimeout(800); await expect(card).toBeVisible();
});

test("file links work with a keyboard and dragging a path selects text without resolving it", async ({ page, isMobile }) => {
  test.skip(isMobile, "Physical keyboard and mouse drag; mobile activation is covered by the tap tests");
  await page.evaluate(() => {
    const { terminal } = window.fixture;
    terminal.options.fileLinks = { hoverDelayMs: 1000, resolve(reference, request) { window.fileFixture.calls.push({ path: reference.path, purpose: request.purpose }); return { body: "plain file", mimeType: "text/plain" }; } };
    terminal.write("src/keyboard.txt\r\n");
  });
  const link = page.getByRole("link", { name: "Preview src/keyboard.txt" }).and(page.locator('[tabindex="0"]')); const bounds = (await link.boundingBox())!;
  await page.mouse.move(bounds.x + 2, bounds.y + 6); await page.mouse.down();
  await page.mouse.move(bounds.x + Math.min(90, bounds.width - 2), bounds.y + 6, { steps: 5 }); await page.mouse.up();
  expect(await page.evaluate(() => window.fixture.terminal.getSelection())).toContain("src/");
  expect(await page.evaluate(() => window.fileFixture.calls)).toEqual([]);
  await page.evaluate(() => window.fixture.terminal.clearSelection());
  await link.focus(); await page.keyboard.press("Enter");
  await expect(page.locator(".shell-file-text")).toContainText("plain file");
  await expect(page.getByRole("button", { name: "Close file preview" })).toBeFocused();
  await page.keyboard.press("Escape"); await expect(page.locator(".shell-file-preview")).toHaveCount(0);
  await expect(link).toBeFocused(); expect(await page.evaluate(() => window.fixture.input)).toEqual([]);
  // Returning focus must not schedule another hover preview after dismissal.
  await page.waitForTimeout(1100);
  await expect(page.locator(".shell-file-preview")).toHaveCount(0);
  expect(await page.evaluate(() => window.fileFixture.calls)).toEqual([{ path: "src/keyboard.txt", purpose: "preview" }]);
});
