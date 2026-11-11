package usererror

import (
	"context"
	"crypto/x509"
	"errors"
	"io/fs"
	"net"
	"net/url"
	"strings"
	"syscall"
	"testing"
)

func TestKnownFailureIsReadableAndPreservesCause(t *testing.T) {
	for _, tc := range []struct {
		cause  error
		reason string
	}{
		{context.DeadlineExceeded, "истекло"},
		{&url.Error{Op: "GET", URL: "https://user:private@example.com/secret", Err: &net.DNSError{Err: "no such host", Name: "secret.example"}}, "домен"},
		{&fs.PathError{Op: "open", Path: "/private-secret/file", Err: fs.ErrPermission}, "отказал"},
		{syscall.ENOSPC, "недостаточно"},
		{syscall.ECONNREFUSED, "отклонил"},
		{x509.UnknownAuthorityError{}, "сертификат"},
	} {
		err := Wrap("Подключение к источнику обновлений", tc.cause, "Проверьте выбранный прокси.")
		if !strings.Contains(err.Error(), tc.reason) || !strings.Contains(err.Error(), "Подключение к источнику обновлений") || strings.Contains(err.Error(), "private") {
			t.Fatalf("unsafe or vague error: %v", err)
		}
		if !errors.Is(err, tc.cause) {
			t.Fatal("original error identity lost")
		}
	}
	precise := errors.New("Окно отправки закрыто, выберите файл ещё раз")
	if Display("Отправка", precise, "") != precise {
		t.Fatal("specific application message was replaced")
	}
	localized := &fs.PathError{Op: "open", Path: "/Users/тестовый/private-secret", Err: fs.ErrPermission}
	if message := Display("Сохранение конфигурации", localized, "Проверьте права на запись.").Error(); !strings.Contains(message, "отказал") || strings.Contains(message, "private-secret") {
		t.Fatalf("localized system error bypassed safe explanation: %s", message)
	}
}

func TestDisplayDoesNotTrustSensitiveThirdPartyMessages(t *testing.T) {
	for _, text := range []string{
		"Не удалось открыть C:\\Users\\Иван\\private-secret: отказано",
		"Не удалось прочитать /home/ivan/private-secret",
		"Ошибка авторизации: token=private-secret",
		"Подробности https://user:private-secret@example.com/token",
		"Неверный пароль: hunter2",
		"Токен: private-secret",
	} {
		message := Display("Чтение файла", errors.New(text), "Повторите попытку.").Error()
		if strings.Contains(message, "private-secret") || strings.Contains(message, "Иван") || strings.Contains(message, "hunter2") || strings.Contains(message, "/home/") {
			t.Fatalf("untyped Russian error leaked private data: %s", message)
		}
	}
}

func TestFailureUsesNeutralRussianActionFraming(t *testing.T) {
	message := Wrap("Запрос внешнего IP", context.DeadlineExceeded, "Повторите проверку.").Error()
	if !strings.HasPrefix(message, "Запрос внешнего IP: ") || strings.Contains(message, "не выполнено") {
		t.Fatalf("unnatural action framing: %s", message)
	}
}
