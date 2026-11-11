// External agents use the same native bridge as this window. No script or
// expression is accepted: native actions retain their existing platform checks.
import { clientStorageKey } from "./client-context.mjs";

export const agentClientPreferences = Object.freeze([
  { key: "cage-active", scoped: true, format: "string", description: "ID активной вкладки" },
  { key: "cage-sidebar-collapsed", scoped: true, format: "JSON boolean", description: "Состояние сворачивания боковой панели" },
  { key: "cage-browser-tab-layout", scoped: true, format: 'JSON "horizontal" | "vertical"', description: "Расположение вкладок браузера" },
  { key: "cage-tab-layout", scoped: true, format: "JSON object", description: "Названия, закрепление и порядок вкладок по рабочей среде" },
  { key: "cage-keyboard", scoped: true, remoteOnly: true, format: 'string "mac" | "native"', description: "Привычки горячих клавиш удалённой среды на текущем клиенте; локально используется settings.keyboard" },
  { key: "cage.audio", scoped: false, format: "JSON {muted:boolean, volume:number 0..1}", description: "Настройки звука текущего клиента" },
  { key: "cage-desktop-zoom", scoped: false, format: "string number: 0.75, 0.9, 1, 1.1, 1.25, 1.5", description: "Масштаб отображения Claude Desktop" },
  { key: "cage-recent-environment", scoped: false, format: "string", description: "ID последней выбранной локальной среды или хоста" },
]);

const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
function validPreference(key, raw) {
  if (raw === null) return true;
  if (typeof raw !== "string") return false;
  if (["cage-active", "cage-recent-environment"].includes(key)) return true;
  if (key === "cage-keyboard") return ["mac", "native"].includes(raw);
  if (key === "cage-desktop-zoom") return [0.75, 0.9, 1, 1.1, 1.25, 1.5].includes(Number(raw));
  let value;
  try { value = JSON.parse(raw); } catch { return false; }
  if (key === "cage-sidebar-collapsed") return typeof value === "boolean";
  if (key === "cage-browser-tab-layout") return ["horizontal", "vertical"].includes(value);
  if (key === "cage.audio") return object(value) && typeof value.muted === "boolean" && Number.isFinite(value.volume) && value.volume >= 0 && value.volume <= 1 && Object.keys(value).every(field => ["muted", "volume"].includes(field));
  if (key === "cage-tab-layout") {
    if (!object(value)) return false;
    return Object.values(value).every(workspace => object(workspace) && Object.entries(workspace).every(([id, metadata]) => {
      if (id === "order") return Array.isArray(metadata) && metadata.every(item => typeof item === "string");
      if (id === "sessionOrder") return object(metadata) && Object.values(metadata).every(order => Array.isArray(order) && order.every(item => typeof item === "string"));
      return object(metadata) && Object.entries(metadata).every(([field, item]) => field === "title" ? typeof item === "string" : field === "pinned" && typeof item === "boolean");
    }));
  }
  return false;
}

function connectionChanged() {
  const error = new Error("Рабочая среда переключена; нативная операция не повторялась в новой среде. Проверьте результат исходной операции.");
  error.code = "connection_changed";
  return error;
}

export function clientPreferences(request, context, storage) {
  if (!["get", "set"].includes(request.operation)) throw new Error("Операция клиентских настроек должна быть get или set.");
  const keys = new Map(agentClientPreferences.map(item => [item.key, item]));
  const path = (key) => keys.get(key).scoped ? clientStorageKey(key, context) : key;
  if (request.operation === "set") {
    if (!object(request.values) || !Object.keys(request.values).length) throw new Error("Укажите values клиентских настроек для изменения.");
    // Validate the whole patch before changing any storage entry.
    for (const [key, raw] of Object.entries(request.values)) {
      if (!keys.has(key)) throw new Error("Клиентские настройки содержат неподдерживаемый ключ. Внешний вид изменяйте через интерфейс appearance.");
      if (keys.get(key).remoteOnly && context.mode !== "remote") throw new Error("Локальные привычки клавиатуры изменяйте через settings.keyboard.");
      if (!validPreference(key, raw)) throw new Error("Неверный формат клиентских настроек. Сохраняйте исходный строковый формат соответствующей настройки.");
    }
    const previous = new Map(Object.keys(request.values).map(key => [path(key), storage.getItem(path(key))]));
    try {
      for (const [key, raw] of Object.entries(request.values)) {
        if (raw === null) storage.removeItem(path(key));
        else storage.setItem(path(key), raw);
      }
    } catch (error) {
      for (const [key, raw] of previous) {
        try { if (raw === null) storage.removeItem(key); else storage.setItem(key, raw); } catch { /* Keep the original storage failure. */ }
      }
      throw error;
    }
  }
  const available = agentClientPreferences.filter(item => !item.remoteOnly || context.mode === "remote");
  return {
    connection_id: context.connection_id,
    values: Object.fromEntries(available.map(item => [item.key, storage.getItem(path(item.key))])),
    storage_keys: Object.fromEntries(available.map(item => [item.key, path(item.key)])),
    fields: available,
    reload_required: request.operation === "set",
  };
}

export async function executeAgentNative(item, { native, getContext, storage }) {
  const context = getContext();
  if (!item.connection_id || item.connection_id !== context.connection_id) throw connectionChanged();
  const request = item.request;
  if (!object(request) || typeof request.action !== "string") throw new Error("Неверный формат нативного запроса.");
  let result;
  if (request.action === "clientPreferences") result = clientPreferences(request, context, storage);
  else {
    const { action, connection_id: ignoredConnection, ...extra } = request;
    void ignoredConnection;
    result = await native(action, extra);
    // Native session tickets belong to the transport. An agent can request a
    // refresh, but never receives the launch URL or its secret fragment.
    if (action === "refreshSession") result = { refreshed: true };
  }
  if (getContext().connection_id !== item.connection_id) throw connectionChanged();
  return result === undefined ? null : result;
}

export function createAgentNativeConsumer({ api, native, nativeAvailable, getContext, storage, reload, getOrigin = () => globalThis.location?.origin, schedule = setTimeout, cancel = clearTimeout, interval = 750, onError = () => {} }) {
  let stopped = true;
  let timer;
  let running = false;
  let completion;
  let proof;
  const registerWindow = async () => {
    const entry = await native("refreshSession");
    let url;
    try { url = new URL(entry?.url); } catch { throw new Error("Не удалось проверить точку входа нативного окна. Переподключитесь к Cage."); }
    if (url.origin !== getOrigin() || !url.hash.slice(1)) throw new Error("Точка входа нативного окна изменилась; билет проверки не отправлен на другой адрес. Переподключитесь к Cage.");
    const value = await api("/agent/native/window", { ticket: url.hash.slice(1) });
    if (typeof value?.window_proof !== "string" || !value.window_proof) throw new Error("Аутентификация нативного окна не завершена. Переподключитесь к Cage.");
    proof = value.window_proof;
  };
  const poll = async () => {
    if (stopped || running) return;
    if (!nativeAvailable()) { timer = schedule(poll, interval); return; }
    running = true;
    try {
      if (!proof) await registerWindow();
      if (!completion) {
        if (stopped) return;
        const item = await api("/agent/native?consumer=window", undefined, undefined, { "X-Cage-Agent-Window": proof });
        if (item?.id) {
          if (stopped) {
            completion = { id: item.id, body: { error: "Окно рабочего стола закрыто; нативная операция не выполнена." } };
          } else {
            try {
              const result = await executeAgentNative(item, { native, getContext, storage });
              completion = { id: item.id, body: { result }, reload: result?.reload_required === true };
            } catch (error) {
              completion = { id: item.id, body: { error: error?.message || "Нативная операция не завершена. Проверьте текущее окно." } };
            }
          }
        }
      }
      if (completion) {
        const pending = completion;
        await api(`/agent/native/${encodeURIComponent(pending.id)}/complete`, pending.body, undefined, { "X-Cage-Agent-Window": proof });
        completion = undefined;
        if (pending.reload && !stopped) { stopped = true; reload(); }
      }
    } catch (error) {
      // Only a completion receipt is retried. An accepted native action is
      // never re-executed after a lost connection or lost response.
      if (error?.status === 401 || error?.status === 403) proof = undefined;
      onError(error);
    } finally {
      running = false;
      if (!stopped) timer = schedule(poll, interval);
    }
  };
  return {
    start() { if (!stopped) return; stopped = false; void poll(); },
    stop() { stopped = true; if (timer !== undefined) cancel(timer); },
  };
}

let installedConsumer;
export function installAgentNativeConsumer(dependencies, environment = globalThis) {
  if (installedConsumer || !environment.document || !environment.window) return;
  const consumer = createAgentNativeConsumer({
    ...dependencies,
    storage: {
      getItem: key => environment.localStorage.getItem(key),
      setItem: (key, value) => environment.localStorage.setItem(key, value),
      removeItem: key => environment.localStorage.removeItem(key),
    },
    reload: () => environment.location.reload(),
    getOrigin: () => environment.location.origin,
  });
  installedConsumer = consumer;
  const start = () => { if (dependencies.nativeAvailable()) consumer.start(); };
  environment.window.addEventListener("cage-session-ready", start);
  environment.window.addEventListener("pagehide", () => consumer.stop());
  environment.window.addEventListener("pageshow", start);
  // A fresh launch URL must first be exchanged by ClientRoot/AccountProvider.
  // Existing windows without a fragment already hold their session cookie.
  if (!environment.location?.hash) start();
}
