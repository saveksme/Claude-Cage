import assert from "node:assert/strict";
import { createWorkbench } from "./workbench-fixture.mjs";

const id = "ef88f909-6ac3-4839-b45d-a9569f34d4ab";
let downloads = [], saved = [], calls = [];
const fixture = await createWorkbench({ nativeRequest: async (body) => {
  if (["saveBrowserDownload", "browserDownloadAction"].includes(body.action)) calls.push(body);
  if (body.action === "saveBrowserDownload") return { canceled: true };
  return { ok: true };
} });
const { browser, page, state, errors } = fixture;
await page.route("**/api/input/files/desktop/requests", (route) => route.fulfill({ json: { uploads: [], downloads } }));
await page.route("**/api/browser/files/saved", (route) => route.fulfill({ json: saved }));
let retries = 0;
await page.route("**/api/input/files/download-retry", async (route) => {
  assert.deepEqual(route.request().postDataJSON(), { id, target: "desktop" });
  retries++;
  await route.fulfill({ json: { ok: true } });
});
const waitFor = async (predicate) => {
  for (let count = 0; count < 120; count++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Desktop download UI did not reach expected state");
};
try {
  state.status.ready = true;
  state.status.vm_running = true;
  await page.reload();
  await page.getByRole("button", { name: "Скачать файл", exact: true }).waitFor();
  // A tiny export can finish between polls; it must still offer Save As.
  const item = { id, name: "видео-с-рабочего-стола.mp4", state: "saved", target: "desktop",
    startedAt: new Date(Date.now() + 5).toISOString(), path: "/Users/test/Cage/Downloads/видео-с-рабочего-стола.mp4" };
  saved = [{ id, name: item.name, path: item.path }];
  downloads = [item];
  await waitFor(() => calls.some((call) => call.action === "saveBrowserDownload"));
  await page.getByRole("button", { name: "Скачать файл", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Скачать файл" });
  await dialog.getByText(item.path, { exact: true }).waitFor();
  await dialog.getByRole("button", { name: "Показать в папке", exact: true }).click();
  await waitFor(() => calls.some((call) => call.action === "browserDownloadAction" && call.id === id));
  await page.reload();
  await page.getByRole("button", { name: "Скачать файл", exact: true }).click();
  await dialog.getByText(item.path, { exact: true }).waitFor();
  assert.equal(calls.filter((call) => call.action === "saveBrowserDownload").length, 1, "history reopened a save dialog");
  const openError = "Не удалось открыть файл связанным приложением; откройте его в списке загрузок Cage.";
  downloads = [{ ...item, openError }];
  await dialog.getByText(openError, { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Скачать файл", exact: true }).getAttribute("title"), "Есть загрузки, требующие внимания. Нажмите, чтобы открыть");
  await dialog.getByText(item.path, { exact: true }).waitFor();
  downloads = [item];
  await dialog.getByText(openError, { exact: true }).waitFor({ state: "hidden" });
  saved = [];
  downloads = [{ ...item, state: "failed", retryable: true, path: "", error: "Общий каталог временно недоступен для записи" }];
  await page.reload();
  await page.getByRole("button", { name: "Скачать файл", exact: true }).click();
  await dialog.getByRole("button", { name: "Повторить сохранение", exact: true }).click();
  await waitFor(() => retries === 1);
  assert.equal(await dialog.getByRole("button", { name: "Сохранить как…", exact: true }).count(), 0);
  assert.deepEqual(errors, []);
  console.log("PASS: Desktop instant export, native Save As cancel retains fallback, reveal, history does not reprompt, saved-file open warning and recovery, failed export uses Desktop retry");
} finally { await browser.close(); }
