// Runs the shipped UI and RFB client with isolated guest events and a recording
// native clipboard bridge. It never reads or changes the system clipboard.
import assert from "node:assert/strict";
import { createWorkbench } from "./workbench-fixture.mjs";
import { startDisplay } from "./rfb-wire-fixture.mjs";

const writes = [];
const display = await startDisplay(process.env.CAGE_UI_URL || "http://127.0.0.1:5198");
const { browser, page, state, errors } = await createWorkbench({
  mockWebSockets: false, url: display.url,
  nativeRequest: body => { if (body.action === "clipboardWrite") writes.push(body.text); return true; },
});
await page.addInitScript(() => {
  window.EventSource = class extends EventTarget {
    constructor() { super(); window.metadataEvents = this; queueMicrotask(() => this.onopen?.()); }
    close() {}
  };
});
const sendState = () => page.evaluate(snapshot => {
  window.metadataEvents.onmessage({ data: JSON.stringify(snapshot) });
}, { tabs: state.tabs, active: state.active, downloads: [], uploads: [] });
const copyContext = () => state.requests.filter(item => item.path === "/browser/copy-context").at(-1)?.body.context;
const copy = (id, text, context = copyContext()) => page.evaluate(value => {
  window.metadataEvents.dispatchEvent(new MessageEvent("clipboard", { data: JSON.stringify(value) }));
}, { id, text, context });
const clickCanvas = async () => {
  const prepared = page.waitForResponse("**/api/browser/copy-context");
  await page.locator(".remote-canvas canvas").click({ position: { x: 50, y: 50 } });
  await prepared;
};
const settle = () => page.waitForTimeout(100);
try {
  state.status.ready = state.status.vm_running = true;
  state.active = "first";
  const favicon = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 32;
    canvas.getContext("2d").fillRect(0, 0, 32, 32);
    return canvas.toDataURL("image/png");
  });
  state.tabs = [
    { id: "first", kind: "web", title: "First site", url: "https://example.test/first", favicon },
    { id: "second", kind: "web", title: "Second site", url: "https://example.test/second", favicon: "" },
  ];
  const unexpected = [];
  page.on("request", request => { if (new URL(request.url()).origin !== display.url) unexpected.push(request.url()); });
  await page.reload();
  await page.getByRole("button", { name: "Открыть браузер", exact: true }).click();
  await page.getByText("Подключение к экрану", { exact: true }).waitFor({ state: "hidden" });
  const canvas = page.locator(".remote-canvas canvas");
  await canvas.waitFor();
  await page.waitForFunction(() => document.querySelector('[role="tab"] .tab-favicon')?.naturalWidth === 32);
  await page.getByRole("button", { name: "Поиск вкладок", exact: true }).click();
  assert.equal(await page.locator(".all-tabs-results .tab-favicon").count(), 1);
  await page.keyboard.press("Escape");

  await clickCanvas();
  display.clipboard("unrelated guest update");
  await settle();
  assert.deepEqual(writes, [], "ordinary clicks must not authorize RFB clipboard writes");
  await copy("first", "复制按钮的文字🙂");
  await page.getByText("Скопировано на этот компьютер", { exact: true }).waitFor();
  assert.deepEqual(writes, ["复制按钮的文字🙂"]);

  await page.getByRole("textbox", { name: "Адрес страницы или поисковый запрос" }).click();
  await copy("first", "late local input");
  await settle();
  assert.equal(writes.length, 1);
  await page.getByRole("tab", { name: "Second site", exact: true }).click();
  await clickCanvas();
  await copy("first", "late previous tab");
  await settle();
  assert.equal(writes.length, 1);
  await copy("second", "Текущая вкладка");
  await settle();
  assert.equal(writes.at(-1), "Текущая вкладка");
  const oldContext = copyContext();
  await page.getByRole("tab", { name: "First site", exact: true }).click();
  await clickCanvas();
  await page.getByRole("tab", { name: "Second site", exact: true }).click();
  await clickCanvas();
  assert.notEqual(copyContext(), oldContext);
  await copy("second", "late copy after tab round-trip", oldContext);
  await settle();
  assert.equal(writes.length, 2);

  state.tabs[0].url += "#route";
  await sendState();
  assert.equal(await page.getByRole("tab", { name: "First site", exact: true }).locator("img").count(), 1);
  state.tabs[0].favicon = "data:image/png;base64,aW52YWxpZA==";
  await sendState();
  await page.getByRole("tab", { name: "First site", exact: true }).locator("img").waitFor({ state: "detached" });
  state.tabs[0].favicon = "https://third-party.test/icon.png";
  await sendState();
  assert.equal(await page.getByRole("tab", { name: "First site", exact: true }).locator("img").count(), 0);
  await page.getByRole("button", { name: "Рабочая среда", exact: true }).click();
  await copy("second", "hidden view");
  await settle();
  assert.equal(writes.length, 2);
  await page.getByRole("button", { name: "Открыть браузер", exact: true }).click();
  await page.getByText("Подключение к экрану", { exact: true }).waitFor({ state: "hidden" });
  await clickCanvas();
  await copy("second", "late copy after reconnect", oldContext);
  await settle();
  assert.equal(writes.length, 2);
  assert.deepEqual(unexpected, []);
  assert.deepEqual(errors, []);
  console.log("PASS: tab/search favicons, SPA retention, broken icon fallback, no host icon requests, explicit copy events, unrelated RFB rejection, local focus/tab/hidden-view isolation");
} finally {
  await browser.close();
  await display.close();
}
