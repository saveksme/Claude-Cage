import { isWindows, isMac } from "./platform.mjs";
import React, { useEffect, useState } from "react";
import { FolderOpen, LoaderCircle, Plus } from "lucide-react";
import { api, native, nativeAvailable } from "./api";
import { SafetyMessage } from "./safety-message";
import { Modal } from "./views";
import { MacOSProjectApproval } from "./macos-project-approval";
import { ProjectRecovery } from "./project-recovery";
import { projectName, rememberClientProjectName } from "./workspace-state.mjs";
import { getClientContext, isRemoteClient } from "./client-context.mjs";

export function ProjectDialog({
  status,
  initialPath = "",
  activate = true,
  onClose,
  onOpened,
  onRemoved,
  onSettings,
}) {
  const projects = status.projects || [];
  const [adding, setAdding] = useState(Boolean(initialPath) || projects.length === 0);
  const [path, setPath] = useState(initialPath || status.workspace || projects[0] || "");
  const [error, setError] = useState("");
  const [recovery, setRecovery] = useState("");
  const [pending, setPending] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [removeTarget, setRemoveTarget] = useState("");
  const [removed, setRemoved] = useState([]);
  const [directories, setDirectories] = useState(null);
  const [browsing, setBrowsing] = useState(false);
  const remote = isRemoteClient();
  const context = getClientContext();
  const canShare = remote && nativeAvailable() && context.connection?.manifest?.capabilities?.client_project_share === true;
  const [shares, setShares] = useState([]);
  const [writeAccess, setWriteAccess] = useState(false);
  const [sharing, setSharing] = useState(false);
  useEffect(() => {
    if (!canShare) return;
    let current = true;
    api("/client/project-shares").then(({ shares }) => {
      if (current) {
        (shares || []).forEach(rememberClientProjectName);
        setShares(shares || []);
      }
    }).catch((e) => { if (current) setError(e.message); });
    return () => { current = false; };
  }, [canShare, context.connection_id]);
  const share = async () => {
    setSubmitting(true); setError("");
    try {
      const item = await native("shareLocalProject", { mode: writeAccess ? "write" : "read" });
      if (item.canceled) return;
      rememberClientProjectName(item);
      setShares((old) => [...old.filter((s) => s.id !== item.id), item]);
      setPath(item.guest_path); setAdding(false); setSharing(false);
      const result = await api("/projects/open", { workspace: item.guest_path, add: false, activate });
      await onOpened(result.workspace);
    } catch (e) { setError(e.message); }
    finally { setSubmitting(false); }
  };
  const revoke = async (item) => {
    setSubmitting(true); setError("");
    try {
      await api("/client/project-shares/" + item.id, undefined, "DELETE");
      setShares((old) => old.filter((s) => s.id !== item.id));
      if (path === item.guest_path) setPath(status.environment_directory || "");
    } catch (e) { setError(e.message); }
    finally { setSubmitting(false); }
  };
  const projectList = [...new Set([...projects, ...shares.map((s) => s.guest_path)])].filter(project => !removed.includes(project));
  const selectedShare = shares.find((item) => item.guest_path === path);
  const busy = submitting || Boolean(status.job?.running);
  const remove = async () => {
    if (busy || !removeTarget) return;
    setSubmitting(true); setError("");
    try {
      const result = await api("/projects/remove", { workspace: removeTarget });
      setRemoved(previous => [...previous, removeTarget]);
      setPath(result.workspace || status.environment_directory || "");
      setRemoveTarget("");
      await onRemoved?.(removeTarget, result.workspace);
    } catch (e) { setError(e.message); }
    finally { setSubmitting(false); }
  };
  const browse = async (directory = path.trim()) => {
    setBrowsing(true); setError("");
    try { setDirectories(await api(`/projects/directories?${new URLSearchParams({ path: directory })}`)); }
    catch (e) { setError(e.message); }
    finally { setBrowsing(false); }
  };
  const choose = async () => {
    if (remote) { await browse(); return; }
    try {
      const selected = await native("chooseFolder");
      if (selected) {
        setPath(selected);
        setError("");
      }
    } catch {
      setError("Не удалось выбрать папку. Введите путь вручную.");
    }
  };
  const add = () => {
    setAdding(true);
    setPath("");
    setError("");
    if (remote) void browse("");
    else if (nativeAvailable()) void choose();
  };
  const open = async (event) => {
    event?.preventDefault();
    if (busy || sharing || removeTarget || !status.ready || !path.trim()) return;
    setSubmitting(true);
    setError("");
    setRecovery("");
    try {
      const result = await api("/projects/open", {
        workspace: path.trim(),
        add: adding,
        activate,
      });
      if (result.approval) setPending({ workspace: result.workspace, grant: result.approval });
      else await onOpened(result.workspace);
    } catch (e) {
      setError(e.message);
      setRecovery(e.recovery || "");
    } finally {
      setSubmitting(false);
    }
  };
  if (pending) return <MacOSProjectApproval pending={pending} onClose={onClose} onSettings={onSettings} onCheck={async () => {
    const result = await api("/projects/open", { workspace: pending.workspace, add: adding, activate });
    if (result.approval) {
      setPending({workspace: result.workspace, grant: result.approval});
      return;
    }
    await onOpened(result.workspace);
  }} />;
  return (
    <Modal
      title={activate ? "Открыть проект" : "Выбрать рабочий проект"}
      onClose={busy ? undefined : onClose}
      footer={
        <>
          <span className="save-note">
            {busy
              ? submitting ? removeTarget ? "Удаление проекта…" : "Подключение проекта…" : status.job?.message
              : adding ? "Добавить в список проектов Cage" : "Использовать авторизованный проект Cage"}
          </span>
          <button disabled={busy} onClick={onClose}>
            Отмена
          </button>
          <button
            className="primary"
            form="open-project"
            type="submit"
            disabled={!path.trim() || busy || sharing || Boolean(removeTarget) || !status.ready}
          >
            {busy ? (
              <LoaderCircle className="spin" size={15} />
            ) : (
              <FolderOpen size={15} />
            )}
            {activate ? "Открыть проект" : "Использовать этот проект"}
          </button>
        </>
      }
    >
      <form
        id="open-project"
        className="modal-body project-form"
        onSubmit={open}
      >
        <p>{activate ? remote ? "Выберите существующий проект или добавьте папку облачного проекта." : "Выберите существующий проект или добавьте папку локального проекта." : "Выберите рабочий каталог из списка проектов Cage. Новые проекты авторизуются и предоставляются в общий доступ через Cage."}</p>
        {canShare && <>
          <button type="button" className="quiet-button project-picker-add" onClick={() => { setSharing(!sharing); setWriteAccess(false); }} disabled={busy} aria-expanded={sharing}>
            <FolderOpen size={16} />Поделиться локальным проектом…
          </button>
          {sharing && <fieldset className="project-picker-list project-permissions" disabled={busy}>
            <legend>Предоставить доступ: {context.name || "текущий облачный Cage"}</legend>
            <p className="field-help">Облако читает проект по запросу. Доступ к учётным данным, метаданным Git и ссылкам ограничен. После отключения доступ прекращается.</p>
            <label><input type="checkbox" checked={writeAccess} onChange={(e) => setWriteAccess(e.target.checked)} />Разрешить облаку изменять и удалять файлы локального проекта</label>
            <button type="button" onClick={share}>Выбрать локальную папку…</button>
          </fieldset>}
        </>}
        {!sharing && !adding && <>
          <fieldset className="project-picker-list" disabled={busy || Boolean(removeTarget)}>
            <legend>Проекты Cage</legend>
            {projectList.map((project) => <label className={`project-picker-item ${path === project ? "selected" : ""}`} key={project}>
              <input type="radio" name="project" value={project} checked={path === project} onChange={() => { setPath(project); setError(""); }} />
              <FolderOpen size={18} aria-hidden="true" />
              <span>
                <strong>{project === status.environment_directory ? "Рабочая область по умолчанию" : projectName(project)}</strong>
                <small>{shares.find((s) => s.guest_path === project)?.path || project}</small>
                {status.project_errors?.some((item) => item.path === project) && <small>Требуется переподключение; выберите проект и повторите</small>}
              </span>
            </label>)}
          </fieldset>
          {selectedShare && <button type="button" disabled={submitting} onClick={() => revoke(selectedShare)}>Прекратить общий доступ к локальному проекту ({selectedShare.readonly ? "только чтение" : "чтение и запись"})</button>}
          {activate && !selectedShare && path && path !== status.environment_directory && !removeTarget && <button type="button" className="quiet-button" disabled={busy} onClick={() => { setRemoveTarget(path); setError(""); setRecovery(""); }}>Удалить этот проект из Cage</button>}
          {removeTarget && <section className="project-picker-list" aria-label="Подтверждение удаления проекта">
            <p>Удаление «{projectName(removeTarget)}» отключит общий доступ к каталогу. Исходные файлы и история сеансов сохранятся; после повторного добавления того же каталога история снова станет доступна.</p>
            <p className="field-help">Сначала сохраните файлы и закройте терминалы, запущенные сеансы и редактор этого проекта. После удаления текущего проекта будет выбрана рабочая область по умолчанию.</p>
            <button type="button" disabled={busy} onClick={() => { setRemoveTarget(""); setError(""); }}>Отменить удаление</button>
            <button type="button" disabled={busy} onClick={remove}>Удалить проект</button>
          </section>}
          <button type="button" className="quiet-button project-picker-add" onClick={add} disabled={busy || Boolean(removeTarget) || !status.ready}><Plus size={16} />{remote ? "Добавить облачный проект…" : "Добавить локальный проект…"}</button>
        </>}
        {!sharing && adding && <>
          {projects.length > 0 && <button type="button" className="quiet-button project-picker-add" disabled={busy} onClick={() => { setAdding(false); setPath(status.workspace || projects[0]); setError(""); }}>Вернуться к существующим проектам</button>}
          <label htmlFor="project-path">Папка нового проекта</label>
          <div className="folder-input">
          <input
            id="project-path"
            autoFocus
            value={path}
            onChange={(event) => {
              setPath(event.target.value);
              setError("");
            }}
            placeholder={remote ? "/home/cage/Projects/my-project" : isWindows ? "C:/Users/ваше-имя/Projects/my-project" : isMac ? "/Users/ваше-имя/Projects/my-project" : "/home/ваше-имя/Projects/my-project"}
            disabled={busy}
            spellCheck="false"
            autoComplete="off"
          />
          {(remote || nativeAvailable()) && (
            <button type="button" onClick={choose} disabled={busy || browsing}>
              {browsing ? "Чтение…" : remote ? "Просмотреть облачные папки…" : "Выбрать папку…"}
            </button>
          )}
          </div>
          {remote && directories && <section className="remote-directory-picker" aria-label="Облачные папки">
            <div className="remote-directory-heading"><strong>{directories.path}</strong><button type="button" disabled={browsing} onClick={() => setDirectories(null)}>Свернуть</button></div>
            <div className="remote-directory-list">
              {directories.parent && <button type="button" disabled={browsing} onClick={() => browse(directories.parent)}>Перейти в родительскую папку</button>}
              {directories.directories?.map((directory) => <button type="button" key={directory.path} disabled={browsing} onClick={() => browse(directory.path)}><FolderOpen size={16} />{directory.name}</button>)}
              {directories.directories?.length === 0 && <p className="field-help">В этом каталоге нет папок для просмотра.</p>}
            </div>
            <button type="button" disabled={browsing || !directories.selectable} onClick={() => { setPath(directories.path); setDirectories(null); }}>Выбрать эту облачную папку</button>
          </section>}
        </>}
        <p className="field-help">
          {remote ? "Облачные проекты хранятся на сервере." : "Изменения в этой папке синхронизируются с этим компьютером."} Все проекты используют одну среду Cage; открытые терминалы и веб-страницы продолжат работать.
        </p>
        {!status.ready && <p className="field-help">После готовности среды можно добавлять и открывать проекты. Существующие проекты по-прежнему можно удалить из списка.</p>}
        {error && (
          <div className="error-message" role="alert">
            <SafetyMessage message={error} />
            {recovery && <ProjectRecovery recovery={recovery} disabled={busy} onRetry={() => void open()}
              onSettings={onSettings} onSessionClosed={() => void open()} />}
          </div>
        )}
      </form>
    </Modal>
  );
}
