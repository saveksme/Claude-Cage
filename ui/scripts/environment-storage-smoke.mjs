import assert from "node:assert/strict";
import { createWorkbench } from "./workbench-fixture.mjs";

const platform = process.env.CAGE_STORAGE_PLATFORM || "windows";
const { browser, page, state, errors } = await createWorkbench({
  viewport: { width: Number(process.env.CAGE_STORAGE_WIDTH || 1280), height: 850 },
  clientContext: { mode: "local", connection_id: "local", client_platform: platform, server_platform: platform, connection: { state: "disconnected" } },
});
try {
  state.status.local_vm_storage = true;
  const windows = platform === "windows";
  let location = { directory: windows ? "C:\\Users\\demo\\.claude-cage\\state" : "/home/demo/.claude-cage/state", has_environment: false };
  const writes = [];
  const destination = windows ? "D:\\Инструменты разработки\\Среда Cage" : "/Volumes/Инструменты разработки/Среда Cage";
  const occupied = windows ? "E:\\occupied" : "/mnt/occupied";
  const migrated = windows ? "E:\\Среда Cage" : "/mnt/Среда Cage";
  await page.route("**/api/environment/storage", (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: location });
    const input = route.request().postDataJSON();
    writes.push(input);
    const rejected = input.directory.endsWith("occupied");
    const job = { kind: "storage", id: String(writes.length), running: !rejected && input.migrate, error: rejected ? "Каталог должен быть пустым" : "", message: "Копирование и проверка виртуального диска; не закрывайте Cage." };
    state.status.job = job;
    if (!rejected && !job.running) location = { ...location, directory: input.directory, backup: location.has_environment ? location.directory : "" };
    return route.fulfill({ json: job });
  });
  await page.getByRole("button", { name: "Выбрать место хранения среды" }).click();
  const panel = page.getByRole("region", { name: "Хранилище локальной среды" });
  const picker = panel.getByRole("button", { name: "Выбрать папку" });
  const target = panel.getByLabel("Новое место хранения");
  state.chosenFolder = "";
  await picker.click();
  assert.equal(await target.inputValue(), "");
  state.chosenFolder = destination;
  await picker.click();
  await page.waitForFunction((path) => [...document.querySelectorAll("input")].some((input) => input.value === path), destination);
  await panel.getByRole("button", { name: "Использовать это место" }).click();
  await panel.getByText(destination, { exact: true }).waitFor();
  assert.equal(writes[0].migrate, false);
  location.has_environment = true;
  await page.reload();
  await page.getByRole("button", { name: "Выбрать место хранения среды" }).click();
  await panel.getByText(destination, { exact: true }).waitFor();
  await target.fill(occupied);
  await panel.getByRole("button", { name: "Перенести сюда" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Отмена" }).click();
  assert.equal(writes.length, 1);
  await panel.getByRole("button", { name: "Перенести сюда" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Перенести среду" }).click();
  await panel.getByText("Каталог должен быть пустым", { exact: true }).waitFor();
  await target.fill(migrated);
  await panel.getByRole("button", { name: "Перенести сюда" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Перенести среду" }).click();
  const progress = panel.getByRole("status");
  await progress.waitFor();
  const actions = panel.locator(".storage-actions");
  await actions.scrollIntoViewIfNeeded();
  const geometry = await panel.evaluate((element) => {
    const buttons = element.querySelector(".storage-actions").getBoundingClientRect();
    const status = element.querySelector('[role="status"]').getBoundingClientRect();
    return { buttonsBottom: buttons.bottom, statusTop: status.top };
  });
  if (process.env.CAGE_STORAGE_SCREENSHOT) {
    await panel.getByRole("heading", { name: "Хранилище локальной среды" }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: process.env.CAGE_STORAGE_SCREENSHOT });
  }
  assert.ok(geometry.statusTop >= geometry.buttonsBottom + 8, `Migration status overlaps actions: ${JSON.stringify(geometry)}`);
  for (const button of await actions.getByRole("button").all()) {
    assert.equal(await button.isDisabled(), true);
    assert.equal(await button.evaluate((element) => getComputedStyle(element).opacity), "1");
  }
  assert.equal(await target.isDisabled(), true);
  assert.equal(writes.length, 3);
  location = { ...location, directory: writes.at(-1).directory, backup: location.directory };
  state.status.job = { ...state.status.job, running: false };
  await panel.getByText(migrated, { exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector('.environment-storage input').disabled);
  assert.equal(await progress.count(), 0);
  assert.equal(writes.at(-1).migrate, true);
  assert.equal(writes.at(-1).previous, destination);
  assert.equal(await panel.locator("code").textContent(), destination);
  assert.deepEqual(errors, []);
  console.log(`Storage selection, picker cancellation, migration confirmation, running layout, failure and backup location passed (${platform}, ${process.env.CAGE_TEST_BROWSER || "chromium"}, ${page.viewportSize().width}px; status gap ${geometry.statusTop - geometry.buttonsBottom}px)`);
} finally { await browser.close(); }
