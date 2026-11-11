import React from "react";
import { MacOSLogin } from "./macos-login";

export function ProjectRecovery({ recovery, disabled, onRetry, onSettings, onSessionClosed }) {
  return <div className="project-recovery-actions">
    {recovery === "guest-login" && <MacOSLogin disabled={disabled} onSessionClosed={onSessionClosed} />}
    {recovery === "filesystem-permission" && <MacOSLogin disabled={disabled} maintenance="projects"
      onSessionClosed={onSessionClosed} onSettings={onSettings} />}
    {["environment-update", "environment-restart"].includes(recovery) && onSettings &&
      <button type="button" disabled={disabled} onClick={onSettings}>{recovery === "environment-update" ? "Посмотреть компоненты среды" : "Открыть настройки среды"}</button>}
    {recovery === "project-directory" && onSettings &&
      <button type="button" disabled={disabled} onClick={onSettings}>Посмотреть диагностику</button>}
    <button type="button" disabled={disabled} onClick={onRetry}>{recovery === "project-approval" ? "Завершить авторизацию проекта" : "Переподключить проект"}</button>
  </div>;
}
