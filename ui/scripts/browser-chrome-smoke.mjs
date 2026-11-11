// Real DOM pointer interactions and real favorites persistence; browser/VM tabs
// use the existing isolated fixture and never touch the user's environment.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chooseInline, createWorkbench } from "./workbench-fixture.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const output = path.join(
  root,
  "docs/test-reports/2026-11-01-browser-tabs-favorites",
);
await fs.mkdir(output, { recursive: true });
const profile = await fs.mkdtemp(path.join(os.tmpdir(), "cage-favorites-qa-"));
await fs.writeFile(path.join(profile, "config.json"), "{}", { mode: 0o600 });
await fs.writeFile(
  path.join(profile, "workbench.json"),
  JSON.stringify({ workspace: path.join(profile, "workspace") }),
  { mode: 0o600 },
);
let service, origin, cookie, browser;
const checks = [];
async function stop() {
  if (!service || service.exitCode !== null) return;
  await new Promise((resolve) => {
    service.once("exit", resolve);
    service.kill("SIGTERM");
  });
}
async function start() {
  await fs.rm(path.join(profile, "control.json"), { force: true });
  service = spawn(path.join(root, "_output/bin/cage"), ["serve"], {
    env: {
      ...process.env,
      CLAUDE_CAGE_CONFIG: path.join(profile, "config.json"),
    },
    stdio: "ignore",
  });
  let control;
  for (let i = 0; i < 100; i++) {
    try {
      control = JSON.parse(
        await fs.readFile(path.join(profile, "control.json"), "utf8"),
      );
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  assert.ok(control, "isolated control service did not start");
  origin = `http://localhost:${control.port}`;
  const launch = await fetch(origin + "/api/launch", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ token: control.token }),
  });
  const { url } = await launch.json();
  const session = await fetch(origin + "/api/session", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ token: new URL(url).hash.slice(1) }),
  });
  cookie = session.headers.get("set-cookie").split(";")[0];
  const headers = { Origin: origin, Cookie: cookie, "Content-Type": "application/json" };
  const account = await (await fetch(origin + "/api/account", { headers })).json();
  const password = "favorites-fixture-only";
  const unlocked = await fetch(origin + "/api/account/" + (account.exists ? "unlock" : "create"), {
    method: "POST", headers, body: JSON.stringify({ username: "bookmarks-qa", password, confirm_password: password }),
  });
  assert.ok(unlocked.ok, "the isolated favorites fixture requires an unlocked local account");
}
try {
  await start();
  const fixture = await createWorkbench({
    favoritesRequest: async (request) => {
      const response = await fetch(origin + "/api/favorites", {
        method: request.method(),
        headers: {
          Origin: origin,
          Cookie: cookie,
          "Content-Type": "application/json",
        },
        body: request.postData() || undefined,
      });
      return {
        status: response.status,
        contentType: response.headers.get("content-type"),
        body: await response.text(),
      };
    },
  });
  browser = fixture.browser;
  const { page, state, errors } = fixture;
  const shot = (name) =>
    page.screenshot({
      path: path.join(output, name + ".png"),
      animations: "disabled",
    });
  const tabs = page.getByRole("tablist", { name: "Вкладки браузера" });
  await page
    .getByRole("button", { name: "Запустить среду Cage", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Среда Cage готова", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Открыть браузер", exact: true }).click();
  await tabs.getByRole("tab").waitFor();
  await page.getByRole("button", { name: "Новая страница", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelectorAll('.browser-tabs [role="tab"]').length === 2,
  );
  for (let i = 3; i <= 8; i++)
    state.tabs.push({
      id: "qa-" + i,
      kind: "web",
      title: "Документ дизайна " + i,
      url: `https://example.com/${i}`,
    });
  await page.waitForFunction(
    () => document.querySelectorAll('.browser-tabs [role="tab"]').length === 8,
  );
  await page.waitForFunction(() => {
    const list = document.querySelector(".browser-tabs");
    return (
      list.querySelector(".active").getBoundingClientRect().width >
      list.querySelector(".browser-tab:not(.active)").getBoundingClientRect()
        .width +
        20
    );
  });
  let layout = await page.evaluate(() => {
    const list = document.querySelector(".browser-tabs");
    const active = list.querySelector(".active").getBoundingClientRect();
    const add = document
      .querySelector(".browser-new-tab")
      .getBoundingClientRect();
    return {
      overflow: list.scrollWidth > list.clientWidth + 1,
      active: active.width,
      other: list.querySelector(":not(.active)").getBoundingClientRect().width,
      centers: Math.abs(active.y + active.height / 2 - add.y - add.height / 2),
    };
  });
  assert.equal(layout.overflow, false);
  assert.ok(layout.active > layout.other);
  assert.ok(layout.centers < 1);
  await shot("desktop-tabs");
  const from = tabs.getByRole("tab", { name: "Документ дизайна 3", exact: true });
  const to = tabs.getByRole("tab", { name: "Документ дизайна 6", exact: true });
  const initial = await from.boundingBox(),
    target = await to.boundingBox();
  const before = await to.boundingBox();
  await page.mouse.move(initial.x + initial.width / 2, initial.y + 16);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width - 6, target.y + 16, {
    steps: 18,
  });
  await page.locator(".browser-tab.dragging").waitFor();
  assert.ok(
    Math.abs((await from.boundingBox()).x - initial.x) > 100,
    "dragged tab must follow pointer before mouseup",
  );
  await page.waitForFunction(
    (x) =>
      document.querySelector('[data-tab-id="qa-6"]').getBoundingClientRect().x <
      x - 20,
    before.x,
  );
  await shot("drag-in-progress");
  await page.mouse.up();
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll(".browser-tab")].findIndex(
        (e) => e.dataset.tabId === "qa-3",
      ) >
      [...document.querySelectorAll(".browser-tab")].findIndex(
        (e) => e.dataset.tabId === "qa-6",
      ),
  );
  const ordered = await tabs.getByRole("tab").allTextContents();
  const again = await from.boundingBox();
  await page.mouse.move(again.x + 20, again.y + 16);
  await page.mouse.down();
  await page.mouse.move(again.x - 200, again.y + 16, { steps: 12 });
  await page.keyboard.press("Escape");
  await page.mouse.up();
  assert.deepEqual(await tabs.getByRole("tab").allTextContents(), ordered);
  await page.reload();
  await page.getByRole("button", { name: "Открыть браузер", exact: true }).click();
  assert.deepEqual(await tabs.getByRole("tab").allTextContents(), ordered);
  checks.push(
    "8 tabs: aligned add button, active expansion, pointer tracking and live neighbor movement, Escape cancellation, persisted order",
  );

  await tabs.getByRole("tab", { name: "Документ дизайна 3", exact: true }).click();
  await page.getByRole("button", { name: "Добавить страницу в закладки", exact: true }).click();
  await page.getByLabel("Название закладки", { exact: true }).fill("Материалы по дизайну Cage");
  await page.getByLabel("Название новой папки закладок", { exact: true }).fill("Рабочие материалы");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Добавить закладку", exact: true })
    .waitFor({ state: "hidden" });
  await page
    .getByRole("button", { name: "Изменить закладку этой страницы", exact: true })
    .waitFor();
  let saved = JSON.parse(
    await fs.readFile(path.join(profile, "favorites.json"), "utf8"),
  );
  assert.equal(saved.items[0].title, "Материалы по дизайну Cage");
  assert.equal(saved.folders[0].title, "Рабочие материалы");
  await page.keyboard.press("Meta+d");
  await page.getByLabel("Название закладки", { exact: true }).fill("Закладка для повтора");
  // Make the real persistence path unreadable as a file, then restore it.
  await fs.rename(
    path.join(profile, "favorites.json"),
    path.join(profile, "favorites.backup"),
  );
  await fs.mkdir(path.join(profile, "favorites.json"));
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Изменить закладку", exact: true })
    .getByRole("alert")
    .waitFor();
  assert.equal(
    await page.getByLabel("Название закладки", { exact: true }).inputValue(),
    "Закладка для повтора",
  );
  await fs.rmdir(path.join(profile, "favorites.json"));
  await fs.rename(
    path.join(profile, "favorites.backup"),
    path.join(profile, "favorites.json"),
  );
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Изменить закладку", exact: true })
    .waitFor({ state: "hidden" });
  await stop();
  await start();
  await page.reload();
  await page.getByRole("button", { name: "Открыть браузер", exact: true }).click();
  await page.keyboard.press("Meta+Shift+o");
  const panel = page.getByRole("dialog", { name: "Закладки", exact: true });
  await panel
    .getByRole("button", { name: "Изменить закладку Закладка для повтора", exact: true })
    .waitFor();
  await shot("favorites");
  await page.getByLabel("Поиск закладок", { exact: true }).fill("не существует");
  await panel.getByText("Закладки не найдены").waitFor();
  await page.getByLabel("Поиск закладок", { exact: true }).fill("example.com/3");
  await panel
    .getByRole("button", { name: "Изменить закладку Закладка для повтора", exact: true })
    .click();
  await chooseInline(page.getByLabel("Сохранить в папку закладок", { exact: true }), "");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Изменить закладку", exact: true })
    .waitFor({ state: "hidden" });
  saved = JSON.parse(
    await fs.readFile(path.join(profile, "favorites.json"), "utf8"),
  );
  assert.equal(saved.items[0].folder_id, "");
  await page.getByLabel("Поиск закладок", { exact: true }).fill("");
  await chooseInline(page
    .getByLabel("Фильтр по папкам закладок", { exact: true }), saved.folders[0].id);
  await page.getByRole("button", { name: "Переименовать папку закладок", exact: true }).click();
  await page.getByLabel("Название закладки", { exact: true }).fill("Частые материалы");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Переименовать папку закладок", exact: true })
    .waitFor({ state: "hidden" });
  await page
    .getByRole("button", { name: "Удалить папку закладок; закладки перейдут в «Без папки»", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Переименовать папку закладок", exact: true })
    .waitFor({ state: "hidden" });
  await panel.getByRole("button", { name: /^Закладка для повтора/ }).click();
  await panel.waitFor({ state: "hidden" });
  assert.equal(state.tabs.at(-1).url, "https://example.com/3");
  await page.getByRole("button", { name: "Изменить закладку этой страницы", exact: true }).click();
  await page.getByRole("button", { name: "Удалить закладку", exact: true }).click();
  await page.getByRole("button", { name: "Добавить страницу в закладки", exact: true }).waitFor();
  saved = JSON.parse(
    await fs.readFile(path.join(profile, "favorites.json"), "utf8"),
  );
  assert.equal(saved.items.length, 0);
  assert.equal(saved.folders.length, 0);
  checks.push(
    "Real favorites service: create folder and favorite, edit, failed persistence retains input, retry, restart, search, move, folder rename/delete, open via guest tab API, delete favorite",
  );

  for (let i = 9; i <= 32; i++)
    state.tabs.push({
      id: "qa-" + i,
      kind: "web",
      title: "Справочная страница " + i,
      url: `https://example.com/${i}`,
    });
  await page.waitForFunction(
    () => document.querySelectorAll('.browser-tabs [role="tab"]').length === 33,
  );
  for (const width of [1280, 820, 375]) {
    await page.setViewportSize({ width, height: 850 });
    await page.waitForFunction(() => {
      const list = document.querySelector(".browser-tabs");
      return list.scrollWidth <= list.clientWidth + 1;
    });
    await shot("many-tabs-" + width);
  }
  await page.setViewportSize({ width: 820, height: 558 });
  await page.getByRole("button", { name: "Поиск вкладок", exact: true }).click();
  await page
    .getByLabel("Поиск открытых вкладок", { exact: true })
    .fill("Справочная страница 28");
  await page
    .getByRole("dialog", { name: "Поиск вкладок", exact: true })
    .getByRole("button", { name: "Справочная страница 28", exact: true })
    .click();
  await page.waitForFunction(
    () =>
      document.querySelector('.browser-tabs [aria-selected="true"]')
        .textContent === "Справочная страница 28",
  );
  await page.evaluate(() =>
    document.documentElement.style.setProperty("--ui-font-size", "20px"),
  );
  await shot("narrow-large-text");
  checks.push(
    "33 tabs: no horizontal scroll at 1280/820/375, tab search selects crowded tabs, 820px large text",
  );
  assert.deepEqual(errors, []);
  await fs.writeFile(
    path.join(output, "result.json"),
    JSON.stringify(
      {
        passed: true,
        checks,
        pageErrors: errors,
        scope:
          "Real DOM and favorites Go service; VM pages, navigation and noVNC are simulated.",
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed: true, checks }, null, 2));
} finally {
  await browser?.close();
  await stop();
  await fs.rm(profile, { recursive: true, force: true });
}
