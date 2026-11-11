import React, { useEffect, useState } from 'react';
import { Globe2, Info, LayoutPanelLeft, Puzzle, Search, ShieldCheck, ExternalLink } from 'lucide-react';
import { api } from './api';
import { InlineSelect } from './inline-select';
import { BrowserCookies } from './browser-cookies';
import { BrowserExtensions } from './browser-extensions';
import './browser-settings.css';

const sections = [
  { id: 'general', title: 'Новая вкладка', icon: Globe2, search: 'запуск новая вкладка домашняя стартовая адрес сайт' },
  { id: 'appearance', title: 'Внешний вид', icon: LayoutPanelLeft, search: 'внешний вид панель вкладок макет горизонтально вертикально' },
  { id: 'privacy', title: 'Конфиденциальность и данные сайтов', icon: ShieldCheck, search: 'конфиденциальность cookie данные сайтов разрешения очистка история' },
  { id: 'extensions', title: 'Расширения', icon: Puzzle, search: 'расширения плагины управление установка импорт edge chrome' },
  { id: 'about', title: 'О браузере', icon: Info, search: 'о браузере chromium версия' },
];
export function BrowserSettingsPage({ tab, tabs, currentHome, layout, onLayoutChange, onSaved, onInternal, onOpenPage, onConfirm, onSectionChange }) {
  const [section, setSection] = useState(tab.url.split('#')[1] || 'general'), [query, setQuery] = useState('');
  const [home, setHome] = useState(currentHome || 'https://www.bing.com/'), [savedHome, setSavedHome] = useState(currentHome || 'https://www.bing.com/');
  const [saving, setSaving] = useState(false), [error, setError] = useState(''), [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);
  const [cookieSession, setCookieSession] = useState('normal');
  const [info, setInfo] = useState(null);
  useEffect(() => { let live = true; api('/browser/info', {}).then(value => { if (live) setInfo(value); }).catch(() => { if (live) setInfo({ error: true }); }); return () => { live = false; }; }, []);
  useEffect(() => { const next = tab.url.split('#')[1]; if (sections.some(item => item.id === next)) { setSection(next); setQuery(''); } }, [tab.url]);
  useEffect(() => {
    let live = true;
    api('/browser/preferences').then(result => { if (live) { setHome(result.browser_home_url); setSavedHome(result.browser_home_url); } }).catch(error => { if (live) setError(error.message); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, []);
  const changeSection = id => { setSection(id); setQuery(''); onSectionChange?.(id); };
  const save = async event => {
    event.preventDefault(); setSaving(true); setError(''); setSaved(false);
    try { const result = await api('/browser/preferences', { browser_home_url: home }); setHome(result.browser_home_url); setSavedHome(result.browser_home_url); setSaved(true); onSaved(result); }
    catch (error) { setError(error.message); }
    finally { setSaving(false); }
  };
  const privateTab = tabs.find(item => item.incognito && !item.login);
  const cookieTab = cookieSession === 'private' && privateTab ? privateTab : tab;
  const visible = query.trim() ? sections.filter(item => `${item.title} ${item.search}`.toLowerCase().includes(query.trim().toLowerCase())) : sections.filter(item => item.id === section);
  return <section className="browser-settings-page" aria-label="Настройки браузера">
    <header className="browser-settings-top"><h1>Настройки</h1><label className="browser-settings-search"><Search size={16} /><input aria-label="Поиск по настройкам браузера" placeholder="Поиск настроек" value={query} onChange={event => setQuery(event.target.value)} /></label></header>
    <div className="browser-settings-layout">
      <nav className="browser-settings-nav" aria-label="Разделы настроек браузера">{sections.map(({ id, title, icon: Icon }) => <button key={id} aria-label={title} aria-description={id === 'general' && home !== savedHome ? 'Есть несохранённые изменения' : undefined} aria-current={!query && section === id ? 'page' : undefined} onClick={() => changeSection(id)}><Icon size={17} /><span>{title}</span>{id === 'general' && home !== savedHome && <span className="settings-unsaved-dot" title="Есть несохранённые изменения" />}</button>)}</nav>
      <div className="browser-settings-compact-nav"><InlineSelect aria-label="Разделы настроек браузера" value={section} onValueChange={changeSection}>
        {sections.map(item => <option value={item.id} key={item.id}>{item.title}</option>)}
      </InlineSelect></div>
      <div className="browser-settings-content">
        {visible.length === 0 && <div className="browser-settings-no-results"><Search size={24} /><h2>Настройки не найдены</h2><p>Попробуйте «вкладки», «Cookie» или «расширения».</p></div>}
        {visible.map(item => <section key={item.id} className="browser-settings-section" aria-label={item.title}>
          <h2>{item.title}</h2>
          {item.id === 'general' && <><p>Задайте сайт, который открывается при создании новой страницы.</p><form className="browser-setting-form" onSubmit={save}>
            <label className="browser-setting-field">Адрес новой вкладки<input type="url" aria-label="Адрес новой вкладки" required maxLength={8192} value={home} disabled={saving || loading} spellCheck="false" autoComplete="off" onChange={event => { setHome(event.target.value); setSaved(false); }} /></label>
            <p>Обычные и приватные вкладки используют один и тот же адрес по умолчанию. После сохранения он сразу применяется к новым страницам.</p>
            <div className="browser-setting-actions"><button className="primary" disabled={saving || loading || home === savedHome}>{saving ? 'Сохранение…' : 'Сохранить адрес'}</button>{saved && <span role="status">Сохранено</span>}</div>
            {error && <p className="browser-settings-error" role="alert">{error}</p>}
          </form></>}
          {item.id === 'appearance' && <><p>Настройте панель вкладок страниц и редактора файлов.</p><div className="browser-setting-row"><div><h3>Макет панели вкладок</h3><p>Применяется сразу и сохраняется на этом компьютере.</p></div><InlineSelect aria-label="Макет панели вкладок" value={layout} onValueChange={onLayoutChange}><option value="horizontal">Горизонтально (сверху)</option><option value="vertical">Вертикально (слева)</option></InlineSelect></div><p>Страница настроек браузера использует текущие шрифт и цветовую схему Cage.</p></>}
          {item.id === 'privacy' && <><p>Управляйте данными и разрешениями сайтов, сохранёнными в текущем сеансе браузера.</p>
            <div className="browser-setting-row"><div><h3>Cookie и состояние входа</h3><p>Обычный и приватный сеансы управляются отдельно.</p></div><InlineSelect aria-label="Сеанс браузера для Cookie" value={cookieSession} onValueChange={setCookieSession}><option value="normal">Обычный сеанс</option><option value="private" disabled={!privateTab}>Приватный сеанс</option></InlineSelect></div>
            <BrowserCookies key={cookieTab.id} tab={cookieTab} onClose={() => changeSection('general')} />
            <div className="browser-settings-links"><button onClick={() => onInternal('permissions')}><ExternalLink size={15} />Разрешения сайтов</button><button onClick={() => onInternal('clear')}><ExternalLink size={15} />Очистить данные обычного сеанса</button></div>
          </>}
          {item.id === 'extensions' && <><p>Добавляйте расширения для браузера Cage и управляйте ими.</p><BrowserExtensions onInternal={onInternal} onOpenPage={onOpenPage} onConfirm={onConfirm} /></>}
          {item.id === 'about' && <><p>Браузер Cage работает на Chromium внутри среды. Страницы, расширения и данные сайтов сохраняются вместе с текущей средой Cage.</p><div className="browser-setting-row"><div><h3>Браузерный движок</h3><p>{info?.product || (info?.error ? 'Информация о версии недоступна' : 'Чтение версии…')}</p></div></div><p>Загруженные файлы сохраняются Cage в папку Downloads рабочей среды по умолчанию; из панели загрузок их можно сохранить в другое место.</p></>}

        </section>)}
      </div>
    </div>
  </section>;
}
