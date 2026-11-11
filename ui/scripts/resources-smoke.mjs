import assert from "node:assert/strict";
import { createWorkbench } from "./workbench-fixture.mjs";

const { browser, page, errors } = await createWorkbench();
const windowsRuntime = process.env.CAGE_RESOURCE_RUNTIME === "hyperv";
let allocation = { automatic: true, memory_gib: 12, cpus: 5 };
let rejectSave = false;
const saves = [];
await page.route("**/api/environment/resources", async (route) => {
  if (route.request().method() === "POST") {
    if (rejectSave) return route.fulfill({ status: 400, contentType: "text/plain; charset=utf-8", body: "Не удалось сохранить конфигурацию ресурсов" });
    const body = route.request().postDataJSON();
    saves.push(body);
    if (body.allocation) allocation = body.allocation.automatic ? { automatic: true, memory_gib: 12, cpus: 5 } : body.allocation;
    return route.fulfill({ json: { ok: true } });
  }
  return route.fulfill({ json: { ...allocation, ...(windowsRuntime ? { runtime: "hyperv", min_memory_gib: 4, min_cpus: 2 } : {}), running: false, recommended_memory_bytes: 12 * 2 ** 30, recommended_cpus: 5, max_memory_gib: 12, max_cpus: 5 } });
});
async function open() {
  await page.getByRole("button", { name: "Настройки", exact: true }).click();
  await page.getByRole("navigation", { name: "Разделы настроек" }).getByRole("button", { name: "Среда и восстановление", exact: true }).click();
  await page.getByLabel("Лимит памяти (GiB)", { exact: true }).waitFor();
}
try {
  await open();
  assert.equal(await page.getByRole("button", { name: "Сохранить ресурсы", exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole("button", { name: "Вернуть по умолчанию", exact: true }).isDisabled(), true);
  if (windowsRuntime) {
    assert.equal(await page.getByLabel("Лимит памяти (GiB)", { exact: true }).getAttribute("min"), "4");
    assert.equal(await page.getByLabel("Число логических ядер CPU", { exact: true }).getAttribute("min"), "2");
    await page.getByLabel("Лимит памяти (GiB)", { exact: true }).fill("3");
    await page.getByRole("button", { name: "Сохранить ресурсы", exact: true }).click();
    assert.equal(saves.length, 0);

  }
  await page.getByLabel("Лимит памяти (GiB)", { exact: true }).fill("4");
  await page.getByLabel("Число логических ядер CPU", { exact: true }).fill("2");
  assert.equal(await page.getByText("Несохранённых изменений нет", { exact: true }).count(), 0);
  await page.getByRole("button", { name: "Вернуться в рабочую среду", exact: true }).click();
  const discard = page.getByRole("dialog", { name: "Отменить несохранённые изменения?", exact: true });
  await discard.waitFor();
  await discard.getByRole("button", { name: "Отмена", exact: true }).click();
  assert.equal(await page.getByLabel("Лимит памяти (GiB)", { exact: true }).inputValue(), "4");
  await page.screenshot({ path: "/tmp/cage-resource-settings.png", fullPage: true });
  await page.getByRole("button", { name: "Сохранить ресурсы", exact: true }).click();
  await page.getByText("Сохранено. изменения вступят в силу при следующем запуске среды.", { exact: true }).waitFor();
  assert.deepEqual(allocation, { automatic: false, memory_gib: 4, cpus: 2 });
  await page.reload();
  await open();
  assert.equal(await page.getByLabel("Лимит памяти (GiB)", { exact: true }).inputValue(), "4");
  assert.equal(await page.getByLabel("Число логических ядер CPU", { exact: true }).inputValue(), "2");
  const count = saves.length;
  await page.getByLabel("Лимит памяти (GiB)", { exact: true }).fill("13");
  await page.getByRole("button", { name: "Сохранить ресурсы", exact: true }).click();
  assert.equal(saves.length, count);
  await page.getByLabel("Лимит памяти (GiB)", { exact: true }).fill("6");
  rejectSave = true;
  await page.getByRole("button", { name: "Сохранить ресурсы", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "Не удалось сохранить конфигурацию ресурсов" }).waitFor();
  await page.waitForResponse(response => response.url().endsWith("/api/environment/resources") && response.request().method() === "GET" && response.ok());

  assert.equal(await page.getByRole("alert").filter({ hasText: "Не удалось сохранить конфигурацию ресурсов" }).isVisible(), true);
  assert.equal(await page.getByLabel("Лимит памяти (GiB)", { exact: true }).inputValue(), "6");
  rejectSave = false;
  await page.getByRole("button", { name: "Вернуть по умолчанию", exact: true }).click();
  assert.equal(await page.getByLabel("Лимит памяти (GiB)", { exact: true }).inputValue(), "12");
  assert.equal(await page.getByLabel("Число логических ядер CPU", { exact: true }).inputValue(), "5");
  assert.equal(allocation.automatic, false, "reset stays a draft until saved");
  await page.getByRole("button", { name: "Сохранить ресурсы", exact: true }).click();
  await page.getByText("Сохранено. изменения вступят в силу при следующем запуске среды.", { exact: true }).waitFor();
  assert.equal(allocation.automatic, true);
  await page.reload();
  await open();
  assert.equal(await page.getByRole("button", { name: "Вернуть по умолчанию", exact: true }).isDisabled(), true);
  assert.equal(await page.getByLabel("Лимит памяти (GiB)", { exact: true }).inputValue(), "12");
  assert.equal(await page.getByRole("alert").filter({ hasText: "Не удалось сохранить конфигурацию ресурсов" }).count(), 0);
  assert.deepEqual(errors, []);
  console.log("Resource settings: manual save, reload, bounds, failure retention, defaults, editing, reset and persistence passed.");
} finally { await browser.close(); }
