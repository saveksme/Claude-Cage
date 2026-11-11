package cage

import (
	"strings"
	"testing"
	"time"
)

func TestSafetyRejectionExplainsFailedCheck(t *testing.T) {
	report := SafetyReport{Policy: SafetyPolicyVersion, ID: "test", RunID: "run", CheckID: "check", Configuration: "config", CreatedAt: time.Now()}
	for _, id := range requiredSafetyChecks {
		report.Checks = append(report.Checks, SafetyCheck{ID: id, Critical: true, State: CheckPassed, Evidence: "verified", CheckedAt: report.CreatedAt})
	}
	report.Checks[4].State = CheckFailed
	report.Checks[4].Title = "Часовой пояс и язык браузера"
	report.Checks[4].Evidence = "Язык браузера не совпадает с настройками"
	report.Checks[4].Remedy = "Обновите компоненты среды и повторите проверку"
	err := report.Authorizes(report.RunID, report.Configuration, time.Now())
	for _, part := range []string{"Часовой пояс и язык браузера", "Язык браузера не совпадает", "Обновите компоненты среды", "Внешняя сеть остаётся закрытой"} {
		if err == nil || !strings.Contains(err.Error(), part) {
			t.Fatalf("missing actionable failure %q: %v", part, err)
		}
	}
	report.Checks[4].State = CheckUnknown
	report.Checks[4].Evidence = "Не удалось прочитать настройки браузера"
	err = report.Authorizes(report.RunID, report.Configuration, time.Now())
	if err == nil || !strings.Contains(err.Error(), "не удалось подтвердить") {
		t.Fatalf("unknown was presented as a confirmed mismatch: %v", err)
	}
}
