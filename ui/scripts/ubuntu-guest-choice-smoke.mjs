import assert from "node:assert/strict";
import { createWorkbench } from "./workbench-fixture.mjs";

for (const [platform, system] of [["darwin", "macos"], ["windows", "windows-11"], ["linux", "ubuntu-24.04"], ["linux", ""]]) {
  let submitted;
  const fixture = await createWorkbench({
    clientContext: { mode: "local", connection_id: "local", client_platform: platform, server_platform: platform },
    async beforeNavigate(page, state) {
      state.status.local_vm_storage = true;
      await page.route("**/api/environment/guest-systems", route => route.fulfill({ json: {
        fresh: true, available: Boolean(system), ...(system ? { system } : {}), linux_systems: ["ubuntu-22.04"],
      } }));
      await page.route("**/api/environment/guest-systems/clone", () => { throw Error("Ubuntu requested host clone metadata"); });
      await page.route("**/api/start", route => {
        submitted = route.request().postDataJSON();
        return route.fulfill({ json: { id: "ubuntu-choice", running: true, kind: "guest-install" } });
      });
    },
  });
  try {
    const { page } = fixture;
    const picker = page.getByRole("combobox", { name: "Гостевая система" });
    const storage = page.getByRole("button", { name: "Выбрать место хранения среды" });
    await picker.waitFor();
    const initial = await storage.boundingBox();
    await picker.click();
    const option = page.getByRole("option", { name: "Ubuntu 22.04", exact: true });
    await option.waitFor();
    const box = await option.boundingBox();
    const expanded = await storage.boundingBox();
    assert.ok(Math.abs(expanded.y - initial.y) < 1 && box.height > 0, "floating options must not move the next control");
    await picker.press("Escape");
    assert.equal((await storage.boundingBox()).y, initial.y);
    await picker.press("Enter");
    await picker.press("Home");
    for (let index = 0; index < (system ? 2 : 1); index++) await picker.press("ArrowDown");
    await picker.press("Enter");
    await picker.click();
    await option.click();
    await page.getByText("Образ Ubuntu 22.04 LTS загружается из официального источника Ubuntu", { exact: false }).waitFor();
    assert.equal(await page.getByLabel("SHA-256 ISO-образа").count(), 0);
    assert.equal(await page.getByRole("button", { name: "Выбрать локальный ISO" }).count(), 0);
    const install = page.getByRole("button", { name: "Установить гостевую систему", exact: true });
    assert.equal(await install.isEnabled(), true);
    await Promise.all([page.waitForResponse(response => response.url().endsWith("/api/start")), install.click()]);
    assert.equal(submitted.guest_system, "ubuntu-22.04");
    assert.equal(submitted.clone_key || "", "");
    assert.equal(submitted.media, "");
    assert.deepEqual(fixture.errors, []);
    console.log(`${platform}/${system || "other-linux"}: explicit Ubuntu option, inline layout and install request passed`);
  } finally { await fixture.browser.close(); }
}

{
  const fixture = await createWorkbench({
    async beforeNavigate(page, state) {
      state.status.local_vm_storage = true;
      await page.route("**/api/environment/guest-systems", route => route.fulfill({ json: {
        fresh: false, available: true, system: "macos", linux_systems: ["ubuntu-22.04"], reselect: false,
        pending: { id: "ubuntu-resume", system: "ubuntu-22.04", source_kind: "linux-image", source: { host: { system: "ubuntu-22.04", arch: "arm64" } } },
      } }));
      await page.route("**/api/environment/guest-systems/clone", () => { throw Error("Ubuntu resume was treated as a host clone"); });
    },
  });
  try {
    const picker = fixture.page.getByRole("combobox", { name: "Гостевая система" });
    await picker.waitFor();
    assert.equal(await picker.isDisabled(), true);
    assert.match(await picker.innerText(), /Ubuntu 22.04/);
    assert.equal(await fixture.page.getByRole("button", { name: "Выбрать другую систему или образ" }).count(), 0);
    assert.deepEqual(fixture.errors, []);
    console.log("Ubuntu interrupted installation retains its system and cannot replace an existing disk");
  } finally { await fixture.browser.close(); }
}
