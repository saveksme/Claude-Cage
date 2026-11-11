const safetyCheckPatterns = [
  // Older backend builds still send these messages.
  /关键(?:检查|检测)(?:尚未|未|失败|证据不完整)|完成关键检查|外网(?:未放行|保持关闭)|浏览器配置检查未通过/,
  /ключев\p{L}*\s+(?:проверк|проверок)[^.!?]{0,80}(?:не\s+(?:пройден|завершен|выполнен|подтвержден|удал)|неудач|провал|ошибк|неполн|недостаточн)/iu,
  /(?:завершите|выполните|пройдите)\s+ключев\p{L}*\s+проверк/iu,
  /(?:внешн\p{L}*\s+сеть|внешн\p{L}*\s+сети|доступ\s+во\s+внешн\p{L}*\s+сеть|выход\s+в\s+интернет|доступ\s+в\s+интернет)[^.!?]{0,80}(?:не\s+(?:разреш|открыт|предоставлен)|закрыт|оста(?:е|ё)тся\s+закрыт|удержива|блокиру|запрещ)/iu,
  /интернет[^.!?]{0,40}(?:не\s+разреш|закрыт|заблокирован)/iu,
  /проверк\p{L}*\s+(?:конфигурации|настроек)\s+браузера[^.!?]{0,60}(?:не\s+(?:пройден|завершен|выполнен)|неудач|провал)/iu,
  /сетев\p{L}*\s+доступ[^.!?]{0,60}(?:не\s+(?:разреш|предоставлен)|закрыт|заблокирован)/iu,
];

export function isSafetyCheckMessage(message) {
  return (
    typeof message === "string" &&
    safetyCheckPatterns.some((pattern) => pattern.test(message))
  );
}

export function networkState(status, now = Date.now()) {
  if (!status?.vm_running)
    return { mode: "stopped", label: "Среда остановлена" };
  const gate = status.safety?.gate;
  if (!gate)
    return { mode: "unknown", label: "Состояние внешней сети не подтверждено" };
  const until = Date.parse(gate.until);
  if (gate.mode === "open" && Number.isFinite(until) && until > now)
    return { mode: "open", label: "Внешняя сеть разрешена" };
  if (gate.mode === "checking" && Number.isFinite(until) && until > now)
    return { mode: "checking", label: "Проверка выполняется" };
  if (gate.mode === "closed" || (Number.isFinite(until) && until <= now))
    return { mode: "closed", label: "Внешняя сеть закрыта" };
  return { mode: "unknown", label: "Состояние внешней сети не подтверждено" };
}

export function canonicalExitPolicy(value = {}) {
  return {
    mode: value.mode || "dynamic",
    scope: value.scope || "country",
    ip: (value.ip || "").trim(),
    country_code: (value.country_code || "").trim().toUpperCase(),
    region: (value.region || "").trim().replace(/\s+/g, " "),
    city: (value.city || "").trim().replace(/\s+/g, " "),
  };
}

export function reportForSharing(report) {
  return {
    policy: report.policy,
    created_at: report.created_at,
    checks: report.checks,
    scope:
      "Проверки выборки и политик выполнения; не подтверждают допуск аккаунта к платформе и не заменяют полный аудит виртуализации",
  };
}

export function isGuestLocalURL(value) {
  if (value === "about:blank") return true;
  try {
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    );
  } catch {
    return false;
  }
}
