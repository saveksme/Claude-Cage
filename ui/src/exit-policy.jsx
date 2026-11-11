import { InlineSelect } from "./inline-select";
import React from "react";
import { Globe2, LoaderCircle } from "lucide-react";
import { canonicalExitPolicy } from "./safety-state.mjs";

const countries =
  "US GB CA DE FR NL SE FI IE CH AU NZ JP SG KR HK MO TW IN BR".split(" ");
const names = new Intl.DisplayNames(["ru"], { type: "region" });

export function ExitPolicyFields({
  value,
  onChange,
  observation,
  onProbe,
  busy,
  probing,
}) {
  const policy = { ...canonicalExitPolicy(), ...value };
  const update = (key, next) => onChange({ ...policy, [key]: next });
  const bind = () =>
    onChange(
      policy.mode === "static"
        ? { ...policy, ip: observation.ip }
        : {
            ...policy,
            country_code: observation.country_code || "",
            ...(policy.scope === "city" || policy.scope === "region"
              ? {
                  region: observation.region || "",
                  ...(policy.scope === "city" ? { city: observation.city || "" } : {}),
                }
              : {}),
          },
    );
  return (
    <>
      <div className="section-title">
        <h3>Правила изменения IP</h3>
        <p>Выход через материковый Китай запрещён; для статического IP и режима «любой регион» также нужно подтвердить страну выхода.</p>
      </div>
      <label className="toggle-row">
        <span>
          <strong>Статический IP</strong>
          <small>Привязка к текущему финальному узлу; при изменении IPv4-адреса того же узла внешняя сеть приостанавливается.</small>
        </span>
        <input
          type="checkbox"
          role="switch"
          checked={policy.mode === "static"}
          onChange={(e) =>
            update("mode", e.target.checked ? "static" : "dynamic")
          }
        />
      </label>
      {policy.mode === "static" ? (
        <label>
          Привязанный IPv4-адрес
          <input
            value={policy.ip}
            placeholder="Определяется и привязывается автоматически при первом использовании этого узла"
            spellCheck="false"
            onChange={(e) => update("ip", e.target.value)}
          />
        </label>
      ) : (
        <>
          <label>
            Допустимый диапазон динамического IP
            <InlineSelect
              aria-label="Допустимый диапазон динамического IP"
              value={policy.scope}
              onValueChange={(next) => update("scope", next)}
            >
              <option value="city">Тот же город</option>
              <option value="region">Тот же регион</option>
              <option value="country">Та же страна/регион</option>
              <option value="any">Любой регион (кроме материкового Китая)</option>
            </InlineSelect>
          </label>
          {policy.scope !== "any" && (
            <>
              <label>
                Код разрешённой страны/региона
                <InlineSelect editable
                  aria-label="Код разрешённой страны/региона"
                  value={policy.country_code}
                  onValueChange={(next) =>
                    update("country_code", next.toUpperCase())
                  }
                  placeholder="Например, US; оставьте пустым для привязки при первом сохранении"
                  maxLength={2}
                  spellCheck="false"
                >
                  {countries.map((code) => (
                    <option key={code} value={code}>
                      {names.of(code)}
                    </option>
                  ))}
                </InlineSelect>
              </label>
              {(policy.scope === "city" || policy.scope === "region") && (
                <div className="field-row">
                  <label>
                    Регион
                    <input
                      value={policy.region}
                      onChange={(e) => update("region", e.target.value)}
                      placeholder="Например, California"
                    />
                  </label>
                  {policy.scope === "city" && (
                    <label>
                      Разрешённый город
                      <input
                        value={policy.city}
                        onChange={(e) => update("city", e.target.value)}
                        placeholder="Например, Los Angeles"
                      />
                    </label>
                  )}
                </div>
              )}
              <p className="field-help">
                {policy.scope === "city"
                  ? "Город проверяется вместе со страной и регионом. Названия берутся из результата геолокации; заполняйте их по результату проверки."
                  : policy.scope === "region"
                    ? "Регион проверяется вместе со страной, включая префектуры Японии. Названия берутся из результата проверки."
                    : "Сначала проверьте выход, затем укажите страну/регион по результату проверки."}
              </p>
            </>
          )}
        </>
      )}
      <div className="probe-line">
        <button disabled={busy} onClick={onProbe}>
          {probing ? (
            <LoaderCircle size={15} className="spin" />
          ) : (
            <Globe2 size={15} />
          )}
          Проверить текущий выход
        </button>
        <button
          disabled={
            busy ||
            !observation ||
            (policy.mode === "dynamic" && policy.scope === "any")
          }
          onClick={bind}
        >
          Заполнить по результату проверки
        </button>
      </div>
      {observation && (
        <div className="exit-observation">
          <strong>
            {observation.country} · {observation.region} · {observation.city}
          </strong>
          <code>{observation.ip}</code>
          <small>
            {observation.country_code} ·{" "}
            {new Date(observation.checked_at).toLocaleTimeString("ru-RU")}
          </small>
        </div>
      )}
      <p className="footnote">
        Правила выхода сохраняются для финального узла и автоматически
        восстанавливаются при переключении узлов; новый узел привязывается после
        проверки при первом использовании. Замена только промежуточного узла,
        повторная проверка или перезапуск сохраняют базовые значения этого узла.
        Внешняя сеть приостанавливается при попадании в материковые диапазоны,
        определении материкового Китая, невозможности подтвердить регион выхода
        или выходе за сохранённый диапазон; офлайн-терминал и файлы остаются
        доступны.
      </p>
      <p className="field-help">
        Диапазон основан на приблизительной геолокации из базы IP-адресов. Сервер
        выполняет выборку примерно каждые 30 секунд; это не заменяет ограничения
        разделения трафика на стороне прокси.
      </p>
    </>
  );
}
