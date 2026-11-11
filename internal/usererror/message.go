// Package usererror describes known system failures without exposing raw
// command arguments, network responses or credentials in the user interface.
package usererror

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"syscall"
	"unicode"
)

type failure struct {
	message string
	cause   error
}

func (e *failure) Error() string { return e.message }
func (e *failure) Unwrap() error { return e.cause }

func New(action, reason, next string, cause error) error {
	return &failure{message: action + " не выполнено: " + strings.TrimRight(reason, "。；;.") + ". " + next, cause: cause}
}

func Wrap(action string, cause error, next string) error {
	if cause == nil {
		return nil
	}
	reason := Reason(cause)
	if reason == "" {
		reason = "не удалось определить причину ошибки"
	}
	return New(action, reason, next, cause)
}

// Existing localized validation messages describe product rules and must survive
// unchanged. Unknown system exceptions receive an operation and a next step.
func Display(action string, cause error, next string) error {
	if cause == nil {
		return nil
	}
	switch cause.(type) {
	case *fs.PathError, *os.SyscallError, syscall.Errno, *exec.ExitError, net.Error:
		return Wrap(action, cause, next)
	}
	if strings.IndexFunc(cause.Error(), func(r rune) bool {
		return unicode.Is(unicode.Han, r) || unicode.Is(unicode.Cyrillic, r)
	}) >= 0 {
		return cause
	}
	return Wrap(action, cause, next)
}

func Reason(err error) string {
	if err == nil {
		return ""
	}
	if errors.Is(err, context.Canceled) {
		return "операция отменена"
	}
	var timeout net.Error
	if errors.Is(err, context.DeadlineExceeded) || errors.As(err, &timeout) && timeout.Timeout() {
		return "истекло время ожидания ответа"
	}
	var dns *net.DNSError
	if errors.As(err, &dns) {
		return "не удалось разрешить доменное имя сервера"
	}
	var authority x509.UnknownAuthorityError
	var hostname x509.HostnameError
	var certificate x509.CertificateInvalidError
	var record tls.RecordHeaderError
	if errors.As(err, &authority) || errors.As(err, &hostname) || errors.As(err, &certificate) {
		return "сертификат сервера не прошёл проверку"
	}
	if errors.As(err, &record) {
		return "сервер вернул некорректный ответ защищённого соединения"
	}
	switch {
	case errors.Is(err, fs.ErrPermission):
		return "система отказала в доступе к нужному файлу или каталогу"
	case errors.Is(err, fs.ErrNotExist), errors.Is(err, exec.ErrNotFound):
		return "нужный файл или программа не существует"
	case errors.Is(err, syscall.ENOSPC) || runtime.GOOS == "windows" && (errors.Is(err, syscall.Errno(112)) || errors.Is(err, syscall.Errno(39))):
		return "недостаточно свободного места на диске"
	case errors.Is(err, syscall.EROFS):
		return "целевой диск доступен только для чтения"
	case errors.Is(err, syscall.ECONNREFUSED):
		return "целевой сервис отклонил соединение"
	case errors.Is(err, syscall.ECONNRESET), errors.Is(err, syscall.EPIPE), errors.Is(err, io.EOF), errors.Is(err, io.ErrUnexpectedEOF):
		return "соединение прервалось до получения полного ответа"
	case errors.Is(err, syscall.ENETUNREACH), errors.Is(err, syscall.EHOSTUNREACH):
		return "целевой сервис недоступен из текущей сети"
	}
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		return fmt.Sprintf("программа завершилась досрочно (код %d) без понятной причины", exit.ExitCode())
	}
	return ""
}
