import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createWorkbench } from "./workbench-fixture.mjs";

const { browser, page, state, errors } = await createWorkbench();
const missing = {
  state: "unset",
  ready: false,
  can_enable: true,
  message: "Перед запуском нужно включить защиту локального Git.",
};
const starts = () => state.requests.filter((r) => r.path === "/start").length;
const writes = () =>
  state.requests.filter((r) => r.path === "/host/git" && r.method === "POST")
    .length;
try {
  state.hostGit = { ...missing };
  await page
    .getByRole("button", { name: "Запустить среду Cage", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Включить защиту и продолжить", exact: true })
    .waitFor();
  assert.equal(starts(), 0);
  assert.equal(writes(), 0);
  await page.getByRole("button", { name: "Пока не запускать", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  assert.equal(starts(), 0);
  await page
    .getByRole("button", { name: "Запустить среду Cage", exact: true })
    .click();
  state.failHostGit = true;
  await page
    .getByRole("button", { name: "Включить защиту и продолжить", exact: true })
    .click();
  await page
    .getByRole("alert")
    .filter({ hasText: "Не удалось сохранить настройки безопасности Git" })
    .waitFor();
  assert.equal(starts(), 0);
  assert.equal(writes(), 1);
  state.failHostGit = false;
  await page
    .getByRole("button", { name: "Включить защиту и продолжить", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Среда Cage готова", exact: true })
    .waitFor();
  assert.equal(starts(), 1);
  assert.equal(writes(), 2);
  state.status.ready = false;
  state.status.vm_running = false;
  await page.reload();
  await page
    .getByRole("button", { name: "Запустить среду Cage", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Среда Cage готова", exact: true })
    .waitFor();
  assert.equal(starts(), 2);
  assert.equal(writes(), 2);
  state.status.ready = false;
  state.status.vm_running = false;
  state.hostGit = {
    state: "unavailable",
    ready: false,
    can_enable: false,
    message: "Пока не удалось проверить локальный Git. Убедитесь, что Git установлен полностью, и повторите проверку; Cage не открывает установщик автоматически.",
  };
  await page.reload();
  await page
    .getByRole("button", { name: "Запустить среду Cage", exact: true })
    .click();
  await page.getByText(state.hostGit.message, { exact: true }).waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Включить защиту и продолжить", exact: true })
      .count(),
    0,
  );
  state.hostGit = { ...missing };
  await page.getByRole("button", { name: "Проверить снова", exact: true }).click();
  await page
    .getByRole("button", { name: "Включить защиту и продолжить", exact: true })
    .waitFor();
  await fs.mkdir("_output/onboarding-qa", { recursive: true });
  await page.screenshot({
    path: "_output/onboarding-qa/git-protection.png",
    animations: "disabled",
  });
  await page.setViewportSize({ width: 820, height: 580 });
  await page.screenshot({
    path: "_output/onboarding-qa/git-protection-small.png",
    animations: "disabled",
  });
  assert.deepEqual(errors, []);
  console.log(
    "PASS: no write/start before consent; cancellation; failed write stays blocked; explicit enable starts once; reload rechecks without rewriting; unavailable Git retries safely.",
  );
} finally {
  await browser.close();
}
