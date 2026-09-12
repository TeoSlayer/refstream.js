import { test, expect } from "@playwright/test";

test("loads the direct browser JS and optional UI under a restrictive CSP", async ({ page }) => {
  const errors: string[] = [], requests: string[] = [];
  page.on("pageerror", error => errors.push(error.message)); page.on("request", request => requests.push(request.url()));
  await page.goto("/test/browser/distribution.html");
  await expect(page.locator(".shell-terminal-rows")).toContainText("Browser modules: ready 世界");
  await page.getByRole("button", { name: "Invite agent", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Access", exact: true })).toHaveValue("control");
  await expect(page.getByRole("button", { name: "Explore terminal", exact: true })).toHaveCount(0);
  await page.evaluate(() => { const { tools, session } = (window as any).distribution; tools.close(); (window as any).distribution.snapshot = session.snapshot(); });
  await expect(page.locator(".terminal-explorer")).toBeHidden();
  const state = await page.evaluate(() => { const { terminal, session, tools, snapshot } = (window as any).distribution; terminal.write("more"); session.restore(snapshot); const state = session.read(); tools.dispose(); session.dispose(); terminal.dispose(); return state; });
  expect(state.lines.join("\n")).toContain("Browser modules: ready 世界");
  expect(state.lines.join("\n")).not.toContain("more");
  await expect(page.locator(".shell-terminal, .terminal-tools, .terminal-explorer")).toHaveCount(0);
  expect(errors).toEqual([]);
  expect(requests.every(url => url.startsWith("http://127.0.0.1:5203/"))).toBe(true);
  expect(requests.some(url => url.includes("/v1/invitations"))).toBe(false);
});
