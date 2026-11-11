import React, { useEffect, useRef, useState } from "react";
import { InlineSelect } from "./inline-select";
import "./session-account.css";

const failures = {rate_limit:"Запросы ограничены по частоте. Проверьте квоту и выберите ожидание или продолжение",authentication_failed:"Сеанс входа в аккаунт истёк. Войдите снова",account_on_hold:"Аккаунт ограничен, автопродолжение остановлено",overloaded:"Сервис временно перегружен, исходный аккаунт сохранён",server_error:"Сервис временно недоступен, исходный аккаунт сохранён"};

// Desktop and mobile use the same session operation and durable request ID.
export function SessionAccount({ id, request, onChanged, compact = false }) {
  const [open,setOpen]=useState(false), [view,setView]=useState(null), [busy,setBusy]=useState(false), [error,setError]=useState("");
  const [target,setTarget]=useState(""), [confirmed,setConfirmed]=useState(false), [continueTask,setContinueTask]=useState(false);
  const pending=useRef(null), current=useRef({request,onChanged}); current.current={request,onChanged};
  const terminalID=useRef(null);
  const path="/sessions/"+id+"/account";
  useEffect(() => {
    let live=true,timer;
    const load=async()=>{
      try {
        const result=await current.current.request(path,{body:{action:"inspect"}});
        if(live) {
          setView(result); setTarget(previous=>result.candidates.some(a=>a.id===previous)?previous:(result.candidates[0]?.id || ""));
          const next=result.session.desktop_terminal_id;
          if(terminalID.current && next && next!==terminalID.current)current.current.onChanged?.(result.session);
          terminalID.current=next;
        }
      } catch(e) { if(live && open) setError(e.message); }
      if(live) timer=setTimeout(load,open?2000:10000);
    };
    void load(); return()=>{live=false;clearTimeout(timer);};
  },[id,path,open]);
  const change=async(body)=>{
    if(busy)return; setBusy(true);setError("");
    try {
      const result=await current.current.request(path,{body}); setView(result);current.current.onChanged?.(result.session);
      if(body.action==="switch") {pending.current=null;setConfirmed(false);}
    } catch(e){setError(e.message);} finally{setBusy(false);}
  };
  if(!view?.supported)return null;
  const session=view.session, sw=session.account_switch;
  const switching=sw && sw.phase!=="completed";
  return <section className={`session-account ${compact?"session-account--compact":""}`} aria-label="Аккаунт сеанса">
    <button type="button" className="quiet-button" aria-expanded={open} onClick={()=>setOpen(v=>!v)}>
      {session.account_label || "Аккаунт Claude"} · {session.account_failure?"Требуется действие":switching?"Идёт передача":"Привязан к сеансу"}
    </button>
    {open && <div className="session-account-options">
      <p>Текущий аккаунт: {session.account_label || session.account_id}. При переподключении сеанс сохранит этот аккаунт.</p>
      {session.account_failure && <p role="status">{failures[session.account_failure] || "В этом цикле произошла ошибка, исходный сеанс сохранён"}</p>}
      {sw && <p role="status">{sw.phase==="completed"?"Продолжено в:":"Цель продолжения: "}{sw.target_label}{sw.error && ` · ${sw.error}`}</p>}
      <label>Переключение для этого сеанса<InlineSelect aria-label="Переключение для этого сеанса" disabled={busy || switching} value={view.switch_policy} onValueChange={policy=>change({action:"policy",policy})}>
        <option value="ask">Спрашивать каждый раз</option><option value="allow">Продолжать автоматически после исчерпания квоты</option><option value="wait">Всегда ждать исходный аккаунт</option>
      </InlineSelect></label>
      {!switching && <>
        <label>Аккаунт для продолжения<InlineSelect aria-label="Аккаунт для продолжения" value={target} disabled={busy || !view.candidates.length} onValueChange={value=>{setTarget(value);setConfirmed(false);pending.current=null;}}>
          {view.candidates.length?view.candidates.map(a=><option key={a.id} value={a.id}>{a.label}</option>):<option value="">Нет доступных аккаунтов</option>}
        </InlineSelect></label>
        {!view.candidates.length && <p>В настройках аккаунтов объедините аккаунты, которым разрешено совместно использовать историю сеансов, в одну группу продолжения.</p>}
        <p>Историю продолжит обрабатывать целевой аккаунт; кэш может быть перестроен. Выполняемые инструменты, фоновые задачи и неподтверждённые результаты блокируют переключение.</p>
        <label className="check-line"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)} />Разрешить передать историю этого сеанса выбранному аккаунту</label>
        <label className="check-line"><input type="checkbox" checked={continueTask} onChange={e=>{setContinueTask(e.target.checked);pending.current=null;}} />Продолжить незавершённые задачи после восстановления</label>
        <button type="button" disabled={busy || !target || !confirmed} onClick={()=>{
          pending.current ||= {action:"switch",target,request_id:crypto.randomUUID(),source_id:view.source_id,confirm:true,continue:continueTask};
          void change(pending.current);
        }}>{busy?"Идёт передача…":"Переключить и восстановить историю"}</button>
      </>}
      {switching && sw.phase!=="starting" && <button disabled={busy} onClick={()=>change({action:"switch",request_id:sw.id,source_id:view.source_id,target,confirm:true})}>Повторить передачу аккаунта</button>}
      {switching && sw.phase==="preparing" && <button disabled={busy} onClick={()=>change({action:"cancel",request_id:sw.id})}>Отменить передачу и сохранить исходный аккаунт</button>}
      {switching && sw.phase==="starting" && <p>Ожидание подключения целевого аккаунта. Оставьте текущую страницу открытой или откройте сеанс заново из списка сеансов.</p>}
      {error && <p role="alert">{error}</p>}
    </div>}
  </section>;
}
