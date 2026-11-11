// UI contract fixture: remote paths, generation binding and client-only quit.
// SSH, cookies and streaming use the real protocol tests in internal/remotehost.
import assert from "node:assert/strict";
import { createWorkbench } from "./workbench-fixture.mjs";

const connection = "test-remote-connection";
const instance = "a".repeat(64);
const nativeCalls = [];
const { browser, page, state, errors } = await createWorkbench({
  clientContext: { mode: "remote", client_only: true, connection_id: connection, instance_id: instance, host_id: "test-host", name: "Облачная тестовая среда", client_platform: "darwin", server_platform: "linux", connection: { state: "connected", connection_id: connection, instance_id: instance } },
  nativeRequest: async (body) => { nativeCalls.push(body); return body.action === "accountDevice" ? { supported: false } : true; },
});
const requests = [];
page.on("request", (request) => { if (request.url().includes("/api/")) requests.push(request); });
let directoryRequests = 0;
await page.route("**/api/projects/directories?*", async (route) => {
  const request = route.request();
  assert.equal(request.headers()["x-cage-connection"], connection);
  directoryRequests++;
  const path = new URL(request.url()).searchParams.get("path");
  await route.fulfill({ json: path === "/srv/projects/research" ? { path, parent: "/srv/projects", directories: [], selectable: true } : { path: "/srv/projects", parent: "/srv", directories: [{ name: "research", path: "/srv/projects/research" }], selectable: false } });
});
let resourceData = {
  runtime: "container", automatic: false, running: true,
  configured_memory_bytes: 8 * 1073741824, configured_cpus: 2,
  recommended_memory_bytes: 8 * 1073741824, recommended_cpus: 2,
  restart_required: false, observation: null, resources_verified: true, pids_limit: 512, resource_error: "",
};
await page.route("**/api/environment/resources", (route) => route.fulfill({ json: resourceData }));
try {
  state.settings.workspace = "/srv/cage/workspace";
  state.settings.keyboard = "native";
  Object.assign(state.status, { keyboard: "native", projects: [state.settings.workspace], environment_directory: state.settings.workspace });
  await page.reload();
  await page.getByRole("heading", { name: "Сначала запустите среду Cage" }).waitFor();
  await page.getByRole("button", { name: "Запустить среду Cage", exact: true }).click();
  await page.getByRole("heading", { name: "Среда Cage готова", exact: true }).waitFor();
  await page.getByRole("button", { name: "Добавить проект", exact: true }).click();
  await page.getByRole("button", { name: "Добавить облачный проект…", exact: true }).click();
  const chooser = page.getByRole("region", { name: "Облачные папки" });
  await chooser.getByRole("button", { name: "research", exact: true }).click();
  await chooser.getByRole("button", { name: "Выбрать эту облачную папку", exact: true }).click();
  assert.equal(await page.getByLabel("Папка нового проекта", { exact: true }).inputValue(), "/srv/projects/research");
  await page.getByRole("dialog").getByRole("button", { name: "Открыть проект", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  assert.equal(state.settings.workspace, "/srv/projects/research");
  assert.equal(directoryRequests, 2);
  await page.getByRole("button", { name: "Настройки", exact: true }).click();
  await page.getByRole("navigation", { name: "Разделы настроек" }).getByRole("button", { name: "Основные", exact: true }).click();
  const macKeyboard = page.getByRole("radio", { name: /Сочетания Mac/ });
  assert.equal(await macKeyboard.isChecked(), true, "Mac client defaults must not follow Linux server keyboard mode");
  const savesBefore = state.requests.filter((item) => item.path === "/settings" && item.method === "POST").length;
  await page.getByRole("radio", { name: /Сочетания гостевой системы/ }).check();
  assert.equal(await page.evaluate((instance) => localStorage.getItem(`cage-keyboard:remote:${instance}`), instance), "native");
  assert.equal(state.requests.filter((item) => item.path === "/settings" && item.method === "POST").length, savesBefore, "client keyboard changes must not write cloud settings");
  await macKeyboard.check();
  await page.getByRole("navigation", { name: "Разделы настроек" }).getByRole("button", { name: "Среда и восстановление", exact: true }).click();
  await page.getByRole("heading", { name: "Лимиты ресурсов контейнера сервера", exact: true }).waitFor();
  const resources = page.getByRole("region", { name: "Вычислительные ресурсы" });
  await resources.getByText("8.0 GiB", { exact: true }).waitFor();
  await resources.getByText("Проверено", { exact: true }).waitFor();
  await resources.getByText("512", { exact: true }).waitFor();
  assert.equal(await resources.getByText("Ожидание замера", { exact: true }).count(), 0);
  assert.equal(await resources.getByRole("button", { name: "Перезапустить и применить автоматически", exact: true }).count(), 0);
  resourceData = { ...resourceData, configured_memory_bytes: 0, configured_cpus: 0, pids_limit: 0, resources_verified: false, resource_error: "Тест: не удалось проверить ограничения группы ресурсов сервера" };
  await resources.getByRole("alert").getByText("Тест: не удалось проверить ограничения группы ресурсов сервера", { exact: true }).waitFor();
  assert.equal(await resources.getByText("0.0 GiB", { exact: true }).count(), 0, "failed verification must not render zero as a real resource limit");
  assert.equal(await resources.getByText("8.0 GiB", { exact: true }).count(), 0, "failed verification must not retain a previously verified value");
  assert.equal(await resources.getByText("Не проверено", { exact: true }).count(), 3);
  await page.locator("#settings-back").click();
  assert.ok(nativeCalls.some((item) => item.action === "accountDevice"), "remote account must query native device capability");
  assert.ok(nativeCalls.filter((item) => item.action === "accountDevice").every((item) => item.connection_id === connection), "device operations must bind to the remote generation");
  assert.ok(requests.some((request) => request.url().includes("/api/browser/events?connection=" + connection)), "SSE must bind to the remote generation");
  for (const request of requests.filter((request) => new URL(request.url()).pathname === "/api/projects/open")) assert.equal(request.headers()["x-cage-connection"], connection);
  await page.evaluate(() => window.cageNativeAction("quit"));
  assert.ok(nativeCalls.some((item) => item.action === "quitNow" && item.connection_id === connection));
  assert.equal(state.requests.some((item) => item.path === "/account/suspend"), false);
  assert.equal(state.requests.some((item) => item.path === "/stop"), false);
  const downloadID = "de30b5c6-5460-4ebe-bdc6-343cd850ce47";
  let saved = [];
  await page.route("**/api/input/files/desktop/requests", (route) => route.fulfill({ json: { uploads: [], downloads: [{ id: downloadID, name: "report.pdf", path: "/srv/cage/Downloads/report.pdf", state: "saved", target: "desktop" }] } }));
  await page.route("**/api/browser/files/saved", (route) => route.fulfill({ json: saved }));
  await page.reload();
  await page.getByRole("button", { name: "Скачать файл", exact: true }).click();
  const downloads = page.getByRole("dialog", { name: "Скачать файл" });
  await downloads.getByText("Сохранено в облако", { exact: true }).waitFor();
  assert.equal(await downloads.getByRole("button", { name: "Открыть файл", exact: true }).count(), 0, "cloud path must not offer a local open action");
  saved = [{ id: downloadID, name: "report.pdf", path: "/tmp/cage-ui/report.pdf", instance_id: instance }];
  await page.evaluate(() => window.dispatchEvent(new Event("cage-download-saved")));
  await downloads.getByText("Сохранено на этот компьютер", { exact: true }).waitFor();
  await downloads.getByRole("button", { name: "Открыть файл", exact: true }).click();
  assert.ok(nativeCalls.some((item) => item.action === "browserDownloadAction" && item.connection_id === connection));
  state.account.unlocked = false;
  await page.reload();
  await page.getByText("Данные аккаунта хранятся на текущем облачном хосте", { exact: true }).waitFor();
  assert.ok(nativeCalls.filter((item) => item.action === "accountDevice").every((item) => item.connection_id === connection));
  assert.deepEqual(errors, []);
  console.log("PASS: remote directories, client-scoped keyboard, container resource limits, HTTP/SSE/native-account generation binding, local/cloud download distinction, password fallback and quit preserving cloud tasks");
} finally { await browser.close(); }
