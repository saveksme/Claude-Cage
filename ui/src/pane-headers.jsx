import React, { useEffect, useRef, useState } from "react";
import { Archive, ArrowLeft, ArrowRight, ArrowUpRight, ChevronRight, FolderOpen,
  Globe2, Cookie, Settings, Puzzle, ScanEye, Maximize2, MoreHorizontal, PanelLeftOpen, Plus, RefreshCw, X } from "lucide-react";
import { BrowserVaultBar } from "./password-vault";
import { WorkspaceTabs } from "./workspace-tabs";
import { BrowserFavorites } from "./browser-favorites";
import { BrowserDownloads } from "./browser-downloads";
import { BrowserCookies } from "./browser-cookies";
import { tabName } from "./workspace-state.mjs";
import { shortcut } from "./platform.mjs";
import logo from "./logo.png";

export const ExpandSidebar = ({ onClick }) => <button className="icon-button sidebar-expand"
  aria-label="Развернуть боковую панель" onClick={onClick}>
  <img className="sidebar-expand-logo" src={logo} alt="" />
  <PanelLeftOpen className="sidebar-expand-icon" size={18} />
</button>;

export const ExpandPane = ({ onClick }) => <button className="icon-button expand-pane"
  aria-label="Выйти из разделённого экрана" title="Показать эту страницу на всей рабочей среде" onClick={onClick}><Maximize2 size={14} /></button>;

export function TerminalHeader({ tab, contentWorkspace, project, metadata, terminalDetail, terminalDetailHint,
  onHome, busy, onClose, sidebarButton, exitButton, location, triggerRef, menu }) {
  return <header className="chrome terminal-chrome">
    <div className="content-heading">
      {sidebarButton}
      <div className="content-breadcrumb">
        <button
          onClick={onHome}
          title={contentWorkspace}
          data-terminal-location={location}
          ref={triggerRef}
        >
          <FolderOpen size={15} />
          <span>{project}</span>
        </button>
        {tab && (
          <>
            <ChevronRight size={13} />
            <span className="current-title" title={tabName(tab, metadata, project)}>
              {tabName(tab, metadata, project)}
            </span>
            {terminalDetail && <span className="terminal-detail" title={terminalDetailHint}>{terminalDetail}</span>}
          </>
        )}
      </div>
      <div className="heading-actions">
        {tab && (
          <button
            className="icon-button"
            aria-label={tab.cli_session_id ? "Архивировать текущий сеанс" : "Закрыть текущую вкладку"}
            title={shortcut(tab.cli_session_id ? "Архивировать текущий сеанс ⌘W" : "Закрыть текущую вкладку ⌘W")}
            onClick={onClose}
            disabled={busy}
          >
            {tab.cli_session_id ? <Archive size={16} /> : <X size={16} />}
          </button>
        )}
        {exitButton}
      </div>
    </div>
    {menu}
    {busy && <div className="progress-line" />}
  </header>;
}

// The selected title is primary; tab actions and the add button use the existing
// muted/hover tokens, 8px spacing and browser-tab typography in either layout.
export function BrowserTabRail({ tabs, metadata, active, ready, busy, splitDrag, sidebarButton,
  onSelect, onClose, onRename, onPin, onReorder, onNew }) {
  return <aside className="chrome browser-tab-rail" aria-label="Вертикальная панель вкладок">
    <div className="browser-tab-rail-heading">
      {sidebarButton}<strong>Вкладки</strong>
      <button className="icon-button browser-new-tab" aria-label="Новая страница" title={shortcut("Новая страница ⌘T")}
        disabled={!ready || busy} onClick={onNew}><Plus size={17} /></button>
    </div>
    <WorkspaceTabs tabs={tabs} saved={metadata} active={active} label="Вкладки браузера" vertical
      ready={ready} busy={busy} splitDrag={splitDrag} onSelect={onSelect} onClose={onClose}
      onRename={onRename} onPin={onPin} onReorder={onReorder} />
  </aside>;
}

export function BrowserHeader({ vault, onManageVault, tab, tabs, metadata, ready, busy, focused, compact, triggerRef, vertical,
  sidebarButton, exitButton, splitDrag, onSelect, onClose, onRename, onPin, onReorder, onNew,
  location, menu, back, forward, action, onNavigate, onOpen, onNewPrivate, onNewRegular, onCloseBrowser, onSettings, onReload, downloads, onStatus, onEditor, onRecover, recoveringEditor }) {
  const [address, setAddress] = useState("");
  const [toolsOpen, setToolsOpen] = useState(false);
  const [cookiesOpen, setCookiesOpen] = useState(false);
  const toolsTrigger = useRef(), toolsMenu = useRef();
  const url = tab.url === "about:blank" ? "" : tab.url || "";
  useEffect(() => { setAddress(url); }, [tab.id, url]);
  useEffect(() => { setToolsOpen(false); setCookiesOpen(false); }, [tab.id]);
  useEffect(() => {
    if (!toolsOpen) return;
    toolsMenu.current?.querySelector('[role="menuitem"]:not(:disabled)')?.focus();
    const dismiss = event => {
      if (!toolsMenu.current?.contains(event.target) && !toolsTrigger.current?.contains(event.target)) setToolsOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [toolsOpen]);
  const menuKey = event => {
    if (event.key === "Tab") {
      setTimeout(() => {
        if (!toolsMenu.current?.contains(document.activeElement) && document.activeElement !== toolsTrigger.current) setToolsOpen(false);
      }, 0);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault(); event.stopPropagation(); setToolsOpen(false); toolsTrigger.current?.focus();
      return;
    }
    if (event.target.getAttribute("role") !== "menuitem") return;
    const items = [...toolsMenu.current.querySelectorAll('[role="menuitem"]:not(:disabled)')];
    const index = items.indexOf(event.target);
    const next = event.key === "ArrowDown" ? (index + 1) % items.length :
      event.key === "ArrowUp" ? (index - 1 + items.length) % items.length :
      event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : -1;
    if (next >= 0) { event.preventDefault(); items[next].focus(); }
  };
  const closeButton = onCloseBrowser && <button className="icon-button browser-close" aria-label="Закрыть браузер"
    title="Закрыть браузер и вернуться на предыдущую страницу" onClick={onCloseBrowser}><X size={16} /></button>;
  return <header className={`chrome browser-chrome ${compact ? "split-chrome" : ""}`} data-browser-tab={tab.id}>
    {!vertical && <div className="browser-tab-bar">
      {sidebarButton}
      <WorkspaceTabs
        tabs={tabs}
        saved={metadata}
        active={tab.id}
        label="Вкладки браузера"
        horizontal
        busy={busy}
        ready={ready}
        onSelect={onSelect}
        onClose={onClose}
        onRename={onRename}
        onPin={onPin}
        splitDrag={splitDrag}
        onReorder={onReorder}
      />
      <button
        className="icon-button browser-new-tab"
        ref={triggerRef}
        data-terminal-location={location}
        aria-label="Новая страница"
        title={shortcut("Новая страница ⌘T")}
        disabled={!ready || busy}
        onClick={onNew}
      >
        <Plus size={17} />
      </button>
      {(exitButton || closeButton) && <div className="browser-window-actions">{exitButton}{closeButton}</div>}
    </div>}
    <div className="navigation-row">
      <div className="nav-actions">
        <button
          className="icon-button"
          aria-label="Назад"
          disabled={!ready || !back}
          onClick={() =>
            action("/browser/back", { id: tab.id })
          }
        >
          <ArrowLeft size={17} />
        </button>
        <button
          className="icon-button"
          aria-label="Вперёд"
          disabled={!ready || !forward}
          onClick={() =>
            action("/browser/forward", { id: tab.id })
          }
        >
          <ArrowRight size={17} />
        </button>
        <button
          className="icon-button"
          aria-label="Перезагрузить страницу"
          disabled={!ready}
          onClick={onReload || (() => action("/browser/reload", { id: tab.id }))}
        >
          <RefreshCw size={15} />
        </button>
      </div>
      <form className="address-bar" onSubmit={event => { event.preventDefault(); onNavigate(address); }}>
        {tab.incognito ? <span className="browser-private-badge" title="Данные этого сеанса очищаются после закрытия всех приватных вкладок"><ScanEye size={13} />Приватный</span> : <Globe2 size={13} />}
        <input
          aria-label="Адрес страницы или поисковый запрос"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          onFocus={(e) => e.target.select()}
          placeholder={
            ready
              ? "Введите адрес или поисковый запрос, чтобы открыть в Cage"
              : "Запустите среду, чтобы просматривать страницы"
          }
          disabled={!ready}
          spellCheck="false"
        />
        <button
          className="address-go"
          type="submit"
          aria-label="Открыть адрес"
          disabled={!ready}
        >
          <ArrowUpRight size={15} />
        </button>
      </form>
      <BrowserFavorites current={tab} shortcuts={focused} ready={ready && !busy} onOpen={onOpen} />
      <BrowserDownloads downloads={downloads} ready={ready && !busy} onStatus={onStatus} />
      <button className="icon-button browser-more-trigger" aria-label="Меню браузера" title="Меню браузера"
        ref={toolsTrigger} aria-haspopup="menu"
        aria-expanded={toolsOpen} aria-controls={`browser-menu-${tab.id}`}
        onKeyDown={event => {
          if (event.key === "ArrowDown") {
            event.preventDefault(); setToolsOpen(true);
            if (toolsOpen) toolsMenu.current?.querySelector('[role="menuitem"]:not(:disabled)')?.focus();
          }
        }}
        onClick={() => { setCookiesOpen(false); setToolsOpen(!toolsOpen); }}><MoreHorizontal size={17} /></button>
      {vertical && exitButton}
      {vertical && closeButton}
    <div className="browser-more-menu" hidden={!toolsOpen} ref={toolsMenu}
      id={`browser-menu-${tab.id}`} role="menu" aria-label="Меню браузера" onKeyDown={menuKey}
      onClick={event => {
        const item = event.target.closest('[role="menuitem"]');
        if (item && !item.closest(".vault-browser")) { setToolsOpen(false); toolsTrigger.current?.focus(); }
      }}>
      <div className="browser-more-actions">
        <button className="browser-menu-item" role="menuitem" disabled={!ready || busy} onClick={onNewPrivate}><ScanEye size={16} />Новая приватная вкладка</button>
        {tab.incognito && <button className="browser-menu-item" role="menuitem" disabled={!ready || busy} onClick={onNewRegular}><Globe2 size={16} />Новая обычная вкладка</button>}
        {!tab.login && tab.kind !== "browser-settings" && <button className="browser-menu-item" role="menuitem" disabled={!ready || busy} onClick={() => setCookiesOpen(true)}><Cookie size={16} />Управление Cookie</button>}
        <button className="browser-menu-item" role="menuitem" disabled={!ready || busy} onClick={() => onSettings('extensions')}><Puzzle size={16} />Расширения</button>
        <BrowserDownloads menu anchorRef={toolsTrigger} downloads={downloads} ready={ready && !busy} onStatus={onStatus} />
        {tab.kind === "editor" && <button className="browser-menu-item" role="menuitem" aria-label="Восстановить редактор" title="Перезапустить редактор отдельно"
          disabled={!ready || busy || recoveringEditor} onClick={onRecover}>
          <RefreshCw size={16} className={recoveringEditor ? "spin" : ""} /><span>Восстановить редактор</span>
        </button>}
      </div>
      {vault && !tab.incognito && tab.kind === "web" && <BrowserVaultBar menu tab={tab} vault={vault} ready={ready} onManage={onManageVault} />}
      <div className="browser-settings-menu-row"><button className="browser-menu-item" role="menuitem" disabled={!ready || busy} onClick={() => onSettings('general')}><Settings size={16} />Настройки</button></div>
    </div>
    </div>
    {cookiesOpen && <BrowserCookies key={`${tab.id}:${tab.url}`} tab={tab} onClose={() => { setCookiesOpen(false); toolsTrigger.current?.focus(); }} />}
    {tab.incognito && <p className="browser-private-note">Приватный сеанс · данные сайтов очищаются после закрытия всех приватных вкладок; загрузки и закладки, сохранённые вручную, остаются.</p>}
    {menu}
    {busy && <div className="progress-line" />}
  </header>;
}
