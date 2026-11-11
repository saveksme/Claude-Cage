package workbench

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestWindowsMaintenanceFailureRetainsStageForBothJobs(t *testing.T) {
	cause := errors.New("synthetic maintenance process failed")
	for _, action := range []string{"восстановление системного помощника Windows", "обновление нативных компонентов гостевой системы"} {
		for _, test := range []struct {
			phase, reason, next string
		}{
			{"AUTHORIZATION_CANCELED", "авторизация администратора Windows отменена", "окне авторизации Windows"},
			{"AUTHORIZATION", "окно авторизации администратора Windows не открылось", "учётную запись Windows"},
			{"VALIDATION", "привязка среды Windows или список компонентов", "переустановите приложение Cage"},
			{"HOST_MANAGER", "установка системного помощника Windows", "восстановление системного помощника"},
			{"GUEST_CONNECTION", "подключение к гостевой системе Windows", "учётной записью администратора"},
			{"GUEST_COMPONENTS", "установка компонентов гостевой системы Windows", "синхронизацию компонентов"},
			{"HOST_RELAY", "обновление компонента подключения хост-системы Windows", "компонент подключения"},
			{"PACKAGE_PREPARATION", "подготовка пакета компонентов Windows", "системном диске"},
			{"FAILED", "обслуживание Windows не завершено", "диагностический пакет"},
		} {
			t.Run(action+"/"+test.phase, func(t *testing.T) {
				output := "CAGE_WINDOWS_MAINTENANCE_" + test.phase + " synthetic stage\naccess is denied token=private-stage-secret"
				err := executionFailure(action, cause, output)
				for _, want := range []string{action, test.reason, test.next} {
					if !strings.Contains(err.Error(), want) {
						t.Fatalf("lost maintenance stage or next action %q: %v", want, err)
					}
				}
				if !errors.Is(err, cause) || strings.Contains(err.Error(), "private-stage-secret") {
					t.Fatal("stage handling lost the cause or exposed arbitrary process output", err)
				}
			})
		}
	}
}

func TestBrowserFailureExplainsOperationAndKnownCause(t *testing.T) {
	for _, tc := range []struct {
		status     int
		body, want string
	}{
		{400, `{"error":"Tab no longer exists"}`, "Вкладка закрыта"},
		{401, `{"error":"private token=do-not-display"}`, "авторизацию"},
		{503, `{"error":"private token=do-not-display"}`, "не готова"},
		{500, `{"error":"private token=do-not-display"}`, "HTTP 500"},
	} {
		t.Run(fmt.Sprint(tc.status), func(t *testing.T) {
			guest := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(tc.body))
			}))
			defer guest.Close()
			client := localBrowserClient(t, context.Background(), guest)
			defer client.close()
			_, err := client.request(context.Background(), "test-token", "POST", "/navigate", []byte(`{}`))
			if err == nil || !strings.Contains(err.Error(), tc.want) || strings.Contains(err.Error(), "do-not-display") {
				t.Fatalf("wrong user failure: %v", err)
			}
		})
	}
}

func TestFileServiceRetainsKnownRejectionAndHidesUnknownBody(t *testing.T) {
	known := fileServiceFailure(400, []byte("Окно загрузки закрыто. Выберите файл заново"))
	if !strings.Contains(known.Error(), "Окно загрузки закрыто") || !strings.Contains(known.Error(), "нажмите кнопку загрузки") {
		t.Fatalf("file window reason lost: %v", known)
	}
	unknown := fileServiceFailure(500, []byte("unknown response token=private-file-secret"))
	if !strings.Contains(unknown.Error(), "HTTP 500") || strings.Contains(unknown.Error(), "private-file-secret") {
		t.Fatalf("unsafe unknown response: %v", unknown)
	}
}
