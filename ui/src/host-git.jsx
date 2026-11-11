import React, { useEffect, useRef, useState } from "react";
import { LoaderCircle, ShieldCheck } from "lucide-react";
import { api } from "./api";
import { isRemoteClient } from "./client-context.mjs";
import { Modal } from "./views";

export function HostGitPreparation({ onClose, onReady }) {
  const remote = isRemoteClient();
  const onMachine = remote ? "на облачном хосте" : "на этом компьютере";
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const alive = useRef(true);
  const check = async (enable = false) => {
    setBusy(true);
    setError("");
    try {
      const next = await api(
        "/host/git",
        enable ? { confirm: true } : undefined,
      );
      if (!alive.current) return;
      setState(next);
      if (next.ready) onReady();
    } catch (e) {
      if (alive.current) setError(e.message);
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  useEffect(() => {
    alive.current = true;
    check();
    return () => {
      alive.current = false;
    };
  }, []);
  // The welcome page shows progress; open a dialog only when input is needed.
  if (!state && !error) return null;
  return (
    <Modal
      title={`Защита Git перед запуском ${onMachine}`}
      onClose={busy ? undefined : onClose}
      footer={
        <>
          <button disabled={busy} onClick={onClose}>
            Пока не запускать
          </button>
          <button disabled={busy} onClick={() => check()}>
            Проверить снова
          </button>
          {state?.can_enable && (
            <button
              className="primary"
              disabled={busy}
              onClick={() => check(true)}
            >
              {busy ? (
                <LoaderCircle size={16} className="spin" />
              ) : (
                <ShieldCheck size={16} />
              )}
              Включить защиту и продолжить
            </button>
          )}
        </>
      }
    >
      <div className="modal-body host-git-preparation">
        {busy && !state ? (
          <p role="status">Проверяем Git {onMachine}, настройки пока не изменены…</p>
        ) : (
          <>
            <p>{state?.message}</p>
            {state?.can_enable && (
              <>
                <p>
                  Claude может изменять общие файлы. После включения защиты Git {onMachine}
                  {" "}будет игнорировать bare-репозитории, которые вы явно не
                  указали, чтобы конфигурация в общем каталоге не выполняла команды
                  {" "}{onMachine}.
                </p>
                <p>
                  Нажатие «Включить защиту и продолжить» изменит одну глобальную
                  настройку Git текущего пользователя {onMachine}:
                </p>
                <pre>git config --global safe.bareRepository explicit</pre>
                <p>
                  Обычные проекты <code>.git</code>, коммиты и удалённые адреса не
                  изменятся. Для bare-репозиториев путь нужно явно указывать
                  через <code>--git-dir</code>. Настройка повлияет на другие
                  инструменты Git {onMachine}.
                </p>
              </>
            )}
            {!state?.can_enable && !error && (
              <p>После установки или исправления нажмите «Проверить снова»; прокси настраивать заново не нужно.</p>
            )}
          </>
        )}
        {error && (
          <p className="start-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
