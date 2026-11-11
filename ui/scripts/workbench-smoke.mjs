import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { join } from "node:path";
import { smokeCaptureDirectory } from "./smoke-captures.mjs";
import { createWorkbench } from "./workbench-fixture.mjs";

const output = await smokeCaptureDirectory("workbench");
const { browser, page, state, errors } = await createWorkbench();
const checks = [];
const shot = (name) =>
  page.screenshot({ path: join(output, name + ".png"), animations: "disabled" });
const settings = async () => {
  await page.getByRole("button", { name: /Настройки/ }).click();
  await page.getByRole("navigation", { name: "Разделы настроек" }).getByRole("button", { name: "Основные", exact: true }).click();
};
const tabs = () => page.getByRole("tablist", { name: "Вкладки браузера" });
try {
  await shot("main");
  const navigation = page.getByRole("navigation", { name: "Основная навигация" });
  assert.equal(await navigation.getByRole("button", { name: /Открыть проект.*Проекты/ }).count(), 0);
  await page
    .getByRole("button", { name: "Запустить среду Cage", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Среда Cage готова", exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "Добавить проект", exact: true })
    .click();
  await page.getByRole("button", { name: "Добавить локальный проект…", exact: true }).click();
  await page.waitForFunction(
    (path) => document.getElementById("project-path")?.value === path,
    state.chosenFolder,
  );
  assert.equal(
    await page.getByLabel("Папка нового проекта", { exact: true }).inputValue(),
    state.chosenFolder,
  );
  state.failJob = true;
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Открыть проект", exact: true })
    .click();

  await page
    .getByRole("dialog")
    .getByRole("alert")
    .filter({ hasText: "Не удалось подключить папку проекта" })
    .waitFor();
  assert.equal(
    await page.getByLabel("Папка нового проекта", { exact: true }).inputValue(),
    state.chosenFolder,
  );
  assert.ok(state.settings.workspace.endsWith(".claude-cage-workspace"));
  state.failJob = false;
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Открыть проект", exact: true })
    .click();

  await page.getByRole("dialog").waitFor({ state: "hidden" });
  assert.equal(state.settings.workspace, state.chosenFolder);
  await page.reload();
  await page
    .getByRole("heading", { name: "Среда Cage готова", exact: true })
    .waitFor();
  await page
    .getByRole("region", { name: "Проект design-lab", exact: true })
    .waitFor();
  assert.ok(state.status.projects.includes(state.chosenFolder));
  await page.evaluate(() =>
    localStorage.setItem(
      "cage-projects",
      JSON.stringify(["/fake/local-history"]),
    ),
  );
  await page.reload();
  await page
    .getByRole("region", { name: "Проект design-lab", exact: true })
    .waitFor();
  assert.equal(
    await page.getByText("local-history", { exact: true }).count(),
    0,
  );
  assert.equal(await page.getByText("Метки среды", { exact: true }).count(), 0);
  assert.equal(await page.getByText("Недавние проекты", { exact: true }).count(), 0);
  checks.push("Реальный список каталогов перечитывается, локальная история не используется, при ошибке открытия проекта путь сохраняется");
  await page
    .getByRole("heading", { name: "Среда Cage готова", exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "Создать терминал в проекте design-lab", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Обычный терминал", exact: true }).click();
  await page.getByRole("tab", { name: "Терминал 1", exact: true }).waitFor();
  const terminalHeader = page.locator("header.chrome");
  assert.equal(await terminalHeader.locator(".navigation-row").count(), 0);
  assert.equal(await terminalHeader.getByRole("button", { name: "Новый терминал", exact: true }).count(), 0);
  assert.equal(await terminalHeader.getByRole("button", { name: "Открыть файл", exact: true }).count(), 0);
  assert.equal(await terminalHeader.getByRole("button", { name: "design-lab", exact: true }).getAttribute("title"), state.chosenFolder);
  const terminalTab = page.getByRole("tab", { name: "Терминал 1", exact: true });
  const actions = page.getByRole("group", { name: "Действия для Терминал 1", exact: true });
  await terminalTab.hover();
  await actions.waitFor();
  await page.getByRole("button", { name: "Рабочая среда", exact: true }).hover();
  await actions.waitFor({ state: "hidden" });
  await terminalTab.focus();
  // WebKit's default keyboard mode skips buttons when tabbing. The tab's
  // context-menu shortcut reaches its actions in that mode too.
  await terminalTab.press(process.env.CAGE_TEST_BROWSER === "webkit" ? "Shift+F10" : "Tab");
  assert.equal(await page.locator(":focus").getAttribute("aria-label"), "Закрепить");
  await page.keyboard.press("Enter");
  await actions.getByRole("button", { name: "Открепить", exact: true }).click();
  const renameButton = actions.getByRole("button", { name: "Переименовать", exact: true });
  await renameButton.hover();
  await actions.getByText("Переименовать", { exact: true }).waitFor();
  await renameButton.click();
  await page.getByLabel("Имя вкладки").fill("Терминал разработки");
  await page.getByRole("button", { name: "Сохранить имя" }).click();
  await page.getByRole("tab", { name: "Терминал разработки" }).waitFor();
  await page.getByRole("button", { name: "Открыть браузер", exact: true }).click();
  await page.getByRole("tab", { name: "Новая вкладка", exact: true }).waitFor();
  await page.getByLabel("Адрес страницы или поисковый запрос").fill("localhost:3000");
  await page.getByRole("button", { name: "Открыть адрес", exact: true }).click();
  await page.getByRole("tab", { name: "Локальный предпросмотр", exact: true }).waitFor();
  assert.equal(state.tabs[0].url, "http://localhost:3000/");
  await tabs()
    .getByRole("tab", { name: "Локальный предпросмотр", exact: true })
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "Закрепить вкладку", exact: true }).click();
  assert.equal(await tabs().getByRole("tab").first().innerText(), "Локальный предпросмотр");
  await page.getByRole("button", { name: "Открыть редактор проекта design-lab", exact: true }).click();
  await page
    .getByRole("tab", { name: "Файл · design-lab", exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "Закрыть Файл · design-lab", exact: true })
    .click();
  await page.getByRole("dialog", { name: "Закрыть редактор файлов?" }).waitFor();
  await page
    .getByRole("dialog")
    .last()
    .getByRole("button", { name: "Отмена", exact: true })
    .click();
  assert.equal(state.tabs.length, 2);
  assert.equal(
    await page.locator(".workspace-sidebar").getByRole("tab").count(),
    1,
  );
  assert.equal(await tabs().getByRole("tab").count(), 2);
  assert.equal(await page.locator(".content-breadcrumb").count(), 0);
  await page.getByRole("button", { name: "Новая страница", exact: true }).click();
  await tabs().getByRole("tab", { name: "Новая вкладка", exact: true }).waitFor();
  const newTab = tabs().getByRole("tab", { name: "Новая вкладка", exact: true });
  const editorTab = tabs().getByRole("tab", { name: "Файл · design-lab", exact: true });
  // Drop past the editor tab's midpoint to put the new tab before it.
  await newTab.dragTo(editorTab, { targetPosition: { x: 5, y: 10 } });
  await tabs().getByRole("tab").nth(1).and(newTab).waitFor();
  await page.reload();
  await page.getByRole("button", { name: "Открыть браузер", exact: true }).click();
  assert.deepEqual(await tabs().getByRole("tab").allTextContents(), [
    "Локальный предпросмотр",
    "Новая вкладка",
    "Файл · design-lab",
  ]);
  await page.keyboard.press("Meta+2");
  await page.waitForFunction(
    () =>
      document.querySelector('.browser-tabs [aria-selected="true"]')
        ?.textContent === "Новая вкладка",
  );
  await page
    .getByRole("button", { name: "Закрыть Новая вкладка", exact: true })
    .click();
  await page.waitForFunction(
    () =>
      document.querySelector('.browser-tabs [aria-selected="true"]')
        ?.textContent === "Файл · design-lab",
  );
  assert.equal(
    state.active,
    state.tabs.find((tab) => tab.kind === "editor").id,
  );
  await page.getByRole("tab", { name: "Терминал разработки", exact: true }).click();
  await page.keyboard.press("Meta+1");
  await page.waitForFunction(
    () =>
      document.querySelector('.sidebar-tabs [aria-selected="true"]')
        ?.textContent === "Терминал разработки",
  );
  const pageCount = state.tabs.length;
  await page.getByRole("button", { name: "Открыть браузер", exact: true }).click();
  assert.equal(state.tabs.length, pageCount);
  assert.equal(
    await tabs()
      .getByRole("tab", { name: "Файл · design-lab", exact: true })
      .getAttribute("aria-selected"),
    "true",
  );
  await shot("workspace-browser");
  await page.getByRole("tab", { name: "Терминал разработки", exact: true }).click();
  await shot("workspace-terminal");
  checks.push(
    "Вкладки браузера сверху, каталог содержит только терминал, браузер восстанавливает страницу, переименование/закрепление/сортировка перечитываются, сочетания групп, после закрытия активируется соседняя страница",
  );
  const connections = state.terminalConnections;
  await settings();
  await page.getByRole("heading", { name: "Основные", exact: true }).waitFor();
  await shot("settings");
  await page.getByRole("radio", { name: /^Сочетания гостевой системы/ }).check();
  await page
    .getByRole("button", { name: "Вернуться в рабочую среду", exact: true })
    .first()
    .click();
  await page.getByRole("dialog", { name: "Отменить несохранённые изменения?" }).waitFor();
  await page
    .getByRole("dialog")
    .last()
    .getByRole("button", { name: "Отмена", exact: true })
    .click();
  assert.equal(
    await page.getByRole("radio", { name: /^Сочетания гостевой системы/ }).isChecked(),
    true,
  );
  state.failSave = true;
  await page.getByRole("button", { name: "Сохранить настройки", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "Не удалось сохранить" }).waitFor();
  assert.equal(
    await page.getByRole("radio", { name: /^Сочетания гостевой системы/ }).isChecked(),
    true,
  );
  state.failSave = false;
  await page.getByRole("button", { name: "Сохранить настройки", exact: true }).click();
  await page
    .getByRole("region", { name: "Настройки", exact: true })
    .waitFor({ state: "hidden" });
  assert.equal(state.settings.keyboard, "native");
  assert.equal(state.terminalConnections, connections);
  await settings();
  assert.equal(
    await page.getByRole("radio", { name: /^Сочетания гостевой системы/ }).isChecked(),
    true,
  );
  await page.getByRole("button", { name: "Часовой пояс и язык", exact: true }).click();
  await page.getByRole("switch", { name: /Часовой пояс по IP-адресу выхода/ }).uncheck();
  await page.getByLabel("Часовой пояс системы", { exact: true }).fill("Etc/UTC");
  await page.getByRole("button", { name: "Сохранить и перезапустить", exact: true }).click();
  await page.getByRole("dialog", { name: "Применить настройки и перезапустить среду?" }).waitFor();
  await page
    .getByRole("dialog")
    .last()
    .getByRole("button", { name: "Отмена", exact: true })
    .click();
  assert.equal("proxy_url" in state.settings, false);
  checks.push(
    "Подтверждение выхода с черновиком настроек, ввод сохраняется при ошибке, чтение после сохранения, соединение фонового терминала сохраняется, перезапуск отменяется",
  );
  await page.setViewportSize({ width: 820, height: 558 });
  await shot("settings-minimum");
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await page.getByRole("button", { name: "Часовой пояс и язык", exact: true }).click();
  await shot("settings-region-minimum");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Отменить изменения", exact: true }).click();
  await page
    .getByRole("button", { name: "Добавить проект", exact: true })
    .click();
  await page.getByRole("button", { name: "Добавить локальный проект…", exact: true }).click();
  await page
    .getByLabel("Папка нового проекта", { exact: true })
    .fill("/Users/shihao/Projects/another-project");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Открыть проект", exact: true })
    .click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  assert.equal(
    state.settings.workspace,
    "/Users/shihao/Projects/another-project",
  );
  assert.ok(state.terminals.length > 0);
  assert.ok(state.tabs.length > 0);
  assert.equal(
    await page.getByRole("tab", { name: "Терминал разработки", exact: true }).count(),
    1,
  );
  await page
    .getByRole("button", { name: "Создать терминал в проекте another-project", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Обычный терминал", exact: true }).click();
  await page
    .getByRole("region", { name: "Проект another-project", exact: true })
    .getByRole("tab", { name: "Терминал 2", exact: true })
    .waitFor();
  assert.equal(
    state.terminals[1].workspace,
    "/Users/shihao/Projects/another-project",
  );
  await page
    .getByRole("button", { name: "Создать терминал в проекте design-lab", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Обычный терминал", exact: true }).click();
  await page
    .getByRole("region", { name: "Проект design-lab", exact: true })
    .getByRole("tab", { name: "Терминал 3", exact: true })
    .waitFor();
  assert.equal(state.terminals[2].workspace, state.chosenFolder);
  assert.equal(
    state.settings.workspace,
    "/Users/shihao/Projects/another-project",
  );
  await page.getByRole("button", { name: "Открыть браузер", exact: true }).click();
  await shot("browser-minimum");
  assert.equal(
    await page.locator(".workspace-sidebar").getByRole("tab").count(),
    3,
  );
  assert.equal(await tabs().getByRole("tab").count(), 2);
  await page.getByRole("button", { name: "Открыть редактор проекта another-project", exact: true }).click();
  await tabs().getByRole("tab", { name: "Файл · another-project", exact: true }).waitFor();
  await page.getByRole("button", { name: "Открыть редактор проекта design-lab", exact: true }).click();
  await tabs()
    .getByRole("tab", { name: "Файл · design-lab", exact: true })
    .waitFor();
  assert.equal(state.tabs.filter((tab) => tab.kind === "editor").length, 2);
  assert.equal(state.tabs.find((tab) => tab.id === state.active)?.workspace, state.chosenFolder);
  checks.push(
    "Терминалы двух проектов группируются отдельно, новый терминал в каталоге не зависит от последнего проекта, браузер и терминал продолжают работать",
  );
  const deleteTab = page.getByRole("tab", { name: "Терминал 3", exact: true });
  const remove = page.getByRole("group", { name: "Действия для Терминал 3" }).getByRole("button", { name: "Закрыть терминал", exact: true });
  await deleteTab.hover();
  await remove.click();
  const confirmClose = page.getByRole("dialog", { name: "Закрыть этот сеанс терминала?" });
  await confirmClose.getByRole("button", { name: "Отмена" }).click();
  assert.equal(state.terminals.length, 3);
  await deleteTab.hover();
  await remove.click();
  await confirmClose.getByRole("button", { name: "Закрыть терминал" }).click();
  await deleteTab.waitFor({ state: "detached" });
  assert.equal(state.terminals.length, 2);
  checks.push("Строка терминала раскрывается при наведении, закрепление с клавиатуры, переименование, отмена и подтверждение закрытия выбранного обычного терминала");
  await page.getByRole("button", { name: "Рабочая среда", exact: true }).click();
  await shot("main-minimum");
  await page.getByRole("button", { name: "Свернуть боковую панель", exact: true }).click();
  await page.reload();
  await page.getByRole("button", { name: "Развернуть боковую панель", exact: true }).waitFor();
  await page.setViewportSize({ width: 375, height: 812 });
  await page.keyboard.press("Meta+t");
  await tabs().waitFor();
  await shot("compact-workspace");
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  checks.push(
    "Переключение проекта сохраняет терминал и страницы, минимальное окно 820px, сворачивание боковой панели перечитывается, при 375px нет горизонтального переполнения",
  );
  assert.deepEqual(errors, []);
  await fs.writeFile(
    join(output, "smoke-result.json"),
    JSON.stringify(
      {
        passed: true,
        checks,
        pageErrors: errors,
        scope:
          "Mock API/native picker/terminal socket; no real VM, network or file edit verification.",
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed: true, checks }, null, 2));
} finally {
  await browser.close();
}
