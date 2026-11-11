import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createWorkbench } from "./workbench-fixture.mjs";

const failure = "Проверка сети не пройдена: язык браузера не прошёл. Язык не соответствует сохранённым настройкам. Проверьте языковые настройки и повторите проверку. Внешняя сеть остаётся закрытой.";
const output = process.env.CAGE_SAFETY_SCREENSHOTS || "/tmp/cage-safety-checklist";
await mkdir(output, { recursive: true });
const platforms = process.env.CAGE_TEST_BROWSER === "webkit" ? ["darwin"] : ["darwin", "windows", "linux"];

for (const platform of platforms) {
  const { browser, page, state, errors } = await createWorkbench({
    clientContext: { mode: "local", connection_id: "local", client_platform: platform, server_platform: platform, connection: { state: "disconnected" } },
    // Session history is unrelated to this check. Resolve its poll immediately
    // so WebKit does not report a cancelled poll when this test reloads pages.
    beforeNavigate: page => page.addInitScript(() => {
      const fetch = window.fetch;
      window.fetch = (input, ...args) => String(input) === "/api/cli/sessions"
        ? Promise.resolve(new Response('{"sessions":[]}', { headers: { "Content-Type": "application/json" } }))
        : fetch(input, ...args);
    }),
  });
  const checklist = page.getByRole("dialog", { name: "Сеть и проверки изоляции", exact: true });
  const link = parent => parent.getByRole("button", { name: "Открыть список проверок", exact: true });
  const showChecklist = async (button, keyboard = false) => {
    if (keyboard) { await button.focus(); await button.press("Enter"); }
    else await button.click();
    await checklist.waitFor();
    assert.equal(await page.getByRole("dialog").evaluateAll(nodes => nodes.at(-1).getAttribute("aria-label")), "Проверка сети и изоляции");
    await checklist.getByRole("heading", { name: "Ключевые проверки", exact: true }).waitFor();
    await checklist.getByText("1 / 2 пройдено", { exact: true }).waitFor();
    const failed = checklist.locator("details").filter({ hasText: "Язык браузера" });
    await failed.locator("summary").click();
    await failed.getByText("Язык не соответствует сохранённым настройкам", { exact: true }).waitFor();
    await failed.getByText("Проверьте языковые настройки и повторите проверку", { exact: true }).waitFor();
  };
  const closeChecklist = async () => {
    await page.keyboard.press("Escape");
    await checklist.waitFor({ state: "hidden" });
  };
  try {
    Object.assign(state.status, {
      ready: true, vm_running: true,
      job: { id: "failed-check", kind: "safety", running: false, error: failure, message: "Проверка среды не завершена", log: "fixture check log" },
      safety: {
        gate: { mode: "closed", reason: failure }, error: failure,
        report: { created_at: new Date().toISOString(), checks: [
          { id: "dns", title: "Шифрованный DNS", critical: true, state: "passed", evidence: "DNS проходит через указанный прокси" },
          { id: "browser", title: "Язык браузера", critical: true, state: "failed", evidence: "Язык не соответствует сохранённым настройкам", remedy: "Проверьте языковые настройки и повторите проверку" },
        ] },
      },
    });
    await page.reload();
    const homeError = page.getByRole("alert").filter({ hasText: failure });
    await link(homeError).waitFor();
    await page.screenshot({ path: `${output}/${platform}-failure.png` });
    const postCount = () => state.requests.filter(r => r.method === "POST").length;
    const beforeOpening = postCount();
    await showChecklist(link(homeError), true);
    await page.screenshot({ path: `${output}/${platform}-checklist.png` });
    await closeChecklist();
    assert.equal(postCount(), beforeOpening, "viewing a checklist must not start checks or open networking");
    assert.equal(await link(homeError).evaluate(node => node === document.activeElement), true);

    const feedback = page.locator(".status-feedback");
    state.status.job = { ...state.status.job, id: "failed-check-notification" };
    await link(feedback).waitFor();
    await showChecklist(link(feedback));
    await closeChecklist();

    await page.getByRole("button", { name: "Посмотреть подробности операции", exact: true }).click();
    const details = page.getByRole("dialog", { name: "Подробности операции", exact: true });
    await showChecklist(link(details));
    await closeChecklist();
    assert.equal(await details.isVisible(), true, "closing the checklist must preserve operation details");
    await details.getByRole("button", { name: "Закрыть панель", exact: true }).click();

    state.status.job.setup_progress = { phase: "services", label: "Службы среды" };
    await page.reload();
    const setup = page.getByRole("region", { name: "Ход установки среды", exact: true });
    await showChecklist(link(setup));
    await closeChecklist();
    delete state.status.job.setup_progress;
    await page.reload();

    await page.route("**/api/settings/probe", route => route.fulfill({ status: 409, contentType: "text/plain; charset=utf-8", body: failure }));
    await page.getByRole("button", { name: "Настройки", exact: true }).click();
    await page.getByRole("navigation", { name: "Разделы настроек" }).getByRole("button", { name: "Сеть и прокси", exact: true }).click();
    const settings = page.getByRole("region", { name: "Настройки", exact: true });
    const dns = settings.getByLabel("Шифрованный DNS", { exact: true });
    await dns.fill("https://example.com/dns-query");
    await settings.getByRole("button", { name: "Проверить выход", exact: true }).click();
    const settingsError = settings.getByRole("alert").filter({ hasText: failure });
    await showChecklist(link(settingsError), true);
    await closeChecklist();
    assert.equal(await dns.inputValue(), "https://example.com/dns-query", "viewing checks must preserve unsaved settings");
    assert.equal(await settings.isVisible(), true);
    await dns.fill(state.settings.dns_url);

    await page.route("**/api/proxy/route", route => route.fulfill({ status: 409, contentType: "text/plain; charset=utf-8", body: "Данных ключевых проверок недостаточно, внешняя сеть остаётся закрытой" }));
    await settings.getByRole("button", { name: "Применить заново", exact: true }).click();
    const proxyError = settings.getByRole("alert").filter({ hasText: "Данных ключевых проверок недостаточно" });
    await showChecklist(link(proxyError));
    await closeChecklist();
    await settings.getByRole("button", { name: "Вернуться в рабочую среду", exact: true }).first().click();

    await page.route("**/api/projects/open", route => route.fulfill({ status: 409, contentType: "text/plain; charset=utf-8", body: failure }));
    await page.getByRole("button", { name: "Открыть проект", exact: true }).click();
    const projects = page.getByRole("dialog", { name: "Открыть проект", exact: true });
    await projects.getByRole("button", { name: "Открыть проект", exact: true }).click();
    await showChecklist(link(projects));
    await closeChecklist();
    assert.equal(await projects.isVisible(), true);
    await projects.getByRole("button", { name: "Отмена", exact: true }).click();

    for (const viewport of [{ width: 820, height: 558 }, { width: 560, height: 812 }]) {
      await page.setViewportSize(viewport);
      if (viewport.width === 560) await page.getByRole("button", { name: "Свернуть боковую панель", exact: true }).click();
      await showChecklist(link(homeError));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await closeChecklist();
      await page.screenshot({ path: `${output}/${platform}-${viewport.width}.png` });
    }

    state.status.job = { ...state.status.job, id: "unrelated-error", error: "Ошибка подключения к папкам проекта" };
    await page.reload();
    const unrelated = page.getByRole("alert").filter({ hasText: "Ошибка подключения к папкам проекта" });
    await unrelated.waitFor();
    assert.equal(await link(unrelated).count(), 0);
    assert.equal(state.status.safety.gate.mode, "closed");
    assert.deepEqual(errors, []);
    console.log(`PASS ${platform}: home, notification, details, setup, settings, proxy, project, keyboard, return focus, compact layout and no mutations`);
  } finally { await browser.close(); }
}
