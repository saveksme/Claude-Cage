package cage

import (
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/sylvinus/agent-vm/internal/diagnostics"
	"github.com/sylvinus/agent-vm/internal/exitpolicy"
)

// SafetyPolicyVersion changes when the mandatory evidence contract changes.
// Reports authorize one running VM with one applied configuration.
const SafetyPolicyVersion = "cage-safety/3"
const SafetyReportLifetime = 24 * time.Hour

type CheckState = exitpolicy.State

const (
	CheckPassed  = exitpolicy.Passed
	CheckFailed  = exitpolicy.Failed
	CheckUnknown = exitpolicy.Unknown
)

type SafetyCheck struct {
	ID        string     `json:"id"`
	Title     string     `json:"title"`
	State     CheckState `json:"state"`
	Critical  bool       `json:"critical"`
	Evidence  string     `json:"evidence"`
	Remedy    string     `json:"remedy,omitempty"`
	CheckedAt time.Time  `json:"checked_at"`
}

type SafetyReport struct {
	Policy        string        `json:"policy"`
	ID            string        `json:"id"`
	RunID         string        `json:"run_id"`
	CheckID       string        `json:"check_id"`
	Configuration string        `json:"configuration"`
	CreatedAt     time.Time     `json:"created_at"`
	Checks        []SafetyCheck `json:"checks"`
}

var requiredSafetyChecks = [...]string{
	"egress_policy", "proxy_transport", "dns_transport", "guest_settings",
	"browser_settings", "filesystem_boundary", "management_boundary",
	"fail_closed", "udp_policy", "ipv6_policy", "exit_consistency",
}

// Authorizes rejects missing, duplicate, unknown, stale or mismatched evidence.
// The required IDs are defined here, never supplied by the frontend or a provider.
func (r SafetyReport) Authorizes(runID, configuration string, now time.Time) error {
	if r.Policy != SafetyPolicyVersion || r.ID == "" || r.CheckID == "" || runID == "" || configuration == "" ||
		r.RunID != runID || r.Configuration != configuration {
		return errors.New("Отчёт проверки не относится к текущей конфигурации среды. Повторите проверку")
	}
	if r.CreatedAt.IsZero() || r.CreatedAt.After(now.Add(time.Minute)) || !now.Before(r.CreatedAt.Add(SafetyReportLifetime)) {
		return errors.New("Срок действия отчёта проверки истёк. Повторите проверку")
	}
	seen := make(map[string]SafetyCheck, len(r.Checks))
	for _, check := range r.Checks {
		if _, duplicate := seen[check.ID]; duplicate {
			return errors.New("Отчёт проверки содержит повторяющиеся пункты")
		}
		if check.State != CheckPassed && check.State != CheckFailed && check.State != CheckUnknown {
			return errors.New("Недопустимое состояние проверки")
		}
		seen[check.ID] = check
		if check.Critical && check.State != CheckPassed {
			state := "не пройдена"
			if check.State == CheckUnknown {
				state = "не удалось подтвердить"
			}
			title := safetyCheckTitle(check)
			evidence := strings.TrimRight(diagnostics.Redact(check.Evidence), "。；;")
			if evidence == "" {
				evidence = "результат проверки не получен"
			}
			next := strings.TrimRight(diagnostics.Redact(check.Remedy), "。；;")
			if next == "" {
				next = "Откройте «Список проверок», чтобы увидеть результат этого пункта, и повторите проверку; если снова не удастся, экспортируйте диагностический пакет в настройках"
			}
			return fmt.Errorf("Проверка «%s»: %s. %s. %s. Внешняя сеть остаётся закрытой.", title, state, evidence, next)
		}
	}
	for _, id := range requiredSafetyChecks {
		check, found := seen[id]
		if !found || !check.Critical || check.State != CheckPassed || check.Evidence == "" ||
			check.CheckedAt.Before(r.CreatedAt) || check.CheckedAt.After(now.Add(time.Minute)) {
			return fmt.Errorf("Для сетевой проверки не хватает действительных доказательств: запись «%s» отсутствует, устарела или неполна. Повторите проверку; если снова не удастся, экспортируйте диагностический пакет в настройках. Внешняя сеть остаётся закрытой.", safetyCheckTitle(SafetyCheck{ID: id}))
		}
	}
	return nil
}

func safetyCheckTitle(check SafetyCheck) string {
	if check.Title != "" && check.Title != check.ID {
		return check.Title
	}
	titles := map[string]string{
		"egress_policy": "Ограничения исходящих соединений среды", "proxy_transport": "Подключение через прокси", "dns_transport": "Разрешение DNS", "guest_settings": "Часовой пояс и язык системы", "browser_settings": "Часовой пояс и язык браузера", "filesystem_boundary": "Общий каталог проекта", "management_boundary": "Изоляция интерфейса управления хостом", "fail_closed": "Отключение при сбое прокси", "udp_policy": "Ограничения исходящего UDP", "ipv6_policy": "Ограничения исходящего IPv6", "exit_consistency": "Внешний IP и регион",
	}
	if title := titles[check.ID]; title != "" {
		return title
	}
	return "Обязательный пункт проверки"
}
