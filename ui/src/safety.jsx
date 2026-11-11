import React, { useState } from "react";
import {
  ShieldCheck,
  ShieldAlert,
  Check,
  CircleHelp,
  X,
  LoaderCircle,
  ArrowUpRight,
  Copy,
  Settings,
  ChevronDown,
} from "lucide-react";
import { api, writeClipboard } from "./api";
import { Modal } from "./views";
import { networkState, reportForSharing } from "./safety-state.mjs";

const diagnostics = [
  {
    name: "Качество IP",
    source: "ip.net.coffee",
    url: "https://ip.net.coffee/claude/",
    description:
      "Свойства IP, ASN, репутация и сетевая диагностика.",
  },
  {
    name: "Информация о браузере",
    source: "fuck-claude.com",
    url: "https://fuck-claude.com/",
    description:
      "Оценка сообществом сигналов браузера: часового пояса, языка, шрифтов и других.",
  },
];

export async function bindDetectedMacOSExit(ip, onConfirm) {
  if (!(await onConfirm({ title: "Привязать фиксированный выход?", body: `Терминал гостевой системы, браузер и прокси показали ${ip}. После сохранения перезапустите гостевую систему и повторите проверку.`, confirm: "Привязать выход" }))) return null;
  return api("/macos/exit-policy", { ip });
}

export function SafetyPanel({
  status,
  onClose,
  onSettings,
  onOpenPage,
  onConfirm,
}) {
  const [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const network = networkState(status),
    safety = status.safety || {},
    report = safety.report;
  const busy = Boolean(status.job?.running),
    online = network.mode === "open";
  const passed =
    report?.checks?.filter((c) => c.critical && c.state === "passed").length ||
    0;
  const total = report?.checks?.filter((c) => c.critical).length || 0;
  const run = async () => {
    setError("");
    if (
      status.vm_running &&
      !safety.gate &&
      !(await onConfirm({
        title: "Перезапустить среду и загрузить компонент проверки?",
        body: "Текущий сеанс терминала завершится. Сохраните файлы; входы в браузере и файлы проектов сохранятся.",
        confirm: "Перезапустить и проверить",
      }))
    )
      return;
    try {
      await api(status.ready && safety.gate ? "/safety/check" : "/start", {});
    } catch (e) {
      setError(e.message);
    }
  };
  const pause = async () => {
    setError("");
    try {
      await api("/safety/close", {});
    } catch (e) {
      setError(e.message);
    }
  };
  const copy = async () => {
    try {
      await writeClipboard(JSON.stringify(reportForSharing(report), null, 2));
      setNotice(
        "Отчёт скопирован: без учётных данных прокси, IP-адресов и локальных путей",
      );
    } catch {
      setError(
        "Не удалось записать в локальный буфер обмена. Проверьте разрешение браузера на доступ к буферу обмена.",
      );
    }
  };
  const open = async (url) => {
    if (await onOpenPage(url)) onClose();
  };
  return (
    <Modal
      title="Сеть и проверки изоляции"
      wide
      onClose={onClose}
      footer={
        <>
          <span className="save-note">
            {busy
              ? status.job.message
              : "При закрытой внешней сети офлайн-терминал и файлы остаются доступны"}
          </span>
          {(online || network.mode === "checking") && (
            <button onClick={pause}>
              {network.mode === "checking"
                ? "Отменить проверку и закрыть внешнюю сеть"
                : "Приостановить внешнюю сеть"}
            </button>
          )}
          <button className="primary" disabled={busy} onClick={run}>
            {busy ? (
              <LoaderCircle size={15} className="spin" />
            ) : (
              <ShieldCheck size={15} />
            )}
            {busy
              ? "Проверка выполняется"
              : online
                ? "Приостановить внешнюю сеть и перепроверить"
                : status.ready && safety.gate
                  ? "Проверить снова"
                  : status.vm_running
                    ? "Перезапустить и проверить"
                    : "Запустить и проверить"}
          </button>
        </>
      }
    >
      <div className="modal-body safety-body">
        {safety.macos_exit_candidate?.ip && <button disabled={busy} onClick={async () => {
          try { if (await bindDetectedMacOSExit(safety.macos_exit_candidate.ip, onConfirm)) setNotice("Фиксированный выход сохранён. После завершения сохранения перезапустите гостевую систему и повторите проверку."); }
          catch (e) { setError(e.message); }
        }}>Привязать обнаруженный фиксированный выход {safety.macos_exit_candidate.ip}</button>}
        <div className={`safety-summary ${network.mode}`}>
          {online ? (
            <ShieldCheck size={27} />
          ) : network.mode === "checking" ? (
            <LoaderCircle size={27} className="spin" />
          ) : (
            <ShieldAlert size={27} />
          )}
          <div>
            <h3>{network.label}</h3>
            <p>
              {busy
                ? status.job.message
                : online
                  ? status.network_error || "Ключевые проверки пройдены; сервер продолжает сверять правила выхода и конфигурацию среды."
                  : status.network_error || safety.error ||
                    safety.gate?.reason ||
                    "Подключение к внешним сайтам разрешается только после ключевых проверок."}
            </p>
          </div>
          <button className="text-button" onClick={() => onSettings("network")}>
            <Settings size={15} />
            Правила выхода
          </button>
        </div>
        {(error || notice) && (
          <div
            role="status"
            className={error ? "error-message" : "inline-info"}
          >
            {error || notice}
          </div>
        )}
        <div className="safety-section-heading">
          <h4>Ключевые проверки</h4>
          <span>{total ? `${passed} / ${total} пройдено` : "Записей о проверках пока нет"}</span>
          {report && (
            <button className="text-button" onClick={copy}>
              <Copy size={14} />
              Копировать отчёт
            </button>
          )}
        </div>
        {report ? (
          <>
            <p className="safety-timestamp">
              Проверено {new Date(report.created_at).toLocaleString("ru-RU")} ·{" "}
              {online ? "Текущий запущенный экземпляр" : "Отчёт не означает, что доступ уже разрешён"}
            </p>
            <div className="safety-checks">
              {report.checks
                .filter((check) => check.critical)
                .map((check) => {
                  const Icon =
                    check.state === "passed"
                      ? Check
                      : check.state === "failed"
                        ? X
                        : CircleHelp;
                  return (
                    <details
                      className={`safety-check ${check.state}`}
                      key={check.id}
                    >
                      <summary>
                        <Icon size={16} />
                        <strong>{check.title}</strong>
                        <span>
                          {check.state === "passed"
                            ? "Пройдено"
                            : check.state === "failed"
                              ? "Не пройдено"
                              : busy && check.checked_at === report.created_at
                                ? "Ожидает проверки"
                                : "Неизвестно"}
                        </span>
                        <ChevronDown size={14} />
                      </summary>
                      <div>
                        <p>{check.evidence}</p>
                        {check.state !== "passed" && check.remedy && (
                          <p className="check-remedy">{check.remedy}</p>
                        )}
                      </div>
                    </details>
                  );
                })}
            </div>
          </>
        ) : (
          <p className="safety-empty">
            Проверки охватывают правила исходящих соединений, отказ прокси, DNS, общие каталоги, интерфейс управления хостом, а также фактическую конфигурацию системы и браузера. Если ключевой пункт не пройден или его состояние неизвестно, внешняя сеть остаётся закрытой.
          </p>
        )}
        {report?.checks?.some((check) => !check.critical) && (
          <div className="safety-advisories">
            {report.checks
              .filter((check) => !check.critical)
              .map((check) => (
                <p key={check.id}>
                  <CircleHelp size={15} />
                  <span>
                    <strong>{check.title}:</strong>
                    {check.evidence}
                  </span>
                </p>
              ))}
          </div>
        )}
        <div className="safety-section-heading">
          <h4>Дополнительные проверки сообщества</h4>
          <span>Справочные пункты, не влияют на допуск к сети</span>
        </div>
        <div className="diagnostic-sites">
          {diagnostics.map((site) => (
            <div key={site.url}>
              <strong>{site.name}</strong>
              <small>{site.source}</small>
              <p>{site.description}</p>
              <button disabled={!online || busy} onClick={() => open(site.url)}>
                Открыть в Cage
                <ArrowUpRight size={14} />
              </button>
            </div>
          ))}
        </div>
        <p className="field-help">
          Сторонние сайты открываются только после нажатия. Сайт получит IP-адрес
          выхода Cage и сможет прочитать информацию браузера, доступную на этой
          странице. Оценки носят справочный характер.
        </p>
        <details className="safety-scope">
          <summary>Объём и источники проверки</summary>
          <p>
            Текущая версия проверяет выход по IPv4; публичный IPv6 и UDP в гостевой
            системе отключены. Мониторинг выхода выполняется примерно каждые 30
            секунд; местоположение берётся из базы IP-адресов, поэтому определение
            города может быть неточным. Разделение трафика самим прокси по целям
            по-прежнему нужно ограничивать на стороне прокси.
          </p>
          <p>
            Отчёт содержит политики выполнения и выборочные доказательства; он не
            заменяет полный аудит виртуализации и не подтверждает допуск аккаунта
            к платформе или прогноз блокировки. Полная проверка действует 24 часа;
            после потери связи со службой управления разрешение на сеть
            сохраняется максимум 90 секунд.
          </p>
          <div className="safety-sources">
            <span>Методические источники</span>
            <button
              className="text-button"
              disabled={!online}
              onClick={() =>
                open("https://github.com/YOURSJEYO/claude-switcher")
              }
            >
              claude-switcher
              <ArrowUpRight size={12} />
            </button>
            <button
              className="text-button"
              disabled={!online}
              onClick={() =>
                open("https://github.com/DUNHKpcc/Claude-Guardian")
              }
            >
              Claude-Guardian
              <ArrowUpRight size={12} />
            </button>
          </div>
        </details>
      </div>
    </Modal>
  );
}
