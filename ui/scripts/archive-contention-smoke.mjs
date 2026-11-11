// Real archive/catalog/terminal handlers; only unrelated workbench services use fixtures.
import assert from "node:assert/strict";
import { createWorkbench } from "./workbench-fixture.mjs";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const fixture = JSON.parse(input);
const forward = async route => {
  const request = route.request();
  const url = new URL(request.url());
  const response = await fetch(fixture.origin + url.pathname + url.search, {
    method: request.method(),
    headers: { Origin: fixture.origin, Cookie: fixture.cookie, "Content-Type": "application/json" },
    body: request.postData() || undefined,
  });
  return route.fulfill({ status: response.status, contentType: response.headers.get("Content-Type"), body: await response.text() });
};
const { page, browser, errors } = await createWorkbench({
  url: process.env.CAGE_UI_URL || fixture.origin,
  cliRequest: forward,
  beforeNavigate: async (page, state) => {
    state.settings.workspace = fixture.workspace;
    Object.assign(state.status, { ready: true, vm_running: true, projects: [fixture.workspace], environment_directory: fixture.workspace });
    await page.route("**/api/terminals", forward);
  },
});
try {
  const actions = page.getByRole("group", { name: `Действия для ${fixture.title}`, exact: true, includeHidden: true });
  await page.locator(".sidebar-tab").filter({ has: actions }).hover();
  await actions.getByRole("button", { name: "Архивировать", exact: true }).hover();
  await actions.locator(".terminal-action-label").filter({ hasText: /Архивировать/ }).click();
  const dialog = page.getByRole("dialog", { name: "Заархивировать этот сеанс?", exact: true });
  await dialog.getByRole("button", { name: "Заархивировать сеанс", exact: true }).click();
  const pending = dialog.getByRole("button", { name: "Архивация…", exact: true });
  await pending.waitFor();
  assert.equal(await pending.isDisabled(), true);
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");
  assert.equal(await dialog.isVisible(), true);
  await fetch(fixture.origin + "/fixture/release-operation", { method: "POST" });
  await dialog.waitFor({ state: "hidden" });
  await actions.waitFor({ state: "hidden" });
  // Reload fetches the durable catalog again through the real backend.
  const reloadedSessions = page.waitForResponse(response => new URL(response.url()).pathname === "/api/cli/sessions");
  await page.reload();
  await page.getByRole("button", { name: "Открыть браузер", exact: true }).waitFor();
  await reloadedSessions;
  assert.equal(await actions.count(), 0);
  assert.deepEqual(errors, []);
  console.log(`${process.env.CAGE_TEST_BROWSER}: UI archive waited for the environment operation, submitted once, removed the row, retained history and survived reload`);
} finally {
  await fetch(fixture.origin + "/fixture/release-operation", { method: "POST" });
  await browser.close();
}
