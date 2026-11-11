import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createWorkbench } from "./workbench-fixture.mjs";

// Drives the shared workbench with an isolated account registry. No real credentials or VM.
const { browser, page, state, errors } = await createWorkbench();
const profiles = [];
const starts = [];
let assignedProfile = 0;
let failRefresh = false;
let accountRequests = 0;
const usageRequests = [];
let heldRefresh = null;
let offlineUsage = false;
let panelWorker = false;
let usageUnavailable = "";
let defaultLogin = null;
let detectionError = "";
let lastLoginNotice = "";
const joins = [];
const now = Math.floor(Date.now() / 1000);
const openAccounts = async () => {
  await page.getByRole("button", { name: "Настройки", exact: true }).click();
  await page.getByRole("button", { name: "Аккаунты Claude", exact: true }).click();
};

async function checkLongAccountList() {
  const total = 40;
  for (let number = profiles.length + 1; number <= total; number++) {
    profiles.push({
      id: "profile-" + number, label: "Тестовый аккаунт " + number, enabled: true, status: "ready",
      email: `user.${number}@example.test`, plan: "Pro",
      quota: { observed_at: now, five_hour: { used_percentage: 28, resets_at: now + 6000 },
        seven_day: { used_percentage: 64, resets_at: now + 200000 } },
    });
  }
  await openAccounts();
  const list = page.getByRole("region", { name: "Список аккаунтов", exact: true });
  const last = list.getByRole("article", { name: "Тестовый аккаунт " + total, exact: true });
  await last.waitFor({ state: "attached" });
  assert.equal(await list.getByRole("article").count(), total);
  const header = page.getByRole("heading", { name: "Аккаунты Claude", exact: true });
  const add = page.getByRole("button", { name: "Войти в новый аккаунт", exact: true });
  const headerY = (await header.boundingBox()).y;
  const addY = (await add.boundingBox()).y;
  assert.ok(headerY >= 0 && addY >= 0);
  assert.ok(await list.evaluate((el) => el.scrollHeight > el.clientHeight * 2 && el.clientHeight > 0));
  await list.hover();
  await page.mouse.wheel(0, 640);
  await page.waitForFunction((el) => el.scrollTop > 0, await list.elementHandle());
  assert.ok(Math.abs((await header.boundingBox()).y - headerY) <= 1, "scrolling must not move the panel title");
  assert.ok(Math.abs((await add.boundingBox()).y - addY) <= 1, "the add action must stay in view");

  await add.focus();
  const reachableControls = await list.locator("button:not(:disabled),input:not(:disabled),[tabindex='0']").count();
  // On macOS, WebKit's all-controls traversal uses Option-Tab.
  const nextControl = process.platform === "darwin" && browser.browserType().name() === "webkit" ? "Alt+Tab" : "Tab";
  let reached = false;
  for (let step = 0; step < reachableControls + 5; step++) {
    await page.keyboard.press(nextControl);
    if (await last.evaluate((row) => row.contains(document.activeElement))) {
      reached = true;
      break;
    }
  }
  assert.ok(reached, "tab navigation must reach a control in the last account");
  const visibleFocus = await list.evaluate((el) => {
    const focused = document.activeElement.getBoundingClientRect();
    const viewport = el.getBoundingClientRect();
    return focused.top >= viewport.top - 1 && focused.bottom <= viewport.bottom + 1;
  });
  assert.ok(visibleFocus, "the account list must scroll the focused control into view");
  assert.ok(Math.abs((await add.boundingBox()).y - addY) <= 1);

  for (const width of [1280, 520, 375]) {
    await page.setViewportSize({ width, height: 700 });
    const bounds = await list.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth,
      document: document.documentElement.scrollWidth, viewport: window.innerWidth }));
    assert.ok(bounds.scroll <= bounds.client + 1 && bounds.document <= bounds.viewport + 1,
      `the account list must fit a ${width}px viewport horizontally: ${JSON.stringify(bounds)}`);
    const first = await last.getByRole("progressbar", { name: "5h: использованная квота" }).boundingBox();
    const second = await last.getByRole("progressbar", { name: "7d: использованная квота" }).boundingBox();
    assert.ok(first.width > 0 && Math.abs(first.x - second.x) <= 1 && Math.abs(first.width - second.width) <= 1,
      "5h and 7d progress bars must start and end at the same horizontal positions");
    assert.ok(first.y + first.height <= second.y, "the two limits occupy separate rows");
  }
  await page.getByRole("button", { name: "Вернуться в рабочую среду", exact: true }).click();
  await page.setViewportSize({ width: 1280, height: 850 });
}

async function checkLocalCountdown() {
  const frozen = new Date("2030-01-01T08:00:00Z");
  await page.clock.install({ time: new Date(+frozen - 60_000) });
  await page.reload();
  await page.getByRole("tab", { name: "Терминал 4 · Работа", exact: true }).waitFor();
  await page.clock.pauseAt(frozen);
  const seconds = +frozen / 1000;
  profiles[0].quota = { observed_at: seconds, five_hour: { used_percentage: 28, observed_at: seconds - 900, resets_at: seconds + 5 },
    seven_day: { used_percentage: 64, observed_at: seconds, resets_at: seconds + 7200 } };
  await openAccounts();
  const row = page.getByRole("article", { name: "Работа", exact: true });
  await row.getByText("через 5 с", { exact: true }).waitFor();
  await row.getByText("Обновлено только что", { exact: true }).waitFor();
  await page.getByText("Запрос использования аккаунтов…").waitFor({ state: "hidden" });
  const requestsBefore = accountRequests;
  const wavesBefore = usageRequests.filter((r) => r.action === "usage_panel").length;
  await page.clock.runFor(2000);
  await row.getByText("через 3 с", { exact: true }).waitFor();
  await page.clock.runFor(3000);
  await row.getByText("Ожидание обновления", { exact: true }).waitFor();
  assert.equal(await row.getByText("28%", { exact: true }).count(), 0, "expired quota cannot remain current");
  const expired = row.getByRole("group", { name: "5h: квота" });
  assert.equal(await expired.getByRole("progressbar").count(), 0);
  const history = expired.getByText(/В прошлый раз/);
  assert.equal(await history.locator("time").getAttribute("datetime"), new Date((seconds - 900) * 1000).toISOString());
  await row.getByText("64%", { exact: true }).waitFor();
  assert.equal(accountRequests, requestsBefore, "countdown ticks and expiry must not poll the account API");
  const joinedBefore = joins.length;
  defaultLogin = { identity: "fresh-session", email: "new@example.test", plan: "Pro" };
  await page.clock.runFor(8000);
  await page.getByRole("article", { name: defaultLogin.email }).getByRole("button", { name: "Добавить в распределение" }).waitFor();
  assert.equal(joins.length, joinedBefore, "discovering a new default identity during polling cannot enroll it");
  assert.equal(usageRequests.filter((r) => r.action === "usage_panel").length, wavesBefore, "12-second panel polling cannot start another usage query");
  assert.ok(usageRequests.some((r) => !r.action && r.visible), "a visible panel keeps the existing queue alive via GET");
  await page.clock.runFor(47_000);
  await row.getByText("Обновлено 1 мин назад", { exact: true }).waitFor();
  await page.clock.runFor(240_000);
  await row.getByText("Обновлено 5 мин назад", { exact: true }).waitFor();
}

async function checkUsagePanel() {
  const profile = profiles[0];
  const waves = () => usageRequests.filter((r) => r.action === "usage_panel").length;
  const before = waves();
  panelWorker = true;
  await openAccounts();
  const row = page.getByRole("article", { name: profile.label, exact: true });
  await page.getByText("Проверка использования аккаунтов…", { exact: true }).waitFor();
  profile.usage_checking = true;
  await row.getByText("Запрос квоты…").waitFor();
  assert.equal(waves(), before + 1, "opening the panel initiates one real usage request");
  assert.equal(await row.getByRole("button", { name: "Проверить состояние" }).isEnabled(), false);
  panelWorker = false;
  Object.assign(profile, { usage_checking: false, usage_status: "cached", usage_checked_at: now });
  await row.getByText("В этот раз только кэшированные данные").waitFor();
  await row.getByText("23%", { exact: true }).waitFor();
  await row.getByText("Прежние данные", { exact: true }).waitFor();
  await page.setViewportSize({ width: 375, height: 700 });
  const list = page.getByRole("region", { name: "Список аккаунтов", exact: true });
  assert.ok(await list.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), "window history fits the narrow account list");
  await page.setViewportSize({ width: 1280, height: 850 });
  assert.equal(waves(), before + 1, "polling the completed query does not start another query");
  const back = page.getByRole("button", { name: "Вернуться в рабочую среду", exact: true });
  await back.click();
  offlineUsage = true;
  await openAccounts();
  await row.getByText("Среда не в сети, запрос невозможен").waitFor();
  await row.getByText("23%", { exact: true }).waitFor();
  assert.equal(await row.getByRole("button", { name: "Проверить состояние" }).isEnabled(), false);
  await back.click();
  offlineUsage = false;
  usageUnavailable = "Сеть приостановлена; квоту подписки можно запросить после восстановления подключения";
  await openAccounts();
  await page.getByText(usageUnavailable).waitFor();
  assert.equal(await row.getByRole("button", { name: "Проверить состояние" }).isEnabled(), false);
  assert.equal(await page.getByRole("button", { name: "Войти в новый аккаунт", exact: true }).isEnabled(), true);
  await back.click();
  usageUnavailable = "";
  profile.usage_status = "not_applicable";
  await openAccounts();
  await row.getByText("Текущий вход не предоставляет квоту подписки").waitFor();
  await row.getByText("Прежние данные", { exact: true }).waitFor();
  await back.click();
  // An upstream probe failure is also a normal panel response, distinct from an HTTP transport error.
  profile.usage_status = "error";
  profile.usage_checked_at = now;
  await openAccounts();
  await row.getByText("Не удалось запросить квоту").waitFor();
  const failedFive = row.getByRole("group", { name: "5h: квота" });
  assert.equal(await failedFive.locator("time").getAttribute("datetime"), new Date((now - 3600) * 1000).toISOString());
  const failedWeek = row.getByRole("group", { name: "7d: квота" });
  assert.equal(await failedWeek.getByRole("progressbar").count(), 0);
  assert.equal(await failedWeek.getByText(/В прошлый раз/).locator("time").getAttribute("datetime"), new Date((now - 7200) * 1000).toISOString());
  await back.click();
}
try {
  await page.route("**/api/claude-accounts*", async (route) => {
    accountRequests++;
    const body = route.request().postDataJSON();
    usageRequests.push({ ...body, visible: new URL(route.request().url()).searchParams.get("panel") === "visible" });
    if (body) assert.ok(["join", "update", "refresh", "cancel", "refresh_default", "usage_panel"].includes(body.action));
    if (body?.action === "join") {
      joins.push(body);
      if (!defaultLogin || body.identity !== defaultLogin.identity)
        return route.fulfill({ status: 409, contentType: "text/plain; charset=utf-8", body: "Учётная запись входа в среде изменилась; обновите и подтвердите аккаунт для добавления" });
      profiles.push({ id: "default-" + defaultLogin.identity, source: "default", label: defaultLogin.email,
        email: defaultLogin.email, plan: defaultLogin.plan, enabled: true, status: "ready" });
    }
    if (body?.action === "cancel") {
      const index = profiles.findIndex((profile) => profile.id === body.id);
      assert.equal(index, 0);
      profiles.splice(index, 1);
    }
    if (body?.action === "update") Object.assign(profiles.find((a) => a.id === body.id),
      body.label !== undefined ? { label: body.label } : { enabled: body.enabled });
    if (body?.action === "refresh" && failRefresh)
      return route.fulfill({ status: 503, contentType: "text/plain; charset=utf-8", body: "Пока не удалось прочитать вход по умолчанию для среды; убедитесь, что Claude Code и компоненты среды доступны, и повторите" });
    if (body?.action === "refresh" && heldRefresh) await heldRefresh.promise;
    if (body?.action === "refresh_default") {
      assert.equal(body.identity, defaultLogin?.identity);
      Object.assign(defaultLogin, { usage_status: "unavailable", usage_checked_at: now });
    }
    return route.fulfill({ json: { accounts: profiles, detection_status: offlineUsage ? "offline" : detectionError ? "unavailable" : defaultLogin ? "ready" : "signed_out",
      detected: !detectionError && defaultLogin && !profiles.some((p) => p.email === defaultLogin.email) ? defaultLogin : undefined,
      detection_error: detectionError, login_notice: lastLoginNotice, usage_panel_running: panelWorker,
      usage_unavailable_reason: usageUnavailable } });
  });
  await page.route("**/api/terminals", async (route) => {
    const body = route.request().postDataJSON();
    if (!body) return route.fulfill({ json: state.terminals });
    starts.push(body);
    if (body.kind === "claude" && profiles.length && !profiles[assignedProfile].enabled)
      return route.fulfill({ status: 409, contentType: "text/plain; charset=utf-8", body: "Нет доступных для распределения аккаунтов Claude. Проверьте в панели аккаунтов вход, участие в распределении и время сброса квоты" });
    const terminal = { id: String(starts.length), title: "Терминал " + starts.length, kind: body.kind,
      workspace: body.workspace, claude_account_id: body.kind === "claude-login" ? body.claude_account_id || "one"
        : body.kind === "claude" ? profiles[assignedProfile]?.id : undefined,
      claude_account_source: body.kind === "claude-login" ? "managed" : profiles[assignedProfile]?.source };
    state.terminals.push(terminal);
    return route.fulfill({ json: terminal });
  });
  state.status.vm_running = state.status.ready = true;
  await page.reload();
  await page.getByRole("button", { name: /^Создать терминал в проекте / }).waitFor();
  assert.equal(usageRequests.filter((r) => r.action === "usage_panel").length, 0, "launching the workbench must not query subscription usage");
  const plus = page.getByRole("button", { name: /^Создать терминал в проекте / });
  const launchClaude = async () => {
    await plus.click();
    await page.getByRole("menuitem", { name: "Терминал Claude", exact: true }).press("Enter");
  };
  const back = () => page.getByRole("button", { name: "Вернуться в рабочую среду", exact: true }).click();
  const profileCard = (label) => page.getByRole("article", { name: label, exact: true });
  const rename = async (before, label) => {
    const row = profileCard(before);
    await row.getByRole("button", { name: "Изменить заметку для " + before }).click();
    await row.getByRole("textbox", { name: "Заметка к аккаунту" }).fill(label);
    await row.getByRole("button", { name: "Сохранить заметку" }).click();
  };

  // Records created by the previous version keep their recovery actions.
  profiles.push({ id: "legacy", label: "Черновик", status: "pending", enabled: true });
  await openAccounts();
  const draft = profileCard("Черновик");
  await draft.getByRole("button", { name: "Отменить добавление" }).click();
  const confirmation = page.getByRole("dialog", { name: "Отменить добавление «Черновик»?" });
  await confirmation.getByText(/исходный вход среды/).waitFor();
  await confirmation.getByRole("button", { name: "Отмена", exact: true }).click();
  assert.equal(profiles.length, 1);
  await draft.getByRole("button", { name: "Отменить добавление" }).click();
  await confirmation.getByRole("button", { name: "Отменить добавление", exact: true }).click();
  await page.getByText("Аккаунтов в распределении пока нет.").waitFor();
  await page.getByText(/В обычном терминале ещё не выполнен вход в подписку Claude/).waitFor();
  await back();
  await launchClaude();
  await page.getByRole("tab", { name: "Терминал 1", exact: true }).waitFor();
  assert.deepEqual(starts[0], { workspace: state.settings.workspace, kind: "claude" });

  await openAccounts();
  assert.equal(await page.getByRole("textbox", { name: "Заметка к аккаунту" }).count(), 0);
  await page.getByRole("button", { name: "Войти в новый аккаунт", exact: true }).click();
  await page.getByRole("tab", { name: "Терминал 2 · Вход в новый аккаунт", exact: true }).waitFor();
  assert.deepEqual(starts[1], { workspace: state.settings.workspace, kind: "claude-login" });
  assert.equal(profiles.length, 0, "opening a login terminal must not create a pool account");
  state.terminals[1].closed = true;
  const email = "example@test.invalid";
  profiles.push({ id: "one", status: "ready", label: email, email, plan: "Pro", enabled: true, source: "managed",
    quota: { observed_at: now, five_hour: { used_percentage: 0, observed_at: now - 3600, resets_at: now + 3600 },
      seven_day: { used_percentage: 100, observed_at: now - 7200, resets_at: now - 80 } } });
  lastLoginNotice = "Добавлен " + email;
  await openAccounts();
  await page.getByText(lastLoginNotice).waitFor();
  await rename(email, "Работа");
  let card = profileCard("Работа");
  await card.getByText("0%", { exact: true }).waitFor();
  await card.getByText("Прежние данные", { exact: true }).waitFor();
  await card.getByText("Ожидание обновления", { exact: true }).waitFor();
  assert.equal(await card.getByRole("button", { name: "Отменить добавление" }).count(), 0);
  await card.getByRole("checkbox", { name: "Участвовать в автоматическом распределении" }).click();
  await card.getByRole("checkbox", { checked: false }).waitFor();
  failRefresh = true;
  await card.getByRole("button", { name: "Проверить состояние" }).click();
  await page.getByRole("alert").filter({ hasText: "Пока не удалось прочитать вход по умолчанию для среды; убедитесь, что Claude Code и компоненты среды доступны, и повторите" }).waitFor();
  await card.getByText("Не удалось запросить квоту").waitFor();
  await card.getByText("0%", { exact: true }).waitFor();
  assert.equal(await card.getByRole("group", { name: "5h: квота" }).locator("time").getAttribute("datetime"), new Date((now - 3600) * 1000).toISOString());
  assert.equal(await card.getByRole("group", { name: "7d: квота" }).getByText(/В прошлый раз/).locator("time").getAttribute("datetime"), new Date((now - 7200) * 1000).toISOString());
  failRefresh = false;
  heldRefresh = Promise.withResolvers();
  await card.getByRole("button", { name: "Проверить состояние" }).click();
  await card.getByText("Запрос квоты…").waitFor();
  assert.equal(await card.getByRole("button", { name: "Проверить состояние" }).isEnabled(), false);
  assert.deepEqual(usageRequests.filter((r) => r.action === "refresh").at(-1), { action: "refresh", id: "one", visible: false });
  // A partial result with an unknown reset is usable without inventing a countdown.
  Object.assign(profiles[0], { usage_status: "partial", usage_checked_at: now,
    quota: { five_hour: { used_percentage: 23, observed_at: now - 3600, resets_at: 0 },
      seven_day: { used_percentage: 100, observed_at: now - 7200, resets_at: now - 80 }, observed_at: now - 3600 } });
  heldRefresh.resolve();
  await card.getByText("В этот раз получена только часть квоты").waitFor();
  await card.getByText("23%", { exact: true }).waitFor();
  await card.getByText(/Считано /).waitFor();
  await card.getByText("Время сброса неизвестно", { exact: true }).waitFor();
  const oldWeek = card.getByRole("group", { name: "7d: квота" }).getByText(/В прошлый раз/);
  assert.equal(await oldWeek.locator("time").getAttribute("datetime"), new Date((now - 7200) * 1000).toISOString());
  const updated = card.getByText(/Обновлено/);
  assert.equal(await updated.count(), 1);
  assert.equal(await updated.locator("time").getAttribute("datetime"), new Date((now - 3600) * 1000).toISOString(),
    "a newer query must not make retained quota readings appear fresh");
  assert.equal(await card.getByText(/^(Считано|В прошлый раз) /).count(), 0);
  heldRefresh = null;
  await back();
  await launchClaude();
  await page.getByText("Нет доступных для распределения аккаунтов Claude. Проверьте в панели аккаунтов вход, участие в распределении и время сброса квоты", { exact: true }).waitFor();
  assert.equal(await page.getByRole("tab", { name: /^Терминал / }).count(), 2);
  await openAccounts();
  await card.getByRole("checkbox", { name: "Участвовать в автоматическом распределении" }).click();
  await card.getByRole("checkbox", { checked: true }).waitFor();
  await back();
  await launchClaude();
  await page.getByRole("tab", { name: "Терминал 4 · Работа", exact: true }).waitFor();
  await page.getByText("Claude · Работа", { exact: true }).waitFor();
  assert.deepEqual(starts.at(-1), { workspace: state.settings.workspace, kind: "claude" });

  const identityA = { identity: "a-in-org", email: "a@example.test", organization: "Org", plan: "Pro" };
  defaultLogin = identityA;
  await openAccounts();
  assert.equal(await card.getByRole("button", { name: "Войти снова" }).isEnabled(), false);
  const detectedA = profileCard(identityA.email);
  await detectedA.getByText(/обнаружен, не добавлен/).waitFor();
  const clawd = await readFile(new URL("../src/claude-account-crab.svg", import.meta.url), "utf8");
  assert.ok(await detectedA.locator("img").evaluate(async (img, source) => {
    await img.decode();
    const shape = (svg) => {
      const root = new DOMParser().parseFromString(svg, "image/svg+xml").documentElement;
      return [root.getAttribute("viewBox"), root.getAttribute("fill"), ...Array.from(root.querySelectorAll("path"), (p) => p.getAttribute("d"))];
    };
    const data = /^data:image\/svg\+xml(;base64)?,(.*)$/s.exec(img.currentSrc);
    const rendered = data ? data[1] ? atob(data[2]) : decodeURIComponent(data[2]) : await (await fetch(img.currentSrc)).text();
    return img.naturalWidth > 0 && JSON.stringify(shape(rendered)) === JSON.stringify(shape(source));
  }, clawd), "the detected account renders the same Clawd artwork as managed accounts");
  assert.equal(await detectedA.getByRole("checkbox").count(), 0);
  await page.setViewportSize({ width: 375, height: 700 });
  const panelList = page.getByRole("region", { name: "Список аккаунтов", exact: true });
  assert.ok(await panelList.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), "detected identities fit on a narrow screen");
  await page.setViewportSize({ width: 1280, height: 850 });
  assert.equal(profiles.length, 1, "detected identity is not in the pool");
  await detectedA.getByRole("button", { name: "Проверить состояние" }).click();
  await detectedA.getByText("Квота не получена").waitFor();
  assert.equal(await detectedA.getByText(/Обновлено/).locator("time").getAttribute("datetime"), new Date(now * 1000).toISOString(),
    "accounts without readings fall back to the latest query time");
  assert.equal(await detectedA.getByText("Нет данных", { exact: true }).count(), 2);
  assert.deepEqual(usageRequests.filter((r) => r.action === "refresh_default").at(-1), { action: "refresh_default", identity: identityA.identity, visible: false });
  await detectedA.getByRole("button", { name: "Добавить в распределение" }).click();
  await detectedA.getByText("Аккаунт обычного терминала", { exact: true }).waitFor();
  assert.deepEqual(joins.at(-1), { action: "join", identity: identityA.identity });
  assert.equal(await detectedA.getByRole("button", { name: /Вход/ }).count(), 0);
  await rename(identityA.email, "Личный");
  await profileCard("Личный").waitFor();
  await rename("Личный", "");
  await profileCard(identityA.email).waitFor();
  await rename(identityA.email, "Личный");
  await back();
  assignedProfile = 1;
  await launchClaude();
  await page.getByRole("tab", { name: "Терминал 5 · Личный", exact: true }).waitFor();
  defaultLogin = { identity: "b-in-org", email: "b@example.test", plan: "Pro" };
  profiles[1].status = "changed";
  profiles[1].quota = null;
  await openAccounts();
  const nextIdentity = profileCard(defaultLogin.email);
  await nextIdentity.getByText(/не добавлен/).waitFor();
  await profileCard("Личный").getByText(/откройте эти сеансы заново, чтобы подтвердить личность/).waitFor();
  assert.equal(await nextIdentity.getByRole("checkbox").count(), 0);
  assert.equal(profiles[1].email, identityA.email);
  // Identity changes again while this stale B card remains visible.
  defaultLogin = { identity: "c-in-org", email: "c@example.test", plan: "Pro" };
  await nextIdentity.getByRole("button", { name: "Добавить в распределение" }).click();
  await page.getByRole("alert").filter({ hasText: "Учётная запись входа в среде изменилась" }).waitFor();
  await profileCard(defaultLogin.email).getByText(/не добавлен/).waitFor();
  assert.equal(joins.at(-1).identity, "b-in-org");
  assert.equal(profiles.length, 2);
  await back();
  // Re-authenticating A independently updates its registry entry, not the source of an existing terminal.
  Object.assign(profiles[1], { source: "managed", status: "ready" });
  await openAccounts();
  await profileCard("Личный").getByText(/использующих вход обычного терминала/).waitFor();
  await back();
  await page.getByRole("tab", { name: "Терминал 5 · Личный", exact: true }).click();
  await page.getByText("Claude · Личный (аккаунт при запуске)", { exact: true }).waitFor();
  await page.getByRole("tab", { name: "Терминал 4 · Работа", exact: true }).click();
  await page.getByText("Claude · Работа", { exact: true }).waitFor();
  assert.equal(starts.length, 5, "changing the environment identity must never replay a session");
  detectionError = "Не удалось прочитать состояние обычного терминала";
  await openAccounts();
  await page.getByRole("alert").filter({ hasText: detectionError }).waitFor();
  assert.equal(await page.getByText(/В обычном терминале ещё не выполнен вход в подписку Claude/).count(), 0);
  await back();
  detectionError = "";
  defaultLogin = null;
  await page.reload();
  await page.getByRole("tab", { name: "Терминал 4 · Работа", exact: true }).waitFor();
  await page.getByRole("tab", { name: "Терминал 5 · Личный", exact: true }).waitFor();
  state.terminals.find((t) => t.id === "4").closed = true;
  await openAccounts();
  await card.getByRole("checkbox", { name: "Участвовать в автоматическом распределении" }).click();
  await card.getByRole("checkbox", { checked: false }).waitFor();
  await card.getByRole("button", { name: "Войти снова" }).click();
  await page.getByRole("tab", { name: "Терминал 6 · Работа", exact: true }).waitFor();
  assert.deepEqual(starts.at(-1), { workspace: state.settings.workspace, kind: "claude-login", claude_account_id: "one" });
  assert.ok(!state.requests.some((r) => r.path.startsWith("/claude-desktop") && r.method === "POST"));
  await checkUsagePanel();
  await checkLongAccountList();
  await checkLocalCountdown();
  assert.deepEqual(errors, []);
  console.log("Claude account UI: independent login, explicit default enrollment, identity change, quota, terminal affinity, accessible scrolling and countdown passed.");
} finally {
  await browser.close();
}
