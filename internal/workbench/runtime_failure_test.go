package workbench

import (
	"fmt"
	"os"
	"strings"
	"testing"
)

func TestRunCagePreservesOriginalVMError(t *testing.T) {
	if os.Getenv("CAGE_TEST_START_FAILURE_HELPER") == "1" {
		fmt.Fprintln(os.Stderr, "Error: Запуск QEMU не удался: WHPX: Failed to enable nested virtualization, hr=80370302 token=private-test-token")
		fmt.Fprintln(os.Stderr, "Error: Failed to start base VM. Full log: local diagnostic logs")
		os.Exit(7)
	}
	t.Setenv("CAGE_TEST_START_FAILURE_HELPER", "1")
	s := testServer(t)
	if err := writePrivate(s.profile+string(os.PathSeparator)+"environment.json", map[string]string{"directory": t.TempDir()}); err != nil {
		t.Fatal(err)
	}
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	s.exe = exe
	if _, err := s.submitJob("setup", func() error { return s.runCage("-test.run=^TestRunCagePreservesOriginalVMError$") }); err != nil {
		t.Fatal(err)
	}
	job := awaitJobIdle(t, &s.jobs)
	if !strings.Contains(job.Error, "80370302") || strings.Contains(job.Error, "private-test-token") || !strings.Contains(job.Log, "Failed to start base VM") {
		t.Fatalf("lost or exposed the original error: %+v", job)
	}
}

func TestRunCageExplainsCommonFailure(t *testing.T) {
	if output := os.Getenv("CAGE_TEST_READABLE_FAILURE"); output != "" {
		fmt.Fprintln(os.Stderr, output)
		os.Exit(7)
	}
	for _, tc := range []struct{ output, want string }{
		{"curl: (28) Operation timed out", "истекло время ожидания"},
		{"E: No space left on device", "недостаточно места"},
		{"curl: (60) certificate verify failed", "сертификат"},
		{"Error: Base VM not found. Run 'agent-vm setup' first.", "отсутствует базовый шаблон"},
		{"Error: Base VM setup did not complete. Run 'agent-vm setup' again.", "установка базового шаблона ещё не завершена"},
		{"CAGE_WINDOWS_MAINTENANCE_HOST_MANAGER synthetic stage token=private-error-secret", "установка системного помощника Windows"},
		{"CAGE_WINDOWS_MAINTENANCE_GUEST_CONNECTION synthetic stage token=private-error-secret", "подключение к гостевой системе Windows"},
		{"unrecognized failure token=private-error-secret", "код 7"},
	} {
		t.Run(tc.want, func(t *testing.T) {
			t.Setenv("CAGE_TEST_READABLE_FAILURE", tc.output)
			s := testServer(t)
			if err := writePrivate(s.profile+string(os.PathSeparator)+"environment.json", map[string]string{"directory": t.TempDir()}); err != nil {
				t.Fatal(err)
			}
			exe, err := os.Executable()
			if err != nil {
				t.Fatal(err)
			}
			s.exe = exe
			if _, err := s.submitJob("setup", func() error { return s.runCage("-test.run=^TestRunCageExplainsCommonFailure$") }); err != nil {
				t.Fatal(err)
			}
			job := awaitJobIdle(t, &s.jobs)
			if !strings.Contains(job.Error, tc.want) || strings.Contains(job.Error, "private-error-secret") || !strings.Contains(job.Message, "подготовка среды") {
				t.Fatalf("missing readable operation failure: %+v", job)
			}
		})
	}
}
