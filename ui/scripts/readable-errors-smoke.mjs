import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createWorkbench } from "./workbench-fixture.mjs";

const output = process.env.CAGE_ERROR_QA_OUTPUT || "/tmp/cage-readable-errors";
await mkdir(output, { recursive: true });
for (const platform of ["darwin", "windows", "linux"]) {
  const fixture = await createWorkbench({
    clientContext: { mode: "local", connection_id: "local", client_platform: platform, server_platform: platform, connection: { state: "disconnected" } },
  });
  const { page, browser, state, errors } = fixture;
  try {
    state.status.job = { id: "readable-failure", kind: "start", running: false, message: "ошибка запуска среды", error: "Не удалось загрузить образ Linux: истекло время ожидания ответа сервера загрузки. Проверьте выбранный узел и продолжите установку.", log: "fixture download timeout" };
    await page.reload();
    await page.getByText("ошибка запуска среды", { exact: true }).first().waitFor();
    await page.getByRole("alert").filter({ hasText: "истекло время ожидания ответа сервера загрузки" }).first().waitFor();
    await page.getByRole("button", { name: "Посмотреть подробности операции", exact: true }).first().click();
    await page.getByRole("dialog", { name: "Подробности операции", exact: true }).getByText("fixture download timeout", { exact: true }).waitFor();
    await page.keyboard.press("Escape");
    await page.screenshot({ path: `${output}/${platform}-startup.png` });

    await page.route("**/api/environment/resources", route => route.fulfill({ status: 503, contentType: "text/html", body: "<html>upstream failed token=private-test-secret</html>" }));
    const failure = await page.evaluate(async () => {
      const { api } = await import("/src/api.js");
      try { await api("/environment/resources"); return "unexpected success"; }
      catch (error) { return { message: error.message, status: error.status }; }
    });
    assert.match(failure.message, /чтение конфигурации ресурсов.*HTTP 503/);
    assert.equal(failure.status, 503);
    assert.ok(!failure.message.includes("private-test-secret") && !failure.message.includes("<html>"));
    await page.route("**/api/environment/resources", route => route.fulfill({ status: 200, contentType: "application/json", body: "not-json token=private-test-secret" }));
    const malformed = await page.evaluate(async () => {
      const { api } = await import("/src/api.js");
      try { await api("/environment/resources"); } catch (error) { return error.message; }
    });
    assert.match(malformed, /недопустимом формате/);
    assert.ok(!malformed.includes("private-test-secret"));
    assert.deepEqual(errors, []);
    await writeFile(`${output}/${platform}.json`, JSON.stringify({ platform, failure, malformed }, null, 2));
    console.log(`PASS: ${platform} readable failures`);
  } finally { await browser.close(); }
}
