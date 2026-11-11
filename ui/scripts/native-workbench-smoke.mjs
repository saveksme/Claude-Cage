// Verify that switching the guest keeps the Linux workbench's actual entry points.
import assert from "node:assert/strict";
import { createWorkbench } from "./workbench-fixture.mjs";

let baseline;
for (const system of ["debian-13", "windows-11", "macos"]) {
  const fixture = await createWorkbench({
    beforeNavigate: async (page, state) => {
      state.account.guest_system = system;
      state.status.guest_system = system;
      state.status.vm_running = state.status.ready = true;
      const status = { installed: true, running: true, native_user_session: true, version: "4.0", screen: false, input: false };
      await page.route("**/api/claude-desktop", route => route.fulfill({json:status}));
      await page.route("**/api/macos/claude/window", route => route.fulfill({json:status}));
    },
  });
  const { page, state, errors, browser } = fixture;
  try {
    const nav = page.getByRole("navigation", { name: "Основная навигация" });
    await nav.getByRole("button", { name: "Рабочая среда", exact: true }).waitFor();
    const labels = await nav.getByRole("button").allTextContents();
    if (system === "debian-13") baseline = labels;
    else assert.deepEqual(labels, baseline, system);

    await nav.getByRole("button", { name: "Claude Desktop", exact: true }).click();
    await page.locator(".claude-desktop-toolbar").getByText("Claude Desktop", { exact:true }).waitFor();
    const zoom = page.getByRole("combobox", {name:"Размер отображения Desktop"});
    await zoom.click();
    await page.getByRole("option", {name:"125%"}).click();
    assert.match(await zoom.innerText(), /125%/);
    await nav.getByRole("button", {name:"Открыть браузер"}).click();
    await page.locator(".address-bar input").first().waitFor();
    assert.ok(state.requests.some(r => r.path === "/browser/new"));
    await nav.getByRole("button", {name:"Рабочая среда", exact:true}).click();
    await page.locator('[data-terminal-location="shortcuts"]').click();
    await page.getByRole("menuitem", {name:"Терминал Claude"}).click();
    await page.waitForFunction(() => document.querySelector(".terminal-lane:not([hidden]) .terminal-view"));
    assert.ok(state.requests.some(r => r.path === "/terminals" && r.body?.kind === "claude"));
    assert.deepEqual(errors, []);
    console.log(system, "shared navigation, Claude Desktop zoom, browser and Claude Code entry passed");
  } finally { await browser.close(); }
}
