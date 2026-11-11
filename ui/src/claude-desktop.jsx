import { InlineSelect } from "./inline-select";
import React, { useEffect, useRef, useState } from "react";
import {
  Download,
  ChevronDown,
  ChevronUp,
  Monitor,
  PanelLeftOpen,
  Power,
  RefreshCw,
} from "lucide-react";
import { BrowserUploads } from "./browser-uploads";
import { ProjectDialog } from "./project-dialog";
import { api } from "./api";
import { SafetyMessage } from "./safety-message";
import { RemoteView } from "./views";
import { useWindowVisibility } from "./window-visibility";
import "./claude-desktop.css";

const desktopZooms = [0.75, 0.9, 1, 1.1, 1.25, 1.5];

export function useDesktopZoom(automatic = false) {
  const [zoom, setZoom] = useState(() => {
    try {
      const stored = localStorage.getItem(automatic ? "cage-windows-desktop-zoom" : "cage-desktop-zoom");
      if (automatic && (stored === null || stored === "auto")) return "auto";
      const value = Number(stored);
      return desktopZooms.includes(value) ? value : automatic ? "auto" : 1;
    } catch { return automatic ? "auto" : 1; }
  });
  return [zoom, setZoom];
}

export function DesktopToolbar({ desktop, platform, zoom, setZoom, onConfirm, onStop, busy, refresh, sidebarCollapsed, onExpand, children, automatic = false }) {
  const [hidden, setHidden] = useState(() => {
    try { return localStorage.getItem("cage-desktop-toolbar-hidden") === "true"; }
    catch { return false; }
  });
  const toggleToolbar = (value) => {
    setHidden(value);
    try { localStorage.setItem("cage-desktop-toolbar-hidden", String(value)); }
    catch { /* Keep the preference for this session. */ }
  };
  if (hidden && desktop?.running) {
    return (
      <div className="desktop-toolbar-reveal">
        {sidebarCollapsed && <button className="icon-button" aria-label="Развернуть боковую панель" title="Развернуть боковую панель" onClick={onExpand}><PanelLeftOpen size={15} /></button>}
        <button className="icon-button" aria-label="Показать панель Desktop" title="Показать панель Desktop" onClick={() => toggleToolbar(false)}><ChevronDown size={15} /></button>
      </div>
    );
  }
  return (
      <header className="claude-desktop-toolbar">
        {sidebarCollapsed && (
          <button
            className="icon-button"
            aria-label="Развернуть боковую панель"
            onClick={onExpand}
          >
            <PanelLeftOpen size={17} />
          </button>
        )}
        <Monitor size={18} />
        <strong>Claude Desktop</strong>
        <span className="desktop-version">
          {desktop?.version ? `v${desktop.version}` : platform}
        </span>
        <span className="desktop-toolbar-spacer" />
        {children}
        {desktop?.running && (
          <label className="desktop-display-size">
            Размер отображения
            <InlineSelect aria-label="Размер отображения Desktop" value={zoom} onValueChange={(next) => {
              const value = next === "auto" ? "auto" : Number(next);
              setZoom(value);
              try { localStorage.setItem(automatic ? "cage-windows-desktop-zoom" : "cage-desktop-zoom", String(value)); } catch { /* Session-only preference. */ }
            }}>
              {automatic && <option value="auto">Адаптивно (рекомендуется)</option>}
              {desktopZooms.map((value) => <option key={value} value={value}>{Math.round(value * 100)}%{value === 1 ? " (по умолчанию)" : ""}</option>)}
            </InlineSelect>
          </label>
        )}
        {desktop?.running && (
          <button
            className="quiet-button"
            disabled={busy}
            onClick={async () => {
              if (
                await onConfirm({
                  title: "Закрыть Claude Desktop?",
                  body: "Сначала сохраните работу в приложении. Браузер и терминалы Cage продолжат работу.",
                  confirm: "Закрыть приложение",
                })
              )
                onStop();
            }}
          >
            <Power size={15} />
            Закрыть приложение
          </button>
        )}
        <button
          className="icon-button"
          aria-label="Обновить состояние Claude Desktop"
          disabled={busy}
          onClick={refresh}
        >
          <RefreshCw size={15} />
        </button>
        {desktop?.running && <button className="icon-button" aria-label="Скрыть панель Desktop" title="Скрыть панель Desktop" onClick={() => toggleToolbar(true)}><ChevronUp size={15} /></button>}
      </header>
  );
}

export function ClaudeDesktop({
  uploads = [],
  status,
  onProjectOpened,
  visible,
  remoteRef,
  onStatus,
  onFallback,
  onConfirm,
  onDetails,
  onExpand,
  sidebarCollapsed,
}) {
  const [closedChooser, setClosedChooser] = useState("");
  const directoryRequest = uploads.find((item) => item.directory && item.id !== closedChooser);
  const automatic = status.guest_system?.startsWith("windows");
  const [zoom, setZoom] = useDesktopZoom(automatic);
  const windowVisible = useWindowVisibility();
  const screenVisible = visible && windowVisible;
  const [desktop, setDesktop] = useState(null);
  const [error, setError] = useState("");
  const [statusError, setStatusError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [jobID, setJobID] = useState("");
  const opened = useRef(false);
  const statusRequest = useRef(null);
  const statusRevision = useRef(0);
  const ownJob = status.job?.kind?.startsWith("claude-desktop-");
  const busy = submitting || Boolean(status.job?.running) || Boolean(jobID);
  const refresh = async (valid = () => true) => {
    const revision = statusRevision.current;
    const request = statusRequest.current ??= api("/claude-desktop");
    try {
      const value = await request;
      if (!valid() || revision !== statusRevision.current) return null;
      setDesktop(value);
      setStatusError("");
      return value;
    } catch (e) {
      if (valid() && revision === statusRevision.current) setStatusError(e.message);
      return null;
    } finally {
      if (statusRequest.current === request) statusRequest.current = null;
    }
  };
  const run = async (action) => {
    statusRevision.current++;
    statusRequest.current = null;
    setSubmitting(true);
    setError("");
    try {
      const job = await api(`/claude-desktop/${action}`, {});
      setJobID(job.id);
    } catch (e) {
      setError(e.message);
    } finally {
      setSubmitting(false);
    }
  };
  useEffect(() => {
    if (!screenVisible || !status.vm_running || status.job?.running) return;
    let disposed = false;
    let timer;
    const poll = async () => {
      const value = await refresh(() => !disposed);
      if (disposed) return;
      if (value && !opened.current) {
        opened.current = true;
        if (value.installed && !value.running && !value.failed && !jobID)
          await run("start");
      }
      if (!disposed) timer = setTimeout(poll, 5000);
    };
    poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [screenVisible, status.vm_running, status.job?.running]);
  useEffect(() => {
    if (!jobID || status.job?.id !== jobID || status.job.running) return;
    setJobID("");
    if (status.job.error) {
      setError(status.job.error);
      return;
    }
    if (status.job.kind === "claude-desktop-install") run("start");
    else refresh();
  }, [status.job]);
  return (
    <section className="claude-desktop-view" aria-label="Claude Desktop">
      <BrowserUploads requests={uploads} onStatus={onStatus} />
      {directoryRequest && <ProjectDialog
        key={directoryRequest.id}
        status={status}
        activate={false}
        onClose={() => {
          setClosedChooser(directoryRequest.id);
          void api("/input/files/cancel", { target: "desktop", id: directoryRequest.id }).catch((e) => onStatus(e.message));
        }}
        onOpened={async (workspace) => {
          await api("/input/files/directory", { target: "desktop", id: directoryRequest.id, workspace });
          setClosedChooser(directoryRequest.id);
          await onProjectOpened(workspace);
        }}
      />}
      <DesktopToolbar desktop={desktop} platform={status.guest_system === "windows-11" ? "Windows" : "Linux"} zoom={zoom} setZoom={setZoom} automatic={automatic}
        onConfirm={onConfirm} onStop={() => run("stop")} busy={busy} refresh={() => refresh()} sidebarCollapsed={sidebarCollapsed} onExpand={onExpand} />
      {(error || statusError || desktop?.failed) && (
        <div className="connection-banner" role="alert">
          <SafetyMessage message={error || statusError || (desktop?.failure_reason === "oom-kill"
            ? "Недостаточно памяти среды: Claude Desktop был закрыт системой. Проверьте вычислительные ресурсы в настройках и откройте приложение заново."
            : "Не удалось запустить Claude Desktop. Повторите запуск или восстановите установку.")} />
          <button onClick={onDetails}>Подробности</button>
        </div>
      )}
      {desktop?.running && desktop.managed === false && !desktop.native_user_session && <div className="connection-banner" role="status">Приложение ещё не подключено к разблокировке аккаунта Cage. Сохраните работу, закройте приложение и откройте его заново.</div>}
      {busy && ownJob && (
        <div className="desktop-progress" role="status">
          <RefreshCw size={16} className="spin" />
          {status.job.message}
          <button className="text-button" onClick={onDetails}>
            Посмотреть ход выполнения
          </button>
        </div>
      )}
      <div className="desktop-screen">
        {desktop?.running && status.vm_running ? (
          <RemoteView
            ref={remoteRef}
            desktop
            zoom={zoom}
            visible={visible}
            keyboard={status.keyboard}
            guestPlatform={status.guest_system?.startsWith("windows") ? "windows" : status.guest_system}
            onStatus={onStatus}
            onFallback={onFallback}
          />
        ) : (
          <div className="desktop-empty">
            <Monitor size={36} />
            <h2>
              {desktop?.installed
                ? "Claude Desktop"
                : "Используйте Claude Desktop в Cage"}
            </h2>
            <p>
              Chat и Code используют одно официальное приложение. Установите его,
              войдите и работайте в Cage; файлы проекта берутся из открытой папки.
            </p>
            {!desktop?.installed && (
              <p>
                При первом использовании приложение загружается из официального источника Anthropic и не увеличивает размер установочного пакета Cage по умолчанию.
              </p>
            )}
            <div className="desktop-actions">
              {desktop && (
                <button
                  className="primary"
                  disabled={busy || !status.vm_running}
                  onClick={() => run(desktop.installed ? "start" : "install")}
                >
                  {desktop.installed ? (
                    <Monitor size={16} />
                  ) : (
                    <Download size={16} />
                  )}
                  {desktop.installed ? "Открыть Claude Desktop" : "Скачать и установить"}
                </button>
              )}
              {desktop?.installed && (
                <button
                  className="quiet-button"
                  disabled={busy}
                  onClick={() => run("install")}
                >
                  Обновить / восстановить установку
                </button>
              )}
              {!desktop && (
                <button
                  className="quiet-button"
                  disabled={busy}
                  onClick={refresh}
                >
                  Прочитать состояние заново
                </button>
              )}
            </div>
            <p className="desktop-note">
              После закрытия приложения ресурсы графического сеанса освобождаются,
              а состояние входа сохраняется в среде Cage. Функция Cowork, требующая
              отдельной виртуальной машины, пока не поддерживается.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
