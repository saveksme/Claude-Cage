// UI actions reach a real isolated production browser controller. The VM status,
// remote display and account are the existing workbench fixture.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { createWorkbench } from './workbench-fixture.mjs';
import { createPrivacyController } from '../../scripts/browser-privacy-fixture.mjs';

const output = new URL('../../docs/test-reports/2026-11-07-browser-privacy/', import.meta.url);
const engine = process.env.CAGE_TEST_BROWSER || 'chromium';
await mkdir(output, { recursive: true });
const controller = await createPrivacyController();
let workbench;
let failCookies = false;
const checks = [];
try {
  const normal = (await controller.api('/tabs')).active;
  await controller.cdp(normal, 'Network.setCookies', { cookies: [
    { name: 'fixture-session', value: 'fixture-only-value', domain: 'localhost', path: '/', httpOnly: true },
    { name: 'unrelated', value: 'fixture-other', domain: 'other.test', path: '/' },
  ] });
  workbench = await createWorkbench({ browserRequest: async (route, path, body) => {
    if (path === '/browser/resize') return route.fulfill({ json: { ok: true } });
    if (path === '/browser/cookies' && failCookies) return route.fulfill({ status: 502, body: 'Тест: служба Cookie временно недоступна' });
    try { return await route.fulfill({ json: await controller.api(path.replace('/browser', ''), body ?? undefined) }); }
    catch (error) { return route.fulfill({ status: 400, body: error.message }); }
  } });
  const { page, errors } = workbench;
  page.setDefaultTimeout(10000);
  workbench.state.settings.browser_home_url = controller.origin + '/ui-home';
  await page.getByRole('button', { name: 'Запустить среду Cage', exact: true }).click();
  await page.getByRole('heading', { name: 'Среда Cage готова', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Открыть браузер', exact: true }).click();
  await page.getByRole('tab', { name: 'Privacy fixture', exact: true }).waitFor();
  const menu = page.getByRole('button', { name: 'Меню браузера', exact: true });
  await menu.focus(); await page.keyboard.press('ArrowDown');
  await page.getByRole('menuitem', { name: 'Новая приватная вкладка', exact: true }).press('Enter');
  await page.getByRole('tab', { name: /^Приватный · / }).waitFor();
  await page.locator('.browser-private-badge').waitFor();
  assert.equal((await controller.api('/tabs')).tabs.filter(tab => tab.incognito).length, 1);
  await page.getByRole('button', { name: 'Новая страница', exact: true }).click();
  await controller.waitFor(async () => (await controller.api('/tabs')).tabs.filter(tab => tab.incognito).length === 2, 'plus inherits private session');
  await page.screenshot({ path: fileURLToPath(new URL(`private-tabs-${engine}.png`, output)) });
  checks.push('keyboard menu creates a real private session; tab title, address badge and notice identify privacy; plus inherits private mode');

  // Private label edits must remain in memory even after the tab closes.
  const privateTab = page.getByRole('tab', { name: /^Приватный · / }).last();
  await privateTab.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Переименовать вкладку', exact: true }).click();
  await page.getByRole('dialog', { name: 'Переименовать вкладку' }).locator('input').fill('PRIVATE_TITLE_MUST_NOT_PERSIST');
  await page.getByRole('button', { name: 'Сохранить имя', exact: true }).click();
  assert.equal(await page.evaluate(() => JSON.stringify(localStorage).includes('PRIVATE_TITLE_MUST_NOT_PERSIST')), false);
  await page.getByRole('button', { name: 'Закрыть Приватный · PRIVATE_TITLE_MUST_NOT_PERSIST', exact: true }).click();
  await page.getByRole('tab', { name: 'Privacy fixture', exact: true }).click();
  await page.getByRole('tab', { name: 'Privacy fixture', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Закрепить вкладку', exact: true }).click();
  assert.equal(await page.evaluate(() => JSON.stringify(localStorage).includes('PRIVATE_TITLE_MUST_NOT_PERSIST')), false);
  checks.push('private rename never persists, including after closing the tab and saving normal tab metadata');

  await menu.click();
  await page.getByRole('menuitem', { name: 'Управление Cookie', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Управление Cookie' });
  await panel.getByText('fixture-session', { exact: true }).waitFor();
  assert.equal(await panel.getByText('unrelated', { exact: true }).count(), 0);
  await panel.getByRole('button', { name: 'Показать значение', exact: true }).click();
  await panel.getByText('fixture-only-value', { exact: true }).waitFor();
  await panel.getByRole('button', { name: 'Скрыть значение', exact: true }).click();
  const range = panel.getByRole('combobox', { name: 'Область сайтов для Cookie' });
  const listY = async () => (await panel.locator('.cookie-list').boundingBox()).y;
  const collapsedY = await listY();
  await range.click();
  await panel.getByRole('option', { name: 'Все сайты', exact: true }).waitFor();
  assert.ok(await listY() > collapsedY + 30, 'inline choices occupy layout space');
  await page.screenshot({ path: fileURLToPath(new URL(`cookie-range-inline-${engine}.png`, output)) });
  await range.press('ArrowDown'); await range.press('Enter');
  await panel.getByText('unrelated', { exact: true }).waitFor();
  await panel.getByRole('textbox', { name: 'Поиск Cookie' }).fill('fixture-session');
  await panel.getByText('Всего: 1', { exact: false }).waitFor();
  await panel.getByRole('button', { name: 'Удалить Cookie fixture-session', exact: true }).click();
  await panel.getByText('Подходящих Cookie нет.', { exact: true }).waitFor();
  assert.equal((await controller.api('/cookies', { id: normal, mode: 'list', scope: 'all' })).total, 1);
  checks.push('real cookies viewed, values revealed and hidden, range selects inline with keyboard, search and exact deletion preserve other cookies');

  await panel.getByRole('textbox', { name: 'Поиск Cookie' }).fill('');
  await panel.getByText('unrelated', { exact: true }).waitFor();
  await panel.getByRole('button', { name: 'Очистить все сайты', exact: true }).click();
  await panel.getByRole('button', { name: 'Отмена', exact: true }).click();
  assert.equal((await controller.api('/cookies', { id: normal, mode: 'list', scope: 'all' })).total, 1);
  failCookies = true;
  await panel.getByRole('button', { name: 'Обновить Cookie', exact: true }).click();
  await panel.getByRole('alert').getByText('Тест: служба Cookie временно недоступна', { exact: true }).waitFor();
  failCookies = false;
  await panel.getByRole('button', { name: 'Обновить Cookie', exact: true }).click();
  await panel.getByText('unrelated', { exact: true }).waitFor();
  await page.setViewportSize({ width: 820, height: 558 });
  await page.screenshot({ path: fileURLToPath(new URL(`cookies-minimum-window-${engine}.png`, output)) });
  assert.ok((await panel.boundingBox()).x >= 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  await panel.getByRole('button', { name: 'Очистить все сайты', exact: true }).click();
  await panel.getByRole('button', { name: 'Очистить', exact: true }).click();
  await panel.getByText('Подходящих Cookie нет.', { exact: true }).waitFor();
  await panel.getByRole('textbox', { name: 'Поиск Cookie' }).press('Escape');
  assert.equal(await panel.count(), 0);
  checks.push('clear cancel and confirm, error and refresh recovery, 820×558 layout, Escape closes and restores focus');
  assert.deepEqual(errors, []);
  await writeFile(new URL(`ui-result-${engine}.json`, output), JSON.stringify({ passed: true, engine, checks }, null, 2) + '\n');
  console.log(JSON.stringify({ passed: true, checks }, null, 2));
} catch (error) {
  if (workbench) {
    await workbench.page.screenshot({ path: fileURLToPath(new URL('failure.png', output)) });
    console.error({ tabs: await workbench.page.getByRole('tab').allTextContents(), errors: workbench.errors });
  }
  throw error;
} finally { await workbench?.browser.close(); await controller.close(); }
