function safeLocalizedMessage(message) {
  return message.length > 0 && message.length <= 2000 &&
    /\p{Script=Cyrillic}/u.test(message) &&
    !/\p{Script=Han}/u.test(message) &&
    !/[/\\\0]/.test(message) &&
    !/(?:token|secret|password|passwd|authorization|bearer\s|api[_-]key|private[_-]key|credential)/i.test(message);
}

export function operationName(path = "", method = "GET") {
  const reading = method === "GET";
  if (path.startsWith("/api/mobile/cli"))
    return reading ? "чтение сообщений сеанса" : "отправка операции сеанса";
  if (path.startsWith("/api/mobile/browser"))
    return "подключение к браузеру на компьютере";
  if (path.startsWith("/api/mobile/desktop"))
    return "подключение к Claude Desktop на компьютере";
  if (path.startsWith("/environment/resources"))
    return reading ? "чтение конфигурации ресурсов" : "применение конфигурации ресурсов";
  if (path === "/environment/initialization")
    return reading ? "чтение хода инициализации" : "сохранение состояния инициализации";
  if (path.startsWith("/environment/versions"))
    return "чтение версий компонентов среды";
  if (path.startsWith("/environment/")) return "обновление среды";
  if (path.startsWith("/input/files") || path.startsWith("/browser/files"))
    return "передача файлов";
  if (path.startsWith("/tailscale"))
    return reading ? "чтение состояния Tailscale" : "операция Tailscale";
  if (path.startsWith("/browser")) return "операция с браузером";
  if (path.startsWith("/proxy"))
    return reading ? "чтение настроек прокси" : "применение настроек прокси";
  if (path.startsWith("/safety")) return "проверка условий сети";
  if (path.startsWith("/settings/probe")) return "проверка выхода прокси";
  if (path.startsWith("/settings"))
    return reading ? "чтение настроек" : "сохранение настроек";
  if (path.startsWith("/diagnostics/export")) return "экспорт журнала диагностики";
  if (path.startsWith("/diagnostics")) return "чтение журнала диагностики";
  if (path.startsWith("/projects")) return "подключение каталога проекта";
  if (path.startsWith("/account")) return "операция с аккаунтом";
  if (path.startsWith("/claude-desktop")) return "операция с Claude Desktop";
  if (path.startsWith("/terminals")) return "подключение терминала";
  if (path === "/start") return "запуск среды";
  if (path === "/stop") return "остановка среды";
  return "подключение к рабочей среде Cage";
}

export function httpErrorMessage(path, status, text = "", contentType = "", method = "GET") {
  // Proxy HTML pages, stack traces and untranslated runtime errors are not UI
  // explanations. Preserve only short Russian explanations supplied by Cage
  // itself, so an outdated backend cannot leak Chinese output into the UI.
  const message = text.trim();
  if (
    contentType.startsWith("text/plain") &&
    safeLocalizedMessage(message) &&
    !/<(?:html|body|script|!doctype)\b/i.test(message)
  )
    return message;
  if (path === "/settings" && method === "POST" && status === 503) {
    return "Пока не удаётся подтвердить, сохранены ли настройки (HTTP 503). После восстановления соединения сверьте настройки и детали операции, затем решите, повторять ли сохранение.";
  }
  const action = operationName(path, method);
  const reasons = {
    400: "Сервер Cage не принял запрос. Проверьте введённые данные; если ошибка повторяется, экспортируйте пакет диагностики в настройках.",
    401: "Сеанс входа в рабочую среду истёк. Подключитесь к Cage заново и повторите это действие.",
    403: "Сервер отклонил доступ. Снова откройте рабочую среду из приложения Cage.",
    404: "Сервер не предоставляет требуемую функцию. Убедитесь, что приложение и сервер обновлены.",
    409: "Состояние среды изменилось или другая операция ещё не завершена. Обновите состояние и дождитесь завершения текущей операции.",
    413: "Файл или содержимое запроса превышает допустимый размер. Уменьшите файл или обработайте его частями.",
    423: "Cage заблокирован. Сначала разблокируйте аккаунт, затем повторите это действие.",
    429: "Слишком много запросов. Подождите немного и не нажимайте кнопку подряд.",
    500: "При обработке запроса на сервере произошла ошибка. Экспортируйте пакет диагностики в настройках и укажите только что выполненное действие.",
    502: "Сервер не смог подключиться к службе внутри среды. Убедитесь, что среда запущена, и проверьте состояние её компонентов.",
    503: "Сервер ещё не готов или перезапускается. Дождитесь восстановления соединения и повторите операцию.",
    504: "Истекло время ожидания ответа сервера. Проверьте нагрузку на среду и после восстановления соединения уточните, применилась ли операция.",
  };
  return `Сбой операции «${action}» (HTTP ${status}): ${reasons[status] || "не удалось получить распознаваемую причину. Экспортируйте пакет диагностики в настройках."}`;
}

export function connectionErrorMessage(path, method = "GET") {
  return `Сбой операции «${operationName(path, method)}»: соединение рабочей среды с сервером Cage прервано. Нажмите «Переподключиться»; если вы сохраняли или загружали данные, после восстановления сначала проверьте результат, затем повторите попытку.`;
}

export function nativeFailureMessage(action, message = "") {
  const generic = new Set([
    "Не удалось выполнить файловую операцию",
    "Истекло время ожидания нативной операции, повторите попытку",
    "Операция не удалась",
  ]);
  if (safeLocalizedMessage(message) && !generic.has(message.trim()))
    return message;
  const names = {
    chooseFolder: "выбор папки на этом компьютере",
    chooseUploadFiles: "выбор файлов для загрузки",
    uploadHostFiles: "загрузка файлов с этого компьютера",
    openHostPath: "открытие файла на этом компьютере",
    exportDiagnostics: "экспорт пакета диагностики",
    appUpdate: "проверка или установка обновления приложения",
    clipboardRead: "чтение буфера обмена",
    clipboardWrite: "запись в буфер обмена",
    refreshSession: "восстановление сеанса рабочей среды",
  };
  return `Сбой операции «${names[action] || "локальная операция"}»: ${
    /timeout|истекл\w*\s+время|тайм-?аут/i.test(message)
      ? "истекло время ожидания ответа локального компонента"
      : "локальный компонент не вернул распознаваемую причину"
  }. Переподключитесь к Cage; если ошибка повторится, экспортируйте пакет диагностики в настройках.`;
}
