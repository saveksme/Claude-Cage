import assert from "node:assert/strict";
import { createWorkbench } from "./workbench-fixture.mjs";

const { browser, page, state, errors } = await createWorkbench();
let releaseGit, releaseStart;
const gitGate = new Promise(resolve => { releaseGit = resolve; });
const startGate = new Promise(resolve => { releaseStart = resolve; });
let starts = 0;
const loading = page.getByRole("button", { name: "Обработка…", exact: true });
const assertLoading = async () => {
  await loading.waitFor({ timeout: 500 });
  assert.equal(await loading.isDisabled(), true);
  assert.equal(await page.getByRole("dialog").count(), 0);
  await page.getByRole("heading", { name: "Подготовка среды Cage", exact: true }).waitFor({ timeout: 500 });
};
try {
  await page.route("**/api/host/git", async route => {
    await gitGate;
    await route.fulfill({ json: state.hostGit });
  });
  await page.route("**/api/start", async route => {
    starts++;
    await startGate;
    await route.fulfill({ json: { id: "delayed-start" } });
  });
  const gitRequested = page.waitForRequest("**/api/host/git");
  await page.getByRole("button", { name: "Запустить среду Cage", exact: true }).click();
  await gitRequested;
  await assertLoading();
  const startRequested = page.waitForRequest("**/api/start");
  releaseGit();
  await startRequested;
  await assertLoading();
  const startResponse = page.waitForResponse("**/api/start");
  releaseStart();
  await startResponse;
  // An older idle status must not re-enable the button after acceptance.
  await page.waitForResponse("**/api/status");
  await assertLoading();
  assert.equal(starts, 1);
  state.status.job = { id: "delayed-start", kind: "start", running: true, message: "Подготовка тестовой среды…" };
  await page.locator(".welcome-subtitle").getByText("Подготовка тестовой среды…", { exact: true }).waitFor();
  await assertLoading();
  state.status.job = { ...state.status.job, running: false, error: "Тест: запуск не удался" };
  await page.getByRole("button", { name: "Запустить среду Cage", exact: true }).waitFor();

  await page.route("**/api/start", route => route.fulfill({ status: 503, contentType: "text/plain; charset=utf-8", body: "Тест: запрос не удался" }));
  await page.getByRole("button", { name: "Запустить среду Cage", exact: true }).click();
  await page.getByText("Тест: запрос не удался", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Запустить среду Cage", exact: true }).isEnabled(), true);

  await page.route("**/api/host/git", route => route.fulfill({ status: 503, contentType: "text/plain; charset=utf-8", body: "Тест: проверка не удалась" }));
  await page.getByRole("button", { name: "Запустить среду Cage", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "Тест: проверка не удалась" }).waitFor();
  await page.getByRole("button", { name: "Пока не запускать", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "Запустить среду Cage", exact: true }).isEnabled(), true);
  assert.deepEqual(errors, []);
  console.log("PASS: immediate feedback; no Git dialog flash; continuous loading across delayed requests and stale polling; job handoff; failures and cancellation allow retry.");
} finally {
  releaseGit();
  releaseStart();
  await browser.close();
}
