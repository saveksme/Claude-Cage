import React, { useEffect, useState } from "react";
import { Activity } from "lucide-react";
import { api } from "./api";

export function NetworkLatency({ enabled, revision, selected }) {
  const [sample, setSample] = useState(null),
    [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false,
      timer;
    const measure = async () => {
      try {
        const proxy = await api("/proxy");
        if (cancelled) return;
        if (!proxy.active || !proxy.running || !proxy.selected) {
          setSample({ label: "Задержка —", detail: "Текущий прокси не подключён" });
        } else {
          const result = await api("/proxy/delay", { node_id: proxy.selected });
          if (cancelled) return;
          const current = await api("/proxy");
          if (cancelled) return;
          if (
            !current.active ||
            !current.running ||
            current.selected !== proxy.selected ||
            current.revision !== proxy.revision
          ) {
            setSample(null);
          } else if (Number.isFinite(result.delay) && result.delay > 0) {
            setSample({
              label: `${Math.round(result.delay)} ms`,
              detail:
                "HTTP-задержка текущего узла до www.gstatic.com (единая методика); обычно не включает установку соединения и не показывает время первого открытия страницы. Обновляется каждые 30 секунд, нажмите для повторной проверки; состояние доступа среды проверяется отдельно.",
            });
          } else {
            setSample({
              label: "Задержка недоступна",
              detail: "Не удалось измерить задержку текущего узла, нажмите для повтора",
            });
          }
        }
      } catch {
        if (!cancelled)
          setSample({
            label: "Задержка недоступна",
            detail: "Не удалось измерить задержку текущего узла, нажмите для повтора",
          });
      } finally {
        if (!cancelled) timer = setTimeout(measure, 30000);
      }
    };
    measure();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [enabled, revision, selected, retry]);
  return (
    <button
      className="status-latency"
      aria-label={`Сетевая задержка: ${enabled ? sample?.label || "проверка" : "не подключено"}`}
      title={
        enabled
          ? sample?.detail || "Проверка сетевой задержки текущего узла"
          : "Сетевая задержка проверяется после запуска среды и подключения прокси"
      }
      disabled={!enabled}
      onClick={() => {
        setSample(null);
        setRetry((value) => value + 1);
      }}
    >
      <Activity size={12} />
      <span>{enabled ? sample?.label || "Измерение задержки…" : "Задержка —"}</span>
    </button>
  );
}
