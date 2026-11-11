import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import { smokeCaptureDirectory } from "./smoke-captures.mjs";

const require = createRequire(import.meta.url);
const engines = require(process.env.CAGE_PLAYWRIGHT_MODULE || "playwright");
const engine = process.env.CAGE_TEST_BROWSER || "chromium";
const browser = await engines[engine].launch({executablePath:process.env.CAGE_TEST_BROWSER_PATH});
const output = await smokeCaptureDirectory("mobile-inline-select");
const origin = process.env.CAGE_UI_URL || "http://127.0.0.1:5399";
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  page.on("pageerror", error => errors.push(error.message));
  const projects = [{ path: "/work/alpha", name: "alpha" }, { path: "/work/beta", name: "beta" }, { path: "/work/gamma", name: "gamma" }];
  const sessions = [];
  let creations = 0;
  await page.route("**/api/**", route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path.endsWith("/projects")) return route.fulfill({ json: { host: "Изолированный хост", ready: true, projects, shared_sessions: true } });
    if (path.endsWith("/sessions")) {
      if (request.method() === "POST") {
        creations++;
        const input = request.postDataJSON();
        const session = { ...input, title: "Тестовый сеанс", revision: 1, generation: input.id, turns: [] };
        sessions.push(session);
        return route.fulfill({ json: session });
      }
      return route.fulfill({ json: { sessions } });
    }
    if (path.endsWith("/account")) return route.fulfill({ json: { session: sessions[0], supported: false, candidates: [] } });
    return route.fulfill({ json: sessions[0] || {} });
  });
  await page.goto(origin + "/mobile.html");
  const picker = page.getByRole("combobox", { name: "Выбрать проект", exact: true });
  await picker.waitFor();
  const create = page.getByRole("button", { name: /^Новый сеанс в / }).first();
  const collapsed = await create.boundingBox();
  await picker.press("Enter");
  assert.ok(Math.abs((await create.boundingBox()).y-collapsed.y)<1);
  await picker.press("End");
  await picker.press("Enter");
  await picker.getByText("gamma", { exact: true }).waitFor();
  assert.equal(await picker.getAttribute("aria-expanded"), "false");
  assert.equal(await picker.evaluate(element => document.activeElement === element), true);
  await picker.press("ArrowDown");
  await picker.press("Escape");
  assert.equal(await picker.getAttribute("aria-expanded"), "false");
  assert.equal((await create.boundingBox()).y, collapsed.y);
  await picker.tap();
  await picker.tap();
  await create.tap();
  await page.getByRole("textbox", { name: "Сообщение", exact: true }).waitFor();
  assert.equal(creations, 1, "one tap after closing the project selector must create exactly one session");
  assert.equal(sessions[0].workspace, "/work/gamma");
  await page.screenshot({ path: join(output, `${engine}-new-session.png`) });
  await page.close();

  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: "CageMobile/1" });
  phone.on("pageerror", error => errors.push(error.message));
  const image = await phone.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 390; canvas.height = 600;
    return canvas.toDataURL("image/jpeg").split(",")[1];
  });
  let frame, writes = 0;
  const favorites = { folders: [{ id: "work", title: "Работа" }, { id: "reference", title: "Материалы" }], items: [] };
  await phone.route("**/api/**", route => {
    const request = route.request(), path = new URL(request.url()).pathname, body = request.postDataJSON();
    if (path.endsWith("/projects")) return route.fulfill({ json: { host: "Изолированный тестовый компьютер", ready: true, projects: [] } });
    if (path.endsWith("/sessions")) return route.fulfill({ json: { sessions: [] } });
    if (path.endsWith("/favorites")) {
      if (body) { writes++; favorites.items.push({ id: "saved", ...body }); }
      return route.fulfill({ json: favorites });
    }
    if (path.endsWith("/open")) {
      frame = { ...body, image, document: "fixture-document", url: "https://example.com/", title: "Тестовая страница" };
      return route.fulfill({ json: { id: frame.id } });
    }
    if (path.endsWith("/frame")) return route.fulfill({ json: frame });
    return route.fulfill({ json: { id: frame?.id } });
  });
  await phone.goto(origin + "/mobile.html");
  await phone.getByRole("dialog", { name: "Боковая панель рабочей области" }).getByRole("button", { name: "Браузер", exact: true }).click();
  await phone.getByRole("img", { name: "Изображение удалённого браузера" }).waitFor();
  await phone.getByRole("button", { name: "Закладки", exact: true }).tap();
  await phone.getByRole("button", { name: "Добавить страницу в закладки", exact: true }).tap();
  await phone.getByRole("combobox", { name: "Сохранить в", exact: true }).tap();
  await phone.getByRole("combobox", { name: "Сохранить в", exact: true }).tap();
  await phone.getByRole("button", { name: "Сохранить в закладки", exact: true }).tap();
  await phone.getByRole("button", { name: "Убрать страницу из закладок", exact: true }).waitFor();
  assert.equal(writes, 1, "one tap after closing the folder selector must save exactly once");
  await phone.screenshot({ path: join(output, `${engine}-saved-favorite.png`) });
  assert.deepEqual(errors, []);
  console.log(`${engine}: floating layout, keyboard selection, Escape, focus restoration and session/favorite mutations passed.`);
} finally {
  await browser.close();
}
