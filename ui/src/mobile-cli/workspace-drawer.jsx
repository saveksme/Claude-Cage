import React, { useEffect, useRef } from "react";
import { Folder, FolderOpen, Globe2, LoaderCircle, LogOut, Monitor, Plus, Settings, Sparkles } from "lucide-react";
import { InlineSelect } from "./inline-select";
import { SessionRow, sortSessions } from "./session-row";

export const workspaceTools = [
  {id:"browser", name:"Браузер", icon:Globe2},
  {id:"claude", name:"Claude.ai", icon:Sparkles},
  {id:"desktop", name:"Claude Desktop", icon:Monitor},
];

export function CodeNavigation({catalog, project, sessions, current, creating, onProject, onSession, onNew, onAction, formatTime}) {
  if (!catalog) return <p className="nav-note" role="status">Чтение проектов…</p>;
  if (!project) return <p className="nav-note">Сначала откройте проект в Cage на компьютере.</p>;
  return <section className="code-navigation" aria-label="Проекты и сеансы Claude Code">
    <div className="project-field">
      <InlineSelect label="Выбрать проект" icon={<FolderOpen size={16} />} value={project.path}
        disabled={creating} onChange={onProject} options={catalog.projects.map(p => ({
          value:p.path, label:p.name, optionLabel:p.name + " · " + p.path,
        }))} />
    </div>
    <div className="row-heading"><h2>Сеансы</h2><button type="button" className="nav-new" onClick={onNew} disabled={creating || !catalog.ready}>
      {creating ? <LoaderCircle size={15} className="spin" /> : <Plus size={15} />}Новый сеанс</button></div>
    {sessions.length ? <ul className="session-list">{sessions.map(s => <SessionRow key={s.id} session={s} current={current === s.id}
      disabled={creating} onSelect={() => onSession(s.id)} onAction={onAction} detail={formatTime(s.updated_at)}/>)}</ul>
      : <p className="nav-note">{catalog.ready ? "В этом проекте пока нет сеансов." : "Сначала запустите Cage на компьютере."}</p>}
  </section>;
}

export function ProjectTree({catalog, projectPath, sessionID, expanded, toggle, creating, onNew, onSession, onAction}) {
  const projects = catalog?.projects || [];
  return <section className="project-tree" aria-label="Проекты и сеансы Claude Code">
    <h2>Claude Code</h2>
    {catalog?.shared_sessions === false && <p className="nav-note">Текущая конфигурация запуска использует отдельные мобильные сеансы. Для общих терминалов компьютера запускайте через команду claude.</p>}
    {!catalog ? <p className="nav-note" role="status">Чтение проектов…</p> :
      !projects.length ? <p className="nav-note">Откройте проект в Cage на компьютере.</p> : projects.map((project, index) => {
        const path = project.path;
        const open = expanded.get(path) ?? (path === projectPath || index === 0);
        const name = projects.some(other => other !== project && other.name === project.name) ? path : project.name;
        const sessions = catalog.sessions.filter(s => s.workspace === path)
          .sort(sortSessions);
        return <div className="tree-project" key={path}>
          <div className="tree-row">
            <button type="button" className="tree-folder" title={path} aria-label={"Проект " + name}
              aria-expanded={open} onClick={() => toggle(path, !open)}>
              {open ? <FolderOpen size={17} /> : <Folder size={17} />}
              <span>{name}</span>
            </button>
            <button type="button" className="icon-button tree-new" aria-label={"Новый сеанс в " + name}
              title={"Новый сеанс в " + name} disabled={creating || !catalog.ready} onClick={() => onNew(project)}>
              <Plus size={16} />
            </button>
          </div>
          {open && <ul className="tree-sessions" aria-label={name + ": сеансы"}>
            {sessions.length ? sessions.map(s => <SessionRow key={s.id} session={s} current={s.id === sessionID} disabled={creating}
              onSelect={() => onSession(path, s.id)} onAction={onAction}/>) : <li className="tree-empty">Сеансов пока нет</li>}
          </ul>}
        </div>;
      })}
  </section>;
}

export function WorkspaceDrawer({open, active, name, onClose, onTool, onExit, onSettings, nativePhone, children}) {
  const panel = useRef(null);
  useEffect(() => {
    const dialog = panel.current;
    let frame;
    let timer;
    if (open) {
      if (!dialog.open) dialog.showModal();
      frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => { dialog.dataset.visible = "true"; }); });
    } else if (dialog.open) {
      delete dialog.dataset.visible;
      if (matchMedia("(prefers-reduced-motion: reduce)").matches) dialog.close();
      else timer = setTimeout(() => dialog.close(), 240);
    }
    return () => { cancelAnimationFrame(frame); clearTimeout(timer); };
  }, [open]);
  return <dialog className="workspace-drawer" ref={panel} aria-label="Боковая панель рабочей области"
    onCancel={event => {event.preventDefault(); onClose();}}
    onClick={event => {
      if (event.target !== panel.current) return;
      const rect = panel.current.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX >= rect.right || event.clientY < rect.top || event.clientY >= rect.bottom) onClose();
    }}>
    <header className="drawer-heading"><Monitor size={18} /><h2>{name || "Удалённая рабочая среда"}</h2></header>
    <div className="drawer-content">
      <nav className="workspace-tools" aria-label="Удалённые инструменты">{workspaceTools.map(({id, name:toolName, icon:Icon}) =>
        <button key={id} type="button" className="tool-link" aria-current={id === active ? "page" : undefined} onClick={() => onTool(id)}>
          <Icon size={19} /><span>{toolName}</span>
        </button>)}</nav>
      {children}
    </div>
    <footer className="drawer-footer"><button className="drawer-exit" type="button" onClick={onSettings}><Settings size={18}/>Настройки</button>
      <a className="drawer-exit" href={nativePhone ? "cage://home" : "/"}
      onClick={event => {if (onExit()) event.preventDefault();}}><LogOut size={18}/>Выход</a></footer>
  </dialog>;
}
