import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createWorkbench } from "./workbench-fixture.mjs";

const output = process.env.CAGE_TEST_CAPTURE || "/tmp/cage-archive-position";
const engine = process.env.CAGE_TEST_BROWSER || "chromium";
const { page, state, browser, errors } = await createWorkbench({
  url: process.env.CAGE_UI_URL || "http://127.0.0.1:5217",
});
const workspace = state.settings.workspace;
const sessions = Array.from({ length: 18 }, (_, i) => ({
  id: `archive-position-${i}`, workspace, title: i ? `Исторический сеанс ${i}` : "Обрабатываемый сеанс",
  updated_at: "2026-11-08T08:00:00Z",
}));
const evidence = [];
let failArchive = false;
let holdArchive = false, releaseArchive;
let archiveRequests = 0;
let archived = 0;
const dialog = page.getByRole("dialog", { name: "Заархивировать этот сеанс?", exact: true });
const actions = title => page.getByRole("group", { name: `${title} : действия`, exact: true, includeHidden: true });
const open = async title => {
  const row = page.locator(".sidebar-tab").filter({ has: actions(title) });
  await row.hover();
  const trigger = actions(title).getByRole("button", { name: "Архивировать", exact: true });
  await trigger.click();
  await dialog.waitFor();
  return trigger;
};
try {
  await page.route("**/api/cli/sessions", route => route.fulfill({ json: { sessions } }));
  await page.route("**/api/cli/sessions/*/archive", async route => {
    archiveRequests++;
    if (holdArchive) await new Promise(resolve => { releaseArchive = resolve; });
    if (failArchive) return route.fulfill({ status: 400, contentType: "text/plain", body: "В среде выполняется другое действие" });
    const id = route.request().url().split("/").at(-2);
    sessions.splice(sessions.findIndex(session => session.id === id), 1);
    state.terminals = state.terminals.filter(terminal => terminal.cli_session_id !== id);
    archived++;
    await route.fulfill({ json: { ok: true } });
  });
  state.status.ready = state.status.vm_running = true;
  state.terminals = [{ id: "archive-live", kind: "claude", workspace,
    title: sessions[0].title, cli_session_id: sessions[0].id }];
  await page.getByRole("tab", { name: sessions[0].title, exact: true }).waitFor();
  await page.getByRole("button", { name: sessions.at(-1).title, exact: true }).waitFor();
  await mkdir(output, { recursive: true });
  // A user can click the visible action text as well as its icon. Locator
  // clicks on the icon alone hid the inert text beside the old buttons.
  const firstActions = actions(sessions[0].title);
  await page.locator(".sidebar-tab").filter({ has: firstActions }).hover();
  await firstActions.getByRole("button", { name: "Архивировать", exact: true }).hover();
  await page.screenshot({ path: `${output}/${engine}-archive-label.png` });
  await firstActions.locator(".terminal-action-label").filter({ hasText: /Архивировать/ }).click();
  await dialog.waitFor({ timeout: 2000 });
  await dialog.getByRole("button", { name: "Отмена", exact: true }).click();
  assert.equal(archived, 0, "action text bypassed archive confirmation");
  for (const width of [1280, 820]) {
    await page.setViewportSize({ width, height: 850 });
    const trigger = await open(sessions[0].title);
    const anchor = await trigger.boundingBox();
    const box = await dialog.boundingBox();
    assert.ok(Math.abs(box.y - anchor.y - anchor.height - 6) < 1, "confirmation is not below archive trigger");
    assert.ok(box.width <= 305 && box.x >= 8 && box.x + box.width <= width - 8, "confirmation overflows window");
    assert.ok(Math.abs(box.x + box.width / 2 - anchor.x) < 100, "confirmation is too far from trigger");
    await page.screenshot({ path: `${output}/${engine}-${width}.png` });
    await dialog.getByRole("button", { name: "Отмена", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    assert.equal(archived, 0, "cancel archived a session");
    assert.equal(await trigger.evaluate(node => node === document.activeElement), true, "cancel did not restore trigger focus");
    await trigger.press("Enter");
    await dialog.waitFor();
    await page.keyboard.press("Shift+Tab");
    assert.equal(await dialog.getByRole("button", { name: "Заархивировать сеанс", exact: true }).evaluate(node => node === document.activeElement), true);
    await page.keyboard.press("Tab");
    assert.equal(await dialog.getByRole("button", { name: "Закрыть панель", exact: true }).evaluate(node => node === document.activeElement), true);
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    assert.equal(await trigger.evaluate(node => node === document.activeElement), true);
    await trigger.press("Enter");
    await dialog.waitFor();
    await page.mouse.click(width - 20, 20);
    await dialog.waitFor({ state: "hidden" });
    assert.equal(archived, 0);
    evidence.push({ width, anchor, box });
  }
  // The last history row is at the bottom of a scrollable sidebar.
  const last = sessions.at(-1).title;
  const bottomTrigger = await open(last);
  const bottomAnchor = await bottomTrigger.boundingBox();
  const bottomBox = await dialog.boundingBox();
  assert.ok(bottomBox.y >= 8 && bottomBox.y + bottomBox.height <= 842, "bottom confirmation is clipped");
  assert.ok(bottomBox.y + bottomBox.height <= bottomAnchor.y, "bottom confirmation did not move above the trigger");
  await page.screenshot({ path: `${output}/${engine}-bottom.png` });
  await page.keyboard.press("Escape");
  await open(sessions[0].title);
  failArchive = true;
  await dialog.getByRole("button", { name: "Заархивировать сеанс", exact: true }).click();
  await dialog.getByRole("alert").filter({ hasText: "В среде выполняется другое действие" }).waitFor();
  assert.equal(archived, 0, "failed archive removed a session");
  failArchive = false;
  holdArchive = true;
  await dialog.getByRole("button", { name: "Заархивировать сеанс", exact: true }).press("Enter");
  await dialog.getByRole("button", { name: "Архивация…", exact: true }).waitFor();
  assert.equal(await dialog.getByRole("button", { name: "Отмена", exact: true }).isDisabled(), true);
  assert.equal(await dialog.getByRole("button", { name: "Архивация…", exact: true }).isDisabled(), true);
  const pendingRequests = archiveRequests;
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");
  assert.equal(await dialog.isVisible(), true, "pending archive was dismissed");
  assert.equal(archiveRequests, pendingRequests, "pending archive was submitted twice");
  await page.screenshot({ path: `${output}/${engine}-pending.png` });
  releaseArchive(); holdArchive = false;
  await actions("Обрабатываемый сеанс").waitFor({ state: "hidden" });
  assert.equal(archived, 1, "confirm should archive exactly once");
  await open(last);
  await dialog.getByRole("button", { name: "Заархивировать сеанс", exact: true }).click();
  await actions(last).waitFor({ state: "hidden" });
  assert.equal(archived, 2, "history session archive failed");
  assert.deepEqual(errors, []);
  await writeFile(`${output}/${engine}-result.json`, JSON.stringify(evidence, null, 2));
  console.log(`${engine}: archive positioning, viewport edges, focus, keyboard, cancel, outside dismissal, failure/retry and live/history archive passed`);
} finally {
  await browser.close();
}
