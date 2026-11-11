import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createWorkbench } from "./workbench-fixture.mjs";

const output = fileURLToPath(new URL("../../docs/test-reports/2026-11-07-paired-phone-model/", import.meta.url));
await fs.mkdir(output, { recursive: true });
let paired = true, device = null, rejectRemove = false, removals = 0;
let power = {active:true};
let holdNextStatus = false, releaseStatus;
let signalStatus, signalDelivered;
const statusHeld = new Promise(resolve => { signalStatus = resolve; });
const statusDelivered = new Promise(resolve => { signalDelivered = resolve; });
const { browser, page, errors } = await createWorkbench({
  beforeNavigate: async page => page.route("**/api/mobile-pair", async route => {
    if (route.request().method() === "GET" && holdNextStatus) {
      holdNextStatus = false;
      const snapshot = { paired, status: "", device };
      await new Promise(resolve => { releaseStatus = resolve; signalStatus(); });
      await route.fulfill({ json: snapshot });
      signalDelivered();
      return;
    }
    if (route.request().method() === "DELETE") {
      if (rejectRemove) return route.fulfill({ status: 500, contentType:"text/plain; charset=utf-8", body: "Не удалось удалить телефон; повторите" });
      paired = false; device = null; removals++;
    }
    return route.fulfill({ json: { paired, status: "", device, keep_awake:power } });
  }),
});
async function open() {
  await page.getByRole("button", { name: "Настройки", exact: true }).click();
  await page.getByRole("navigation", { name: "Разделы настроек" }).getByRole("button", { name: "Удалённое подключение", exact: true }).click();
  await page.getByRole("heading", { name: "Телефон сопряжён", exact: true }).waitFor();
}
async function confirmRemoval() {
  await page.getByRole("button", { name: "Удалить сопряжённый телефон", exact: true }).click();
  await page.getByRole("heading", { name: "Удалить сопряжённый телефон?", exact: true }).waitFor();
}
try {
  await open();
  await page.getByText("Удалённый режим ожидания запросил у хоста оставаться включённым; экран может нормально гаснуть. После удаления сопряжения или остановки фоновой службы восстанавливается прежняя политика сна.",{exact:true}).waitFor();
  power = {active:false,error:"Тест: система не разрешила предотвращение сна"};
  await page.getByRole("alert").filter({hasText:"Защита хоста от сна не действует: Тест: система не разрешила предотвращение сна"}).waitFor();
  power = {active:true};
  await page.getByRole("alert").filter({hasText:"Защита хоста от сна не действует"}).waitFor({state:"hidden"});
  await page.getByText("Модель пока неизвестна. Обновите Cage на телефоне и подключитесь заново.", { exact: true }).waitFor();
  device = { platform: "android", model: "Google Pixel 9 Pro" };
  await page.getByLabel("Сопряжённый телефон", { exact: true }).getByText(device.model, { exact: true }).waitFor();
  assert.equal(await page.getByLabel("Сопряжённый телефон", { exact: true }).innerText(), "Google Pixel 9 Pro\nAndroid");
  await page.screenshot({ path: output + "android-model.png", fullPage: true });
  await page.reload(); await open();
  await page.getByLabel("Сопряжённый телефон", { exact: true }).getByText(device.model, { exact: true }).waitFor();
  await confirmRemoval();
  await page.getByText("После удаления Google Pixel 9 Pro этому телефону потребуется заново отсканировать код для доступа к рабочей среде.", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Отмена", exact: true }).click();
  assert.equal(removals, 0);

  device = { platform: "ios", model: "iPhone 16 Pro" };
  await page.getByLabel("Сопряжённый телефон", { exact: true }).getByText(device.model, { exact: true }).waitFor();
  await page.getByLabel("Сопряжённый телефон", { exact: true }).getByText("iOS", { exact: true }).waitFor();
  await page.screenshot({ path: output + "iphone-model.png", fullPage: true });
  rejectRemove = true;
  await confirmRemoval();
  await page.getByRole("button", { name: "Удалить телефон", exact: true }).click();
  await page.getByText("Не удалось удалить телефон; повторите", { exact: true }).waitFor();
  await page.getByLabel("Сопряжённый телефон", { exact: true }).getByText(device.model, { exact: true }).waitFor();
  rejectRemove = false;
  holdNextStatus = true;
  await statusHeld;
  await confirmRemoval();
  await page.getByRole("button", { name: "Удалить телефон", exact: true }).click();
  await page.getByRole("heading", { name: "Подключите телефон к Cage", exact: true }).waitFor();
  releaseStatus();
  await statusDelivered;
  await page.getByRole("heading", { name: "Подключите телефон к Cage", exact: true }).waitFor();
  assert.equal(await page.getByLabel("Сопряжённый телефон", { exact: true }).count(), 0);
  assert.equal(removals, 1);
  assert.deepEqual(errors, []);
  console.log("Paired phone model: legacy fallback, live Android/iOS metadata, reload, cancel, failed removal, successful removal and stale polling response passed.");
} finally { await browser.close(); }
