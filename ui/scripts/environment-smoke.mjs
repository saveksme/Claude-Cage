import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createWorkbench } from "./workbench-fixture.mjs";

const output = new URL(
  "../../docs/test-reports/2026-10-31-environment/",
  import.meta.url,
);
await fs.mkdir(output, { recursive: true });
const { browser, page, state, errors } = await createWorkbench();
const shot = (name) =>
  page.screenshot({
    path: fileURLToPath(new URL(name + ".png", output)),
    animations: "disabled",
  });
try {
  assert.equal(
    await page.getByRole("button", { name: "Добавить проект", exact: true }).isDisabled(),
    true,
  );
  assert.equal(
    await page.getByRole("button", { name: /Открыть браузер/ }).isDisabled(),
    true,
  );
  assert.equal(await page.locator(".environment-shield.healthy").count(), 0);
  assert.equal(await page.locator(".recent-projects").count(), 0);
  await shot("stopped");
  await page
    .getByRole("button", { name: "Запустить среду Cage", exact: true })
    .click();
  await page.getByRole("heading", { name: "Среда Cage готова" }).waitFor();
  await page.getByText("Среда работает нормально", { exact: true }).waitFor();
  assert.ok(
    (await page
      .getByRole("img", { name: "Среда работает нормально, проверка сети пройдена" })
      .count()) >= 2,
  );
  assert.equal(state.saves.length, 0);
  const links = await page
    .getByRole("navigation", { name: "Основная навигация" })
    .getByRole("button")
    .allTextContents();
  assert.match(links[0], /Рабочая среда/);
  assert.match(links[1], /Браузер/);
  await shot("running");
  await page.getByRole("button", { name: /Открыть браузер/ }).click();
  await page.getByLabel("Адрес страницы или поисковый запрос").waitFor();
  await page.waitForFunction(
    () =>
      document.querySelector('[aria-label="Адрес страницы или поисковый запрос"]')?.value ===
      "https://www.bing.com/",
  );
  assert.equal(state.tabs[0].url, "https://www.bing.com/");
  await page.getByRole("button", { name: "Меню браузера", exact: true }).click();
  await page.getByRole("menuitem", { name: "Настройки", exact: true }).click();
  await page.getByLabel("Адрес новой вкладки", { exact: true }).fill("https://example.com/start");
  assert.equal(
    await page.getByRole("button", { name: "Сохранить и перезапустить", exact: true }).count(),
    0,
  );
  const starts = state.requests.filter((r) => r.path === "/start").length;
  await shot("settings");
  await page.getByRole("button", { name: "Сохранить адрес", exact: true }).click();
  await page.getByText("Сохранено", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Закрыть Настройки", exact: true }).click();
  assert.equal(state.settings.browser_home_url, "https://example.com/start");
  assert.equal(
    state.requests.filter((r) => r.path === "/start").length,
    starts,
  );
  await page.reload();
  await page.getByRole("heading", { name: "Среда Cage готова" }).waitFor();
  await page.getByRole("button", { name: /Открыть браузер/ }).click();
  await page.getByRole("button", { name: "Новая страница", exact: true }).click();
  await page.waitForFunction(
    () =>
      document.querySelector('[aria-label="Адрес страницы или поисковый запрос"]')?.value ===
      "https://example.com/start",
  );
  state.status.safety.gate.until = new Date(Date.now() - 1000).toISOString();
  await page.getByText("Доступно офлайн", { exact: true }).waitFor();
  assert.equal(await page.locator(".environment-shield.healthy").count(), 0);
  await page.getByRole("button", { name: "Рабочая среда", exact: true }).click();
  await shot("offline");
  state.status.ready = false;
  state.status.vm_running = false;
  await page.getByRole("heading", { name: "Сначала запустите среду Cage" }).waitFor();
  assert.equal(await page.locator(".environment-shield.healthy").count(), 0);
  await page.setViewportSize({ width: 820, height: 558 });
  await shot("minimum");
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await page.getByRole("button", { name: "Свернуть боковую панель" }).click();
  await page.setViewportSize({ width: 375, height: 812 });
  await shot("compact");
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  assert.deepEqual(errors, []);
  const result = {
    passed: true,
    checks: [
      "Сначала запустите среду, проект выбирать не нужно",
      "Вход в браузер сразу после рабочей среды",
      "При действующем разрешении показывается зелёный щит с галочкой, при истечении и остановке он снимается",
      "Bing по умолчанию, свой сайт сохраняется и читается после обновления, применяется при следующем открытии",
      "Сайт по умолчанию сохраняется без перезапуска",
      "Макеты 820×558 и 375px",
    ],
    scope: "Playwright + mock API; VM behavior is verified separately.",
  };
  await fs.writeFile(
    new URL("smoke-result.json", output),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
}
