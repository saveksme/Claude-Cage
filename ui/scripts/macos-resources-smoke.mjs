import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkbench } from "./workbench-fixture.mjs";

const output = process.env.CAGE_RESOURCE_QA_OUTPUT || await mkdtemp(join(tmpdir(), "cage-macos-resource-ui-"));
await mkdir(output, { recursive: true });
const requests = [];
let failSave = false, reads = 0;
const resource = { runtime: "vz-macos", memory_policy: "fixed", automatic_reclaim: false, running: true,
  automatic: false, memory_gib: 4, cpus: 2, min_memory_gib: 4, min_cpus: 2, max_memory_gib: 12, max_cpus: 5,
  minimum_requirements: { source: "existing-configuration" }, recommended_memory_bytes: 12 * 2 ** 30,
  recommended_cpus: 5, configured_memory_bytes: 4 * 2 ** 30, configured_cpus: 2, restart_required: false,
  observation: { cpus: 2, cpu_percent: null, guest: { total_bytes: 4 * 2 ** 30, available_bytes: 2 * 2 ** 30 } } };
const fixture = await createWorkbench({ beforeNavigate: async (page, state) => {
  state.account.guest_system = state.status.guest_system = "macos";
  state.status.vm_running = state.status.ready = true;
  await page.route("**/api/environment/resources", route => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON(); requests.push(body);
      if (failSave) return route.fulfill({ status: 400, contentType: "text/plain; charset=utf-8", body: "Не удалось сохранить конфигурацию ресурсов; проверьте права на диск." });
      if (body.allocation) Object.assign(resource, body.allocation, { restart_required: true });
      return route.fulfill({ json: { ok: true } });
    }
    reads++;
    resource.observation.observed_at = new Date().toISOString();
    return route.fulfill({ json: resource });
  });
} });
const { page, browser, errors } = fixture;
try {
  await page.getByRole("button", { name: "Настройки", exact: true }).click();
  await page.getByRole("navigation", { name: "Разделы настроек" }).getByRole("button", { name: "Среда и восстановление", exact: true }).click();
  const panel = page.getByRole("region", { name: "Вычислительные ресурсы", exact: true });
  await panel.getByText(/Гостевая macOS использует фиксированный объём памяти при запуске/).waitFor();
  const cpu = panel.locator(".setting-summary-row").filter({ hasText: "Загрузка CPU" }).locator("strong");
  assert.equal(await cpu.innerText(), "Ожидание замера");
  assert.equal(await panel.getByLabel("Лимит памяти (GiB)", { exact: true }).getAttribute("min"), "4");
  assert.equal(await panel.getByLabel("Число логических ядер CPU", { exact: true }).getAttribute("min"), "2");
  await panel.getByText(/Текущий минимум взят из существующей конфигурации запуска/).waitFor();
  await panel.getByLabel("Лимит памяти (GiB)", { exact: true }).fill("3");
  await panel.getByRole("button", { name: "Сохранить ресурсы", exact: true }).click();
  assert.equal(requests.length, 0);
  await panel.getByLabel("Лимит памяти (GiB)", { exact: true }).fill("6");
  await panel.getByLabel("Число логических ядер CPU", { exact: true }).fill("3");
  await panel.getByRole("button", { name: "Сохранить ресурсы", exact: true }).click();
  await panel.getByText("Сохранено. Изменения вступят в силу после перезапуска среды.", { exact: true }).waitFor();
  assert.deepEqual(requests[0].allocation, { automatic: false, memory_gib: 6, cpus: 3 });
  failSave = true;
  await panel.getByLabel("Лимит памяти (GiB)", { exact: true }).fill("8");
  await panel.getByRole("button", { name: "Сохранить ресурсы", exact: true }).click();
  const error = panel.getByRole("alert").filter({ hasText: "Не удалось сохранить конфигурацию ресурсов" });
  await error.waitFor();
  const before = reads;
  resource.observation.cpu_percent = 50;
  await cpu.getByText("50% / 2 ядер", { exact: true }).waitFor({ timeout: 6000 });
  assert.ok(reads > before);
  assert.ok(await error.isVisible());
  failSave = false;
  await panel.getByRole("button", { name: "Перезапустить и применить сохранённую конфигурацию", exact: true }).click();
  await page.getByRole("dialog", { name: "Перезапустить и применить сохранённые ресурсы?", exact: true }).getByRole("button", { name: "Перезапустить и применить", exact: true }).click();
  await error.waitFor({ state: "hidden" });
  assert.deepEqual(requests.at(-1), {});
  await panel.getByRole("heading", { name: "Вычислительные ресурсы", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(output, "macos-resources.png"), animations: "disabled" });
  await panel.getByText("О показателях ресурсов", { exact: true }).click();
  await panel.getByText(/Оценка памяти использует физический объём гостевой системы/).scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(output, "macos-resource-observation.png"), animations: "disabled" });
  assert.deepEqual(errors, []);
  const result = { passed: true, browser: browser.browserType().name(), requests, reads,
    checks: ["Mac fixed-capacity policy and minimum source visible", "first CPU sample unknown", "minimum enforced before save", "saved allocation waits for restart", "polling preserves save failure", "restart uses existing confirmation and shared endpoint"] };
  await writeFile(join(output, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally { await browser.close(); }
