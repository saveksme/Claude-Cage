import React, { useEffect, useRef, useState } from 'react';
import { Download, ExternalLink, FolderInput, Puzzle, RefreshCw, Trash2, Upload, X } from 'lucide-react';
import { api, uploadFile } from './api';
import { assertConnection, getClientContext } from './client-context.mjs';
import { InlineSelect } from './inline-select';

function Permissions({ item, expanded = false }) {
  const permissions = [...(item.permissions || []), ...(item.hostPermissions || [])];
  return <details className="extension-permissions" open={expanded || undefined}><summary>Разрешения и доступ к сайтам{permissions.length ? ` (${permissions.length})` : ''}</summary>
    {permissions.length ? <ul>{permissions.map((value, index) => <li key={index}>{value}</li>)}</ul> : <p>Дополнительные разрешения не заявлены.</p>}</details>;
}

function LocalExtensionImport({ existing, onUpdated, onClose }) {
  const [profiles, setProfiles] = useState(null), [profileID, setProfileID] = useState('');
  const [selected, setSelected] = useState(new Set()), [results, setResults] = useState({});
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const alive = useRef(true);
  useEffect(() => {
    api('/client/browser-extensions').then(data => { if (alive.current) { setProfiles(data.profiles); setProfileID(data.profiles[0]?.id || ''); } })
      .catch(error => { if (alive.current) setError(error.message); });
    return () => { alive.current = false; };
  }, []);
  const profile = profiles?.find(item => item.id === profileID);
  const installed = new Set(existing.map(item => item.source));
  const completed = Object.values(results).some(value => value.startsWith('Импортировано'));
  const eligible = item => item.compatible && !installed.has(`${profileID}:${item.id}`);
  const importCount = profile?.extensions.filter(item => selected.has(item.id) && eligible(item)).length || 0;
  const choose = value => { setProfileID(value); setSelected(new Set()); setResults({}); setError(''); };
  const importSelected = async () => {
    if (busy || !profile) return;
    const connection = getClientContext().connection_id;
    setBusy(true); setError('');
    for (const item of profile.extensions.filter(item => selected.has(item.id) && eligible(item))) {
      let pending;
      try {
        assertConnection(connection);
        if (!alive.current) break;
        setResults(previous => ({ ...previous, [item.id]: 'Импорт…' }));
        const response = await fetch('/api/client/browser-extensions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ profile: profileID, id: item.id, version: item.version }) });
        if (!response.ok) throw new Error((await response.text()).trim());
        const file = new File([await response.blob()], item.id + '.zip', { type: 'application/zip' });
        assertConnection(connection);
        if (!alive.current) break;
        pending = await uploadFile('/browser/extensions/upload', file);
        assertConnection(connection);
        if (!alive.current) throw new Error('Импорт остановлен');
        const next = await api('/browser/extensions', { mode: 'install', session: pending.session, target: `${profileID}:${item.id}`, enabled: item.state_known && item.enabled });
        pending = null;
        if (alive.current) { onUpdated(next.items); setResults(previous => ({ ...previous, [item.id]: item.state_known && item.enabled ? 'Импортировано и включено' : 'Импортировано, остаётся отключённым' })); }
      } catch (error) {
        if (pending && getClientContext().connection_id === connection) await api('/browser/extensions', { mode: 'cancel', session: pending.session }).catch(() => {});
        if (alive.current) setResults(previous => ({ ...previous, [item.id]: 'Не удалось импортировать: ' + error.message }));
        if (getClientContext().connection_id !== connection) break;
      }
    }
    if (alive.current) setBusy(false);
  };
  return <section className="extension-import" aria-label="Импорт расширений с этого компьютера">
    <div className="browser-setting-heading"><h3>Импорт из браузера на этом компьютере</h3><button className="icon-button" aria-label="Закрыть импорт с этого компьютера" disabled={busy} onClick={onClose}><X size={16} /></button></div>
    <p>Выбранные расширения и их состояние копируются за один раз. Аккаунты браузера, Cookie и данные входа расширений остаются в браузере на этом компьютере.</p>
    {error && <p className="browser-settings-error" role="alert">{error}</p>}
    {!profiles && !error && <p role="status">Поиск профилей браузера на этом компьютере…</p>}
    {profiles?.length === 0 && <p>Не найдены профили расширений Edge, Chrome, Brave или Chromium.</p>}
    {Boolean(profiles?.length) && <>
      <label className="browser-setting-field">Профиль браузера на этом компьютере<InlineSelect aria-label="Профиль браузера на этом компьютере" value={profileID} disabled={busy} onValueChange={choose}>
        {profiles.map(item => <option value={item.id} key={item.id}>{item.browser} · {item.name}</option>)}
      </InlineSelect></label>
      <div className="extension-import-actions"><button disabled={busy} onClick={() => setSelected(new Set(profile?.extensions.filter(eligible).map(item => item.id)))}>Выбрать все совместимые расширения</button>
        {completed && !busy && !importCount ? <button className="primary" onClick={onClose}>Готово, закрыть</button> : <button className="primary" disabled={busy || !importCount} onClick={importSelected}><Download size={15} />{busy ? 'Импорт…' : `Импортировать выбранные расширения (${importCount})`}</button>}</div>
      {!profile?.extensions.length && <p>В этом профиле нет доступных расширений.</p>}
      {profile?.extensions.map(item => <article className="extension-import-row" key={item.id}>
        <label><input type="checkbox" disabled={busy || !eligible(item)} checked={selected.has(item.id)} onChange={event => setSelected(previous => { const next = new Set(previous); if (event.target.checked) next.add(item.id); else next.delete(item.id); return next; })} />
          <strong>{item.name}</strong><span>{item.version}</span></label>
        <p className="extension-import-state" role={results[item.id] ? 'status' : undefined}>{results[item.id] || (!item.compatible ? 'Эта версия расширения не поддерживается; поддерживается только Manifest V3' : installed.has(`${profileID}:${item.id}`) ? 'Импортировано' : !item.state_known ? 'Не удалось прочитать состояние; после импорта будет отключено' : item.enabled ? 'Включено на этом компьютере' : 'Отключено на этом компьютере')}</p>
        {item.compatible && !item.identity_preserved && <p>Идентификатор расширения может измениться; функции, зависящие от идентичности браузера или авторизации, могут потребовать повторной настройки.</p>}
        <Permissions item={item} />
      </article>)}
    </>}
  </section>;
}

export function BrowserExtensions({ onOpenPage, onInternal, onConfirm }) {
  const [items, setItems] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState('');
  const [preview, setPreview] = useState(null), [importing, setImporting] = useState(false);
  const file = useRef(), alive = useRef(true), pending = useRef(null);
  const connection = useRef(getClientContext().connection_id);
  const load = async () => {
    setError('');
    try { const result = await api('/browser/extensions', { mode: 'list' }); if (alive.current) setItems(result.items); }
    catch (error) { if (alive.current) setError(error.message); }
  };
  useEffect(() => {
    void load();
    return () => { alive.current = false; if (pending.current && getClientContext().connection_id === connection.current) void api('/browser/extensions', { mode: 'cancel', session: pending.current }).catch(() => {}); };
  }, []);
  const select = async event => {
    const selected = event.target.files?.[0]; event.target.value = '';
    if (!selected) return;
    if (selected.size > 32 << 20) { setError('ZIP-архив расширения не должен превышать 32 МБ'); return; }
    setBusy('upload'); setError('');
    try {
      const result = await uploadFile('/browser/extensions/upload', selected);
      if (!alive.current) { if (getClientContext().connection_id === connection.current) await api('/browser/extensions', { mode: 'cancel', session: result.session }); return; }
      pending.current = result.session; setPreview(result);
    } catch (error) { if (alive.current) setError(error.message); }
    finally { if (alive.current) setBusy(''); }
  };
  const act = async (mode, id) => {
    if (busy) return;
    if (mode === 'remove' && !(await onConfirm({ title: 'Удалить это расширение?', body: 'Расширение будет удалено из браузера Cage. Расширения в Edge или Chrome на этом компьютере останутся без изменений.', confirm: 'Удалить расширение' }))) return;
    setBusy(id || mode); setError('');
    try {
      const result = await api('/browser/extensions', { mode, id, ...(mode === 'install' ? { session: preview.session } : {}) });
      if (mode === 'install' || mode === 'cancel') { pending.current = null; setPreview(null); }
      if (result.native) await onInternal('extensions', result.id);
      else if (result.id && result.url) await onOpenPage(result);
      else if (result.items) setItems(result.items);
    } catch (error) { setError(error.message); }
    finally { setBusy(''); }
  };
  const cancel = async () => {
    setBusy('cancel'); setError('');
    try { await api('/browser/extensions', { mode: 'cancel', session: preview.session }); pending.current = null; setPreview(null); }
    catch (error) { setError(error.message); }
    finally { setBusy(''); }
  };
  return <div className="browser-extensions">
    <div className="browser-setting-actions">
      <button className="primary" disabled={Boolean(busy || preview)} onClick={() => file.current?.click()}><Upload size={15} />Добавить расширение из ZIP</button>
      <button disabled={Boolean(busy || preview)} onClick={() => setImporting(true)}><FolderInput size={15} />Импорт с этого компьютера</button>
      <button aria-label="Обновить расширения" disabled={Boolean(busy)} onClick={load}><RefreshCw size={15} /></button>
    </div>
    <input ref={file} type="file" accept=".zip,application/zip" hidden onChange={select} aria-label="Выбрать ZIP-архив расширения" />
    <p>Поддерживаются расширения Chromium Manifest V3. Расширения работают в среде Cage и обращаются к сайтам в пределах заявленных разрешений.</p>
    {error && <p className="browser-settings-error" role="alert">{error}</p>}
    {busy === 'upload' && <p role="status">Чтение пакета расширения…</p>}
    {preview && <section className="extension-install-preview" aria-label="Подтверждение установки расширения">
      <h3>Подтвердите установку {preview.name}</h3><p>Версия {preview.version}</p><p>{preview.description}</p>
      <Permissions item={preview} expanded />
      <div className="browser-setting-actions"><button className="primary" disabled={Boolean(busy)} onClick={() => act('install')}>Установить расширение</button><button disabled={Boolean(busy)} onClick={cancel}>Отмена</button></div>
    </section>}
    {importing && <LocalExtensionImport existing={items || []} onUpdated={setItems} onClose={() => setImporting(false)} />}
    <div className="browser-setting-heading"><h3>Установленные расширения{items ? ` (${items.length})` : ''}</h3></div>
    {items === null && !error ? <p role="status">Чтение расширений…</p> : items?.length === 0 ? <div className="extension-empty"><Puzzle size={28} /><strong>Сделайте браузер удобнее</strong><p>Добавьте расширения или импортируйте их из браузера на этом компьютере.</p></div> : items?.map(item => <article className="extension-item" key={item.id}>
      <div className="browser-setting-heading"><div><strong>{item.name}</strong><span className="extension-version">{item.version}</span></div>
        <label className="extension-enable"><input type="checkbox" aria-label={`Включить ${item.name}`} checked={Boolean(item.enabled)} disabled={Boolean(busy) || item.mayDisable === false} onChange={() => act(item.enabled ? 'disable' : 'enable', item.id)} />{item.enabled ? 'Включено' : 'Отключено'}</label></div>
      {item.description && <p>{item.description}</p>}{item.error && <p role="alert" className="browser-settings-error">{item.error}</p>}
      <Permissions item={item} />
      <div className="extension-item-footer"><span>{item.id}</span><div className="browser-setting-actions">
        {item.optionsUrl && <button disabled={Boolean(busy) || !item.enabled} onClick={() => act('options', item.id)}>Параметры расширения</button>}
        <button disabled={Boolean(busy) || item.mayDisable === false} onClick={() => act('remove', item.id)}><Trash2 size={14} />{item.managed ? 'Удалить' : 'Управление'}</button>
      </div></div>
    </article>)}
    <div className="browser-settings-links"><button onClick={() => onInternal('extensions')}><ExternalLink size={15} />Управление расширениями Chromium</button>
      <button onClick={() => onOpenPage({ url: 'https://chromewebstore.google.com/', kind: 'web' })}><ExternalLink size={15} />Открыть магазин расширений</button></div>
  </div>;
}
