import React, {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import {
  Camera,
  Check,
  ChevronDown,
  Eye,
  EyeOff,
  Fingerprint,
  LockKeyhole,
  LogOut,
  Settings,
} from "lucide-react";
import { api, native, nativeAvailable } from "./api";
import { getClientContext, isRemoteClient } from "./client-context.mjs";
import logo from "./logo.png";
import "./account.css";

const AccountContext = createContext(null);
export const useAccount = () => useContext(AccountContext);
const localDesktop = () => getClientContext().desktop_gateway && !isRemoteClient();
const trustedLogin = (action, password) => api("/client/trusted-login", {
  action, password, connection_id: getClientContext().connection_id,
});
const credentialPresent = (status) => status === "available" || status === "authentication_required";

export function AccountProvider({ children }) {
  const [account, setAccount] = useState(null);
  const [error, setError] = useState("");
  const [deviceCheck, setDeviceCheck] = useState(null);
  const deviceKey = JSON.stringify([account?.device_binding, account?.devices?.automatic, account?.devices?.biometric]);
  const deviceSupport = deviceCheck?.key === deviceKey ? deviceCheck.value : null;
  const [deviceNotice, setDeviceNotice] = useState("");
  const sequence = useRef(0);
  const refresh = async () => {
    const current = ++sequence.current;
    try {
      const value = await api("/account");
      if (sequence.current === current) {
        setAccount(value);
        setError("");
      }
      return value;
    } catch (e) {
      if (sequence.current === current) setError(e.message);
      throw e;
    }
  };
  const act = async (action, input = {}) => {
    const current = ++sequence.current;
    const value = await api(`/account/${action}`, input);
    if (action !== "logout" && sequence.current === current) setAccount(value);
    return value;
  };
  useEffect(() => {
    if (!account || deviceSupport !== null) return;
    if (!nativeAvailable()) { setDeviceCheck({ key: deviceKey, value: { supported: false } }); return; }
    let live = true;
    native("accountDevice", { operation: "status" })
      .then((value) => { if (live) setDeviceCheck({ key: deviceKey, value: value || { supported: false } }); })
      .catch(() => { if (live) setDeviceCheck({ key: deviceKey, value: { supported: false } }); });
    return () => { live = false; };
  }, [Boolean(account), deviceKey, deviceSupport]);
  const deviceAction = async (operation, kind) => {
    if (!deviceSupport?.device_status) throw new Error("Средство запуска приложения устарело. Переустановите полное приложение Cage, затем настройте быстрый вход.");
    try {
      await native("accountDevice", { operation, kind });
    } finally {
      // Failed enrollment may have revoked its server record. Reconcile both
      // sides after failures too, including a credential removed while open.
      await refresh();
      setDeviceCheck(null);
    }
  };
  useEffect(() => {
    let live = true,
      timer;
    const poll = async () => {
      try {
        await refresh();
      } catch {
        /* Keep the last state while disconnected. */
      }
      if (live) timer = setTimeout(poll, document.hidden ? 10000 : 2500);
    };
    const start = async () => {
      try {
        if (location.hash) {
          await api("/session", { token: location.hash.slice(1) });
          history.replaceState(null, "", location.pathname);
        }
        window.dispatchEvent(new Event("cage-session-ready"));
        if (live) await poll();
      } catch (e) {
        if (live) setError(e.message);
      }
    };
    const locked = () => {
      // A 423 can follow a controller restart or directory change. Do not
      // auto-unlock using the previous account's cached Keychain status.
      setDeviceCheck(null);
      setAccount((previous) =>
        previous ? { ...previous, unlocked: false } : previous,
      );
      refresh().catch(() => {});
    };
    start();
    window.addEventListener("cage-account-locked", locked);
    return () => {
      live = false;
      sequence.current++;
      clearTimeout(timer);
      window.removeEventListener("cage-account-locked", locked);
    };
  }, []);
  return (
    <AccountContext.Provider value={{ account, error, refresh, act, deviceSupport, deviceAction, deviceNotice, setDeviceNotice, recheckDevices: () => setDeviceCheck(null) }}>
      {children}
    </AccountContext.Provider>
  );
}

export function AccountAvatar({ account, large = false }) {
  const initial = Array.from(
    account?.username?.trim() || "C",
  )[0].toLocaleUpperCase();
  return (
    <span
      className={`account-avatar ${large ? "large" : ""}`}
      aria-hidden="true"
    >
      {account?.avatar ? <img src={account.avatar} alt="" /> : initial}
    </span>
  );
}

export function MacOSAccountGate({ children }) {
  const { account, act } = useAccount();
  const [name, setName] = useState(account?.macos_guest_user || account?.username || "");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!account?.macos_account_host || account.macos_credentials_ready) return children;
  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    if (password !== confirmation) { setError("Пароли не совпадают"); return; }
    setBusy(true); setError("");
    try { await act("prepare-macos", { username:name, password, confirm_password:confirmation }); setPassword(""); setConfirmation(""); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  return <main className="account-gate"><div className="account-brand"><img src={logo} alt="" />Cage</div><section className="account-entry">
    <h1>Настройте общие учётные данные Cage и macOS</h1>
    <p className="account-entry-intro">{account.trusted_local ? "Сначала задайте имя пользователя и пароль Cage, затем продолжите установку гостевой системы. Существующий аккаунт, файлы и состояние входа сохранятся." : "Введите текущий пароль Cage, чтобы использовать его для гостевой macOS. У существующей гостевой системы сохранятся имя пользователя и домашний каталог."}</p>
    <form onSubmit={submit}><fieldset disabled={busy}>
      <label className="account-field">Имя пользователя<input required value={name} onChange={event => setName(event.target.value)} maxLength={31} pattern="[a-z][a-z0-9_]{0,30}" readOnly={Boolean(account.macos_guest_user)} autoComplete="username" /></label>
      <p className="field-help">Начинается со строчной буквы; 1–31 строчная буква, цифра или подчёркивание. Пароль — 8–256 символов, которые можно ввести с английской клавиатуры.</p>
      <PasswordField label={account.trusted_local ? "Задать пароль" : "Текущий пароль Cage"} value={password} onChange={setPassword} autoComplete={account.trusted_local ? "new-password" : "current-password"} />
      <PasswordField label="Подтвердите пароль" value={confirmation} onChange={setConfirmation} autoComplete={account.trusted_local ? "new-password" : "current-password"} />
      {error && <p role="alert" className="account-error">{error}</p>}
      <button className="primary account-submit" disabled={busy}>{busy ? "Сохранение…" : "Сохранить учётные данные и продолжить"}</button>
    </fieldset></form>
  </section></main>;
}

function PasswordField({
  label,
  value,
  onChange,
  autoComplete = "current-password",
}) {
  const [visible, setVisible] = useState(false);
  const id = useId();
  return (
    <div className="account-field">
      <label htmlFor={id}>{label}</label>
      <span className="password-input">
        <input
          id={id}
          type={visible ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete={autoComplete}
          required
          maxLength={1024}
        />
        <button
          type="button"
          className="icon-button"
          aria-label={`${visible ? "Скрыть" : "Показать"}: ${label}`}
          onClick={() => setVisible(!visible)}
        >
          {visible ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
      </span>
    </div>
  );
}

export function AccountGate({ children }) {
  const { account, error: connectionError, refresh, act, deviceSupport, deviceAction, setDeviceNotice } = useAccount();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [rememberLogin, setRememberLogin] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const automaticAttempt = useRef("");
  const gateAcknowledged = useRef(false);
  const trustedAttempt = useRef(false);
  const enterTrusted = async (action) => {
    setBusy(true); setError("");
    try { await trustedLogin(action); await refresh(); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };
  useEffect(() => {
    if (account?.unlocked) { trustedAttempt.current = false; setRememberLogin(null); return; }
    if (!account || !localDesktop() || trustedAttempt.current || account.require_authentication) return;
    if (!(account.trusted_local || account.trusted_login)) return;
    trustedAttempt.current = true;
    void enterTrusted("resume");
  }, [account?.unlocked, account?.exists, account?.guest_system, account?.trusted_local, account?.trusted_login, account?.require_authentication]);
  useEffect(() => {
    if (!account || account.unlocked || connectionError || gateAcknowledged.current || !nativeAvailable()) return;
    // A working lock/setup screen is a valid upgraded UI. Waiting for the
    // user's password would incorrectly leave the native update unconfirmed.
    native("workbenchReady").then((accepted) => {
      if (accepted === true) gateAcknowledged.current = true;
    }).catch(() => {});
  }, [Boolean(account), account?.unlocked, connectionError]);
  useEffect(() => {
    const id = account?.devices?.automatic;
    if ((account?.trusted_login && localDesktop()) || !id || account.unlocked || account.require_authentication || !deviceSupport?.supported || deviceSupport.device_status?.automatic !== "available" || automaticAttempt.current === id) return;
    automaticAttempt.current = id;
    setBusy(true);
    deviceAction("unlock", "automatic").catch((e) => setError(e.message)).finally(() => setBusy(false));
  }, [account?.unlocked, account?.devices?.automatic, account?.require_authentication, deviceSupport]);
  if (account?.unlocked) return children;
  const creating = account && !account.exists;
  const rememberThisDevice = rememberLogin ?? Boolean(creating || account?.trusted_login || account?.devices?.automatic);
  const submit = async (event) => {
    event.preventDefault();
    if (busy) return;
    if (creating && password !== confirmation) {
      setError("Пароли не совпадают");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await act(
        creating ? "create" : "unlock",
        creating
          ? { username, password, confirm_password: confirmation }
          : { password },
      );
      if (localDesktop()) {
        try {
          await trustedLogin(rememberThisDevice ? "enable" : "disable", password);
          await refresh();
        } catch (e) {
          setDeviceNotice(`Вход выполнен, но ${rememberThisDevice ? "не удалось включить «Запомнить меня»" : "не удалось отключить «Запомнить меня»"}: ${e.message}. Повторите в разделе «Настройки → Аккаунт».`);
        }
      } else if (creating && rememberThisDevice && deviceSupport?.supported && deviceSupport.device_status) {
        try { await deviceAction("enable", "automatic"); }
        catch (e) { setDeviceNotice(`Аккаунт создан, но включить запоминание входа не удалось: ${e.message}. Повторите в разделе «Настройки → Аккаунт».`); }
      }
      setPassword("");
      setConfirmation("");
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="account-gate">
      <div className="account-brand">
        <img src={logo} alt="" />
        Cage
      </div>
      <section
        className="account-entry"
        aria-label={creating ? isRemoteClient() ? "Создать облачный аккаунт" : "Создать локальный аккаунт" : "Разблокировать Cage"}
      >
        {creating ? (
          <img className="account-welcome-logo" src={logo} alt="" />
        ) : (
          account && <AccountAvatar account={account} large />
        )}
        <h1>
          {creating
            ? "Регистрация аккаунта Cage"
            : account
              ? `С возвращением, ${account.username}`
              : "Подключение к Cage"}
        </h1>
        <p className="account-entry-intro">
          {creating
            ? isRemoteClient() ? "Создайте аккаунт в облаке, чтобы защитить работу и состояние входа на этом хосте." : "Сначала зарегистрируйте имя пользователя и пароль, затем выберите гостевую систему и установите среду. Гостевая macOS будет использовать те же учётные данные."
            : account
              ? account.trusted_local ? "Локальная рабочая область" : "Введите пароль, чтобы продолжить работу."
              : isRemoteClient() ? "Чтение облачного аккаунта…" : "Чтение локального аккаунта…"}
        </p>
        {account?.background_running && (
          <div className="account-background">
            <i />
            Фоновая среда продолжает работать, задачи не остановлены
          </div>
        )}
        {account?.trusted_local && <div className="account-trust-choice">
          <p>{localDesktop() ? "Войти в рабочую область с локальными доверенными учётными данными текущего пользователя системы." : "Вернитесь на доверенный рабочий стол, задайте пароль аккаунта и войдите здесь."}</p>
          {localDesktop() && <button className="quiet-button" disabled={busy} onClick={() => enterTrusted("resume")}>{busy ? "Вход…" : "Снова войти в локальную рабочую область"}</button>}
        </div>}
        {account?.trusted_local && error && <p className="account-error" role="alert">{error}</p>}
        {account && !account.trusted_local && (
          <form onSubmit={submit}>
            <fieldset disabled={busy}>
              {creating && (
                <><label className="account-field">
                  Имя пользователя
                  <input
                    autoFocus
                    autoComplete="username"
                    maxLength={account.macos_account_host ? 31 : 40}
                    pattern={account.macos_account_host ? "[a-z][a-z0-9_]{0,30}" : undefined}
                    required
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder={account.macos_account_host ? "например: ivan" : "Как к вам обращаться"}
                  />
                </label>
                {account.macos_account_host && <p className="field-help">Общие с гостевой macOS: начинается со строчной буквы; 1–31 строчная буква, цифра или подчёркивание.</p>}</>
              )}
              <PasswordField
                label={creating ? "Задать пароль" : "Пароль аккаунта"}
                value={password}
                onChange={setPassword}
                autoComplete={creating ? "new-password" : "current-password"}
              />
              {creating && (
                <PasswordField
                  label="Подтвердите пароль"
                  value={confirmation}
                  onChange={setConfirmation}
                  autoComplete="new-password"
                />
              )}
              {creating && account.macos_account_host && <p className="field-help">Пароль — 8–256 букв, цифр, пробелов или символов, доступных на английской клавиатуре. После прерывания установки используются те же учётные данные.</p>}
              {(error || connectionError) && (
                <p className="account-error" role="alert">
                  {error || connectionError}
                </p>
              )}
              {!creating && Object.values(deviceSupport?.device_status || {}).includes("missing") && (
                <p className="field-help" role="status">Учётные данные быстрого входа для текущего каталога отсутствуют или устарели. Разблокируйте паролем, затем снова включите быстрый вход в разделе «Настройки → Аккаунт → Вход и разблокировка».</p>
              )}
              {!creating && Object.values(deviceSupport?.device_status || {}).includes("unavailable") && (
                <p className="field-help" role="status">Не удаётся проверить системную связку ключей. Сначала разблокируйте паролем. Запись авторизации быстрого входа сохранена.</p>
              )}
              {deviceSupport?.supported && !deviceSupport.device_status && (
                <p className="field-help" role="status">Средство запуска приложения устарело, поэтому состояние быстрого входа проверить нельзя. Войдите с паролем и переустановите полное приложение Cage.</p>
              )}
              {(localDesktop() || (creating && deviceSupport?.supported && deviceSupport.device_status)) && (
                <label className="account-device-option check-line">
                  <input type="checkbox" checked={rememberThisDevice} onChange={(e) => setRememberLogin(e.target.checked)} />
                  <span><strong>{localDesktop() ? "Запомнить меня" : "Запомнить вход"}</strong><small>{localDesktop() ? "Доверять этому компьютеру: при следующем открытии от текущего пользователя системы вход выполнится сразу. После ручной блокировки потребуется проверка." : "При следующем открытии вход выполнится сразу. После ручной блокировки потребуется проверка."}</small></span>
                </label>
              )}
              {!creating && deviceSupport?.supported && credentialPresent(deviceSupport.device_status?.biometric) && account.devices?.biometric && (
                <button type="button" className="quiet-button account-submit" disabled={busy}
                  onClick={async () => {
                    setBusy(true); setError("");
                    try { await deviceAction("unlock", "biometric"); }
                    catch (e) { setError(e.message); }
                    finally { setBusy(false); }
                  }}>
                  <Fingerprint size={18} />Разблокировать с помощью Touch ID
                </button>
              )}
              <button
                className="primary account-submit"
                disabled={busy || !password || (creating && (!username.trim() || (!localDesktop() && nativeAvailable() && deviceSupport === null)))}
              >
                {busy ? "Разблокировка…" : creating ? isRemoteClient() ? "Создать облачный аккаунт" : "Создать локальный аккаунт" : "Разблокировать Cage"}
              </button>
            </fieldset>
          </form>
        )}
        {!account && connectionError && (
          <>
            <p role="alert" className="account-error">
              {connectionError}
            </p>
            <button onClick={() => refresh().catch(() => {})}>Переподключиться</button>
          </>
        )}
        <p className="account-local-note">
          <LockKeyhole size={14} />
          {isRemoteClient() ? "Данные аккаунта хранятся на текущем облачном хосте" : "Данные аккаунта хранятся только на этом устройстве"}
        </p>
        {!account?.trusted_local && <p className="account-recovery-note">
          {creating
            ? "Пароль должен содержать не менее 8 символов и защищает учётные данные для входа. Сохраните его: восстановление онлайн не поддерживается."
            : isRemoteClient() ? "Введите пароль облачного аккаунта Cage; восстановление онлайн не поддерживается." : "Введите пароль локального аккаунта; восстановление онлайн не поддерживается."}
        </p>}
      </section>
      {nativeAvailable() && (
        <button
          className="text-button account-exit-app"
          onClick={() => native("quitNow").catch((e) => setError(e.message))}
        >
          {account?.background_running ? "Выйти из приложения, оставив фон" : "Выйти из Cage"}
        </button>
      )}
    </main>
  );
}

export function AccountMenu({ onSettings, onConfirm, onStatus, busy }) {
  const { account, act, deviceNotice, setDeviceNotice } = useAccount();
  useEffect(() => {
    if (deviceNotice) { onStatus(deviceNotice); setDeviceNotice(""); }
  }, [deviceNotice]);
  const [open, setOpen] = useState(false);
  const root = useRef();
  useEffect(() => {
    if (!open) return;
    root.current.querySelector('[role="menuitem"]').focus();
    const dismiss = (event) => {
      if (
        event.key === "Escape" ||
        (event.type === "click" && !root.current?.contains(event.target))
      ) {
        if (event.key === "Escape") root.current?.querySelector(".account-trigger")?.focus();
        setOpen(false);
      }
    };
    window.addEventListener("click", dismiss);
    window.addEventListener("keydown", dismiss);
    return () => {
      window.removeEventListener("click", dismiss);
      window.removeEventListener("keydown", dismiss);
    };
  }, [open]);
  const perform = async (action) => {
    setOpen(false);
    if (
      action === "logout" &&
      !(await onConfirm({
        title: isRemoteClient() ? "Выйти из облачного аккаунта?" : "Выйти из локального аккаунта?",
        body: "Это остановит среду Cage и фоновые задачи, а также заблокирует учётные данные. Сначала сохраните файлы.",
        confirm: "Остановить среду и выйти из аккаунта",
      }))
    )
      return;
    try {
      await act(action);
    } catch (e) {
      onStatus(e.message);
    }
  };
  return (
    <div className="account-menu-root" ref={root}>
      <button
        className="account-trigger"
        aria-label={`Меню аккаунта, ${account.username}`}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen(!open)}
      >
        <AccountAvatar account={account} />
        <span className="account-trigger-name">
          <strong>{account.username}</strong>
          <small>{account.trusted_local ? "Доверенный локальный" : isRemoteClient() ? "Облачный аккаунт" : "Локальный аккаунт"}</small>
        </span>
        <ChevronDown size={15} />
      </button>
      {open && (
        <div className="account-menu" role="menu" aria-label={isRemoteClient() ? "Меню облачного аккаунта" : "Меню локального аккаунта"}
          onKeyDown={(event) => {
            if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
            event.preventDefault();
            const items = [...event.currentTarget.querySelectorAll("button:enabled")];
            const step = event.key === "ArrowDown" ? 1 : -1;
            items[(items.indexOf(event.target) + step + items.length) % items.length].focus();
          }}
        >
          <div className="account-menu-label">Ваш Cage</div>
          <button
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onSettings("account");
            }}
          >
            <Settings size={16} />
            Настройки
          </button>
          {account.trusted_local ? <button role="menuitem" onClick={() => { setOpen(false); onSettings("account"); }}>
            <LockKeyhole size={16} /> Задать пароль аккаунта
          </button> : <>
          <div className="account-menu-divider" />
          <button role="menuitem" onClick={() => perform("lock")}>
            <LockKeyhole size={16} />
            Заблокировать Cage<small>Задачи продолжают работать</small>
          </button>
          <button
            role="menuitem"
            disabled={busy}
            onClick={() => perform("logout")}
          >
            <LogOut size={16} />
            Выйти из аккаунта
          </button></>}
        </div>
      )}
    </div>
  );
}

export function AccountSettings({ busy: environmentBusy, onDirty }) {
  const { account, act, refresh } = useAccount();
  const [name, setName] = useState(account.username),
    [avatar, setAvatar] = useState(account.avatar || "");
  const [oldPassword, setOldPassword] = useState(""),
    [password, setPassword] = useState(""),
    [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const [feedbackTarget, setFeedbackTarget] = useState("profile");
  const file = useRef();
  const changed =
    name !== account.username || avatar !== (account.avatar || "");
  useEffect(() => {
    onDirty?.(changed || Boolean(oldPassword || password || confirmation));
  }, [changed, oldPassword, password, confirmation]);
  useEffect(() => () => onDirty?.(false), []);
  const upload = async (event) => {
    setFeedbackTarget("profile");
    const selected = event.target.files?.[0];
    event.target.value = "";
    if (!selected) return;
    if (
      selected.size > 2 * 1024 * 1024 ||
      !["image/png", "image/jpeg"].includes(selected.type)
    ) {
      setError("Выберите изображение PNG или JPEG размером не более 2 MB");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setAvatar(reader.result);
      setError("");
      setMessage("");
    };
    reader.readAsDataURL(selected);
  };
  const save = async (event, changingPassword = false) => {
    event.preventDefault();
    if (busy) return;
    setFeedbackTarget(changingPassword ? "password" : "profile");
    if (changingPassword && password !== confirmation) {
      setError("Пароли не совпадают");
      return;
    }
    setBusy(true);
    setError("");
    setMessage("");
    try {
      if (changingPassword && account.trusted_local) {
        await trustedLogin("protect", password);
        await refresh();
        setPassword(""); setConfirmation("");
        setMessage("Пароль задан; при следующем открытии Cage потребуется вход по паролю.");
        return;
      }
      const value = await act(
        changingPassword ? "password" : "profile",
        changingPassword
          ? {
              old_password: oldPassword,
              password,
              confirm_password: confirmation,
            }
          : { username: name, avatar },
      );
      if (changingPassword) {
        setOldPassword("");
        setPassword("");
        setConfirmation("");
        setMessage(value.macos_password_pending ? "Пароль Cage изменён. Пароль гостевой системы ещё не синхронизирован; попытка повторится при следующем запуске. До синхронизации гостевая система может по-прежнему требовать старый пароль." : "Пароль изменён; состояние входа в приложение не изменилось");
      } else {
        setName(value.username);
        setAvatar(value.avatar || "");
        setMessage("Данные аккаунта сохранены");
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const feedback = (
    <>
      {error && (
        <p className="account-error" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p className="account-saved" role="status">
          <Check size={15} />
          {message}
        </p>
      )}
    </>
  );
  if (account.macos_account_host && account.guest_system === "macos" && !account.macos_credentials_ready) return <MacOSAccountGate />;
  return (
    <div className="account-settings">
      <div className="section-title">
        <h3>Аккаунт</h3>
        <p>Придайте рабочему пространству свой вид.</p>
      </div>
      <form onSubmit={(event) => save(event)}>
        <fieldset disabled={busy || environmentBusy}>
          <div className="account-profile-heading">
            <AccountAvatar account={{ username: name, avatar }} large />
            <div>
              <button
                type="button"
                className="quiet-button"
                onClick={() => file.current.click()}
              >
                <Camera size={16} />
                Сменить аватар
              </button>
              {avatar && (
                <button
                  type="button"
                  className="text-button"
                  onClick={() => setAvatar("")}
                >
                  Вернуть по умолчанию
                </button>
              )}
              <p className="field-help">
                PNG или JPEG, не более 2 MB, автоматическая обрезка по центру.
              </p>
            </div>
          </div>
          <input
            ref={file}
            type="file"
            accept="image/png,image/jpeg"
            hidden
            onChange={upload}
            aria-label="Выбрать изображение аватара"
          />
          <label className="account-field">
            Имя пользователя
            <input
              value={name}
              maxLength={40}
              autoComplete="username"
              onChange={(e) => setName(e.target.value)}
              required
              readOnly={account.macos_username_bound}
            />
          </label>
          {account.macos_username_bound && <p className="field-help">Имя пользователя уже используется гостевой macOS. Оставьте его, чтобы сохранить доступ к прежнему аккаунту и файлам.</p>}
          <button
            className="primary"
            disabled={!changed || !name.trim() || busy}
          >
            <Check size={16} />
            Сохранить данные
          </button>
        </fieldset>
      </form>
      {feedbackTarget === "profile" && feedback}
      <div className="account-section-divider" />
      <form onSubmit={(event) => save(event, true)}>
        <fieldset disabled={busy || environmentBusy}>
          <h4>Пароль аккаунта</h4>
          <p className="field-help">
            Смена пароля не сбрасывает вход в Claude. {account.macos_credentials_ready ? "Cage и гостевая macOS используют общий пароль; если гостевая система выключена, пароль синхронизируется при следующем запуске." : isRemoteClient() ? "Пароль разблокирует текущий облачный Cage; восстановление онлайн недоступно." : "Пароль разблокирует локальный Cage; восстановление онлайн недоступно."}
          </p>
          {!account.trusted_local && <PasswordField
            label="Текущий пароль"
            value={oldPassword}
            onChange={setOldPassword}
          />}
          <PasswordField
            label="Новый пароль"
            value={password}
            onChange={setPassword}
            autoComplete="new-password"
          />
          <PasswordField
            label="Подтвердите новый пароль"
            value={confirmation}
            onChange={setConfirmation}
            autoComplete="new-password"
          />
          <button
            className="quiet-button"
            disabled={busy || (!account.trusted_local && !oldPassword) || !password || !confirmation}
          >
            {account.trusted_local ? "Задать пароль и отключить вход без аккаунта" : "Изменить пароль"}
          </button>
        </fieldset>
      </form>

      {feedbackTarget === "password" && feedback}
      {localDesktop() && !account.trusted_local && <TrustedDeviceSettings />}
      {!account.trusted_local && <AccountDeviceSettings />}
      <p className="account-settings-note">
        <LockKeyhole size={15} />
        {isRemoteClient() ? "Аккаунт, данные приложения и учётные данные входа хранятся на текущем облачном хосте." : "Один локальный аккаунт — одна постоянная рабочая среда. Данные и учётные данные не передаются на серверы Cage."}
      </p>
    </div>
  );
}

function TrustedDeviceSettings() {
  const { account, refresh } = useAccount();
  const enabled = Boolean(account.trusted_login || account.devices?.automatic);
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const update = async (event) => {
    event.preventDefault();
    setBusy(true); setMessage("");
    try {
      await trustedLogin(enabled ? "disable" : "enable", password);
      setPassword("");
      await refresh();
    } catch (error) { setMessage(error.message); }
    finally { setBusy(false); }
  };
  return <form onSubmit={update}>
    <fieldset disabled={busy}>
      <h4>Запомнить меня</h4>
      <p className="field-help">{enabled ? "Этот компьютер доверенный: при следующем открытии от текущего пользователя системы вход выполнится автоматически. После ручной блокировки потребуется проверка; выход из аккаунта отзывает доверие." : "Подтвердите пароль аккаунта один раз, чтобы доверять этому компьютеру и входить автоматически при следующем открытии от текущего пользователя системы."}</p>
      {!enabled && <PasswordField label="Подтвердите пароль аккаунта" value={password} onChange={setPassword} autoComplete="current-password" />}
      <button className="quiet-button" disabled={!enabled && !password}>{enabled ? "Отключить «Запомнить меня»" : "Доверять этому компьютеру"}</button>
      {message && <p className="account-error" role="alert">{message}</p>}
    </fieldset>
  </form>;
}

function AccountDeviceSettings() {
  const { account, deviceSupport, deviceAction, recheckDevices } = useAccount();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  if (!deviceSupport?.supported) return null;
  if (!deviceSupport.device_status) return <section className="account-device-settings" aria-label="Вход и разблокировка">
    <h4>Вход и разблокировка</h4>
    <p className="field-help" role="status">Средство запуска приложения устарело, поэтому состояние быстрого входа проверить нельзя. Переустановите полное приложение Cage и настройте заново; существующая авторизация сохранена.</p>
  </section>;
  const states = deviceSupport.device_status || {};
  const description = (kind, fallback) => states[kind] === "missing"
    ? "Учётные данные текущего каталога отсутствуют или устарели. Включите снова."
    : states[kind] === "unavailable"
      ? "Не удаётся проверить системную связку ключей; запись авторизации сохранена. Повторите проверку позже."
      : states[kind] === "authentication_required"
        ? "Для учётных данных требуется проверка Touch ID; при разблокировке будет запрошен отпечаток пальца."
        : fallback;
  const change = async (kind, enabled) => {
    setBusy(true); setError(""); setMessage("");
    try {
      await deviceAction(enabled ? "enable" : "disable", kind);
      setMessage(enabled ? "Включено; учётные данные для разблокировки сохранены в системной связке ключей этого Mac" : "Авторизация быстрого входа отключена");
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };
  return <section className="account-device-settings" aria-label="Вход и разблокировка">
    <h4>Вход и разблокировка</h4>
    {!localDesktop() && <label className="account-device-option check-line">
      <input type="checkbox" checked={Boolean(account.devices?.automatic) && states.automatic === "available"} disabled={busy || states.automatic === "unavailable"}
        onChange={(event) => change("automatic", event.target.checked)} />
      <span><strong>Запомнить вход</strong><small>{description("automatic", "При повторном открытии вход выполнится сразу. После ручной блокировки потребуется отпечаток пальца или пароль.")}</small></span>
    </label>}
    <label className="account-device-option check-line">
      <input type="checkbox" checked={Boolean(account.devices?.biometric) && credentialPresent(states.biometric)} disabled={busy || states.biometric === "unavailable" || (!deviceSupport.biometric_available && !credentialPresent(states.biometric))}
        onChange={(event) => change("biometric", event.target.checked)} />
      <span><strong>Разблокировка с помощью Touch ID</strong><small>{description("biometric", deviceSupport.biometric_available ? "После ручной блокировки вход выполняется по системному отпечатку пальца." : "Сначала настройте Touch ID в системных настройках macOS.")}</small></span>
    </label>
    {Object.values(states).includes("unavailable") && <button type="button" className="quiet-button" disabled={busy} onClick={recheckDevices}>Проверить быстрый вход снова</button>}
    <p className="field-help">Выход из аккаунта отзывает локальную авторизацию быстрого входа. Пароль всегда можно использовать для разблокировки.</p>
    {error && <p className="account-error" role="alert">{error}</p>}
    {message && <p className="account-saved" role="status">{message}</p>}
  </section>;
}
