import React, { useEffect, useRef, useState } from "react";
import { api, writeClipboard } from "./api";
import { QrCode } from "lucide-react";

export function MobilePairSettings({ relay, savedRelay, onChange, onConfirm }) {
  const [custom, setCustom] = useState(Boolean(relay));
  const [token, setToken] = useState("");
  const [code, setCode] = useState(null);
  const [paired, setPaired] = useState(false);
  const [device, setDevice] = useState(null);
  const [power, setPower] = useState(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const statusRevision = useRef(0);
  useEffect(() => {
    let active = true;
    const check = async () => {
      const revision = statusRevision.current;
      try {
        const state = await api("/mobile-pair");
        if (!active || revision !== statusRevision.current) return;
        setPaired(state.paired);
        setDevice(state.paired ? state.device ?? null : null);
        setPower(state.paired ? state.keep_awake ?? null : null);
        if (state.paired) setCode(null);
        else if (code && Date.now() >= Date.parse(code.expires)) {
          setCode(null);
          setNotice("Срок действия QR-кода истёк. Создайте новый.");
        } else if (code && state.status.includes("не завершено")) {
          setCode(null);
          setNotice(state.status);
        }
      } catch (e) {
        if (active && revision === statusRevision.current) setNotice(e.message);
      }
    };
    check();
    const timer = setInterval(check, code ? 1500 : 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [code]);
  async function generate() {
    setBusy(true);
    setNotice("");
    setCode(null);
    try {
      setCode(
        await api("/mobile-pair", {
          relay: savedRelay,
          admin: custom ? token : "",
        }),
      );
    } catch (e) {
      setNotice(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (
      !(await onConfirm({
        title: "Удалить сопряжённый телефон?",
        body: device?.model
          ? `После удаления ${device.model} этому телефону потребуется заново отсканировать код для доступа к рабочей среде.`
          : "Этому телефону потребуется заново отсканировать код для доступа к рабочей среде.",
        confirm: "Удалить телефон",
      }))
    )
      return;
    setBusy(true);
    try {
      await api("/mobile-pair", {}, "DELETE");
      statusRevision.current++;
      setPaired(false);
      setDevice(null);
      setPower(null);
      setNotice("");
    } catch (e) {
      setNotice(e.message);
    } finally {
      setBusy(false);
    }
  }
  // Center the QR and its actions. Relay controls use the same theme below.
  return (
    <section className="remote-link-settings" aria-label="Удалённое подключение">
      <div className="section-title">
        <h3>Удалённое подключение</h3>
        <p>
          После сопряжения телефон может открывать удалённый браузер и Claude Desktop, продолжать сеансы Claude Code и обрабатывать подтверждения инструментов.
        </p>
      </div>
      <section className="remote-pair-card" aria-label="Сопряжение телефона">
        <h4>{paired ? "Телефон сопряжён" : "Подключите телефон к Cage"}</h4>
        {paired && (
          <p className="remote-pair-device" aria-label="Сопряжённый телефон">
            {device?.model ? (
              <>
                <strong>{device.model}</strong>
                <span>{device.platform === "ios" ? "iOS" : "Android"}</span>
              </>
            ) : (
              <span>Модель пока неизвестна. Обновите Cage на телефоне и подключитесь заново.</span>
            )}
          </p>
        )}
        {paired ? (
          <p role="status">Нажмите «Подключиться заново» на телефоне, чтобы открыть рабочую среду.</p>
        ) : (
          <p className="remote-pair-instruction">
            Откройте Cage на телефоне, выберите «Подключиться к компьютеру» и отсканируйте QR-код через «Подключение по QR-коду» либо выберите «Использовать код сопряжения» и вставьте код, скопированный на компьютере.
          </p>
        )}
        {paired && power?.active && <p className="note">Удалённый режим ожидания запросил у хоста оставаться включённым; экран может нормально гаснуть. После удаления сопряжения или остановки фоновой службы восстанавливается прежняя политика сна.</p>}
        {paired && power?.error && <p role="alert">Защита хоста от сна не действует: {power.error}</p>}
        {code && (
          <div className="remote-pair-code">
            <img
              src={code.image}
              alt="QR-код для сопряжения телефона"
              width="320"
              height="320"
            />
            <p className="field-help">QR-код действует около двух минут; после истечения его можно обновить.</p>
          </div>
        )}
        {!code && !paired && (
          <div className="remote-pair-placeholder" aria-hidden="true">
            <QrCode size={64} strokeWidth={1.25} />
          </div>
        )}
        <div className="remote-pair-actions">
          {paired ? (
            <button type="button" disabled={busy} onClick={remove}>
              Удалить сопряжённый телефон
            </button>
          ) : (
            <button
              type="button"
              className="primary"
              disabled={busy || relay !== savedRelay || (custom && !relay)}
              onClick={generate}
            >
              <QrCode size={18} />
              {busy ? "Создание…" : code ? "Обновить QR-код" : "Создать QR-код для сопряжения"}
            </button>
          )}
          {code && (
            <button
              type="button"
              onClick={async () => {
                try {
                  await writeClipboard(code.manual);
                  setNotice("Одноразовый код сопряжения скопирован; его можно вставить на телефоне.");
                } catch {
                  setNotice("Не удалось скопировать. Используйте QR-код.");
                }
              }}
            >
              Скопировать код сопряжения
            </button>
          )}
        </div>
        {!paired && (
          <p className="remote-pair-privacy">
            Передавайте QR-код или код сопряжения только тому телефону, которому доверяете.
          </p>
        )}
        {notice && <p role="status">{notice}</p>}
      </section>
      <section className="remote-relay-settings" aria-label="Настройки ретранслятора">
        <div className="remote-relay-row">
          <div>
            <h4>Служба ретрансляции</h4>
            <p className="field-help">
              Соединяет телефон и компьютер через ретранслятор; можно использовать официальную или собственную службу.
            </p>
          </div>
          <div
            className="remote-relay-options"
            role="group"
            aria-label="Служба ретрансляции"
          >
            <button
              type="button"
              aria-pressed={!custom}
              onClick={() => {
                setCustom(false);
                setToken("");
                onChange("");
                setCode(null);
              }}
            >
              Официальный ретранслятор Cage
            </button>
            <button
              type="button"
              aria-pressed={custom}
              onClick={() => setCustom(true)}
            >
              Собственный ретранслятор
            </button>
          </div>
        </div>
        {custom && (
          <>
            <label>
              Адрес собственного ретранслятора
              <input
                value={relay}
                placeholder="https://relay.example.com"
                onChange={(e) => {
                  onChange(e.target.value);
                  setToken("");
                  setCode(null);
                }}
              />
            </label>
            <label>
              Токен управления (необязательно)
              <input
                type="password"
                autoComplete="off"
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
            </label>
          </>
        )}
        {relay !== savedRelay && (
          <small>После сохранения настроек можно создать код сопряжения через новый ретранслятор.</small>
        )}
      </section>
    </section>
  );
}
