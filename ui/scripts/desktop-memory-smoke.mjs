import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createWorkbench } from "./workbench-fixture.mjs";

const output = new URL("../../docs/test-reports/2026-11-04-desktop-memory/", import.meta.url);
await fs.mkdir(output, { recursive: true });
const { browser, page, state, errors } = await createWorkbench();
let unavailable = true;
const desktop = { installed: true, running: false, failed: true, failure_reason: "oom-kill", version: "4.4212.0" };
await page.route("**/api/claude-desktop**", async route => {
  if (route.request().method() === "POST") {
    return route.fulfill({ status: 502, body: "Тест: операция открытия не удалась; повторите" });
  }
  if (unavailable) return route.fulfill({ status: 502, body: "Не удалось прочитать состояние Claude Desktop; повторите" });
  return route.fulfill({ json: desktop });
});
try {
  state.status.vm_running = true;
  state.status.ready = true;
  await page.reload();
  await page.getByRole("button", { name: "Claude Desktop", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "Не удалось прочитать состояние Claude Desktop" }).waitFor();
  unavailable = false;
  await page.getByRole("button", { name: "Обновить состояние Claude Desktop", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "Недостаточно памяти среды" }).waitFor();
  assert.equal(await page.getByText("Не удалось прочитать состояние Claude Desktop; повторите", { exact: true }).count(), 0);
  await page.screenshot({ path: new URL("oom-message.png", output).pathname });
  desktop.failed = false;
  desktop.failure_reason = "";
  await page.getByRole("button", { name: "Обновить состояние Claude Desktop", exact: true }).click();
  await page.getByRole("alert").waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Открыть Claude Desktop", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "операция открытия не удалась" }).waitFor();
  await page.getByRole("button", { name: "Обновить состояние Claude Desktop", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "операция открытия не удалась" }).waitFor();
  assert.deepEqual(errors, []);
  const checks = ["status recovery clears stale read error", "OOM reason displayed", "healthy status clears OOM message", "status polling preserves failed user operation"];
  await fs.writeFile(new URL("ui-checks.json", output), JSON.stringify({ complete: true, checks }, null, 2));
  console.log(JSON.stringify({ complete: true, checks }));
} finally { await browser.close(); }
