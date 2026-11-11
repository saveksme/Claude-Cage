package workbench

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"time"

	"github.com/sylvinus/agent-vm/internal/diagnostics"
	"github.com/sylvinus/agent-vm/internal/usererror"
)

const browserResponseLimit = 1 << 20
const browserOrigin = "http://127.0.0.1:18500"

// browserClient owns host connections to the guest browser controller. Closing
// it cancels those connections; the guest browser process remains untouched.
type browserClient struct {
	ctx    context.Context
	cancel context.CancelFunc
	http   *http.Client
}

func newBrowserClient(parent context.Context) *browserClient {
	ctx, cancel := context.WithCancel(parent)
	return &browserClient{ctx: ctx, cancel: cancel, http: &http.Client{
		Transport:     &http.Transport{Proxy: nil, IdleConnTimeout: 30 * time.Second, MaxIdleConnsPerHost: 4, DialContext: (&net.Dialer{Timeout: 3 * time.Second}).DialContext},
		CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("redirect refused") },
	}}
}

func (c *browserClient) close() {
	c.cancel()
	c.http.CloseIdleConnections()
}

// The response owns cancellation until its body is closed. This also covers
// event subscriptions, whose lifetime extends beyond receiving HTTP headers.
func (c *browserClient) open(parent context.Context, token, method, path, contentType string, body io.Reader, length int64, timeout time.Duration) (*http.Response, error) {
	if err := c.ctx.Err(); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(parent)
	stop := context.AfterFunc(c.ctx, cancel)
	finish := func() { stop(); cancel() }
	if timeout > 0 {
		var cancelTimeout context.CancelFunc
		ctx, cancelTimeout = context.WithTimeout(ctx, timeout)
		finish = func() { stop(); cancelTimeout(); cancel() }
	}
	req, err := http.NewRequestWithContext(ctx, method, browserOrigin+path, body)
	if err != nil {
		finish()
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	if body != nil {
		req.Header.Set("Content-Type", contentType)
		req.ContentLength = length
	}
	response, err := c.http.Do(req)
	if err != nil {
		finish()
		return nil, err
	}
	response.Body = &browserResponseBody{ReadCloser: response.Body, finish: finish}
	return response, nil
}

type browserResponseBody struct {
	io.ReadCloser
	finish func()
}

func (b *browserResponseBody) Close() error {
	b.finish()
	return b.ReadCloser.Close()
}

func (c *browserClient) request(ctx context.Context, token, method, path string, body []byte) ([]byte, error) {
	timeout := 5 * time.Second
	switch path {
	case "/audit", "/paste-image", "/tailnet":
		timeout = 20 * time.Second
	case "/editor-restart":
		timeout = 30 * time.Second
	case "/extensions":
		timeout = 25 * time.Second
	}
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	response, err := c.open(ctx, token, method, path, "application/json", reader, int64(len(body)), timeout)
	if err != nil {
		diagnostics.Log("warn", "browser", fmt.Sprintf("operation=%s transport=%v", path, err))
		return nil, usererror.Wrap(browserOperation(path), err, "Убедитесь, что среда всё ещё работает, и переподключите браузер; если ошибка повторяется, экспортируйте диагностический пакет в настройках.")
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, browserResponseLimit+1))
	if err != nil {
		return nil, usererror.Wrap(browserOperation(path), err, "Результат браузера вернулся не полностью; переподключитесь и проверьте, применилось ли это действие.")
	}
	if len(data) > browserResponseLimit {
		return nil, errors.New(browserOperation(path) + " — ошибка: данные браузера превысили 1 MiB, чтение остановлено. Закройте неиспользуемые вкладки или расширения и повторите; если ошибка повторяется, экспортируйте диагностический пакет.")
	}
	if response.StatusCode != http.StatusOK {
		diagnostics.Log("warn", "browser", fmt.Sprintf("operation=%s http=%d", path, response.StatusCode))
		var result struct {
			Error string `json:"error"`
		}
		_ = json.Unmarshal(data, &result)
		known := map[string]string{
			"Tab no longer exists": "Вкладка закрыта. Снова откройте веб-страницу и повторите действие.",
			"Browser is starting":  "Браузер ещё запускается. Дождитесь завершения запуска и повторите действие.",
			"Input target changed": "Страница, принимающая содержимое, сменилась. Вернитесь на исходную страницу и снова нажмите поле ввода.",
			"Image target changed": "Страница, принимающая изображение, сменилась. Вернитесь на исходную страницу и снова нажмите поле ввода.",
			"Copy target changed":  "Страница, с которой нужно скопировать содержимое, сменилась. Вернитесь на исходную страницу и скопируйте заново.",
			"Image too large":      "Изображение превышает допустимый размер. Уменьшите его и вставьте снова.",
			"Invalid PNG":          "Изображение не является корректным PNG-файлом. Скопируйте или экспортируйте его заново.",
			"Only HTTP(S) URLs without credentials are accepted":         "Адрес содержит имя пользователя или пароль. Используйте адрес http или https без учётных данных.",
			"Only HTTP(S) URLs and supported browser pages are accepted": "Этот тип адреса не поддерживается. Используйте адрес http или https.",
			"Unknown browser action":                                     "Компонент браузера не поддерживает это действие. Обновите компоненты среды и повторите.",
			"Split controller unavailable":                               "Компонент разделённого экрана не готов. Обновите компоненты среды и снова откройте разделённый экран.",
			"Editor authentication is unavailable":                       "Локальный сеанс входа редактора недоступен. Снова откройте редактор из Cage.",
			"Страница приёма файла изменилась. Вернитесь на исходную страницу и повторите": "Страница приёма файлов сменилась; вернитесь на исходную страницу и повторите.",
			"Компонент браузера не удалось восстановить. Перезапустите среду":              "Компонент браузера не восстановился; сохраните работу и перезапустите среду.",
			"Нельзя разделить экран для разных сеансов браузера":                           "Выбранные страницы относятся к разным сеансам браузера и не могут находиться в одном разделённом экране. Откройте обе страницы в одном сеансе.",
			"Разделение экрана для вкладок инкогнито пока не поддерживается":               "Разделённый экран с двумя страницами пока не поддерживается в приватных вкладках. Используйте обычные вкладки.",
			"Страницу настроек используйте в одной панели браузера":                        "Страницу настроек нужно открывать в одной панели браузера. Сначала выйдите из разделённого экрана.",
			"ZIP расширения не может превышать 32 MB":                                      "ZIP-архив расширения не должен превышать 32 МБ. Уменьшите пакет расширения и импортируйте его снова.",
		}
		if reason := known[result.Error]; reason != "" {
			return nil, errors.New(browserOperation(path) + " — ошибка: " + reason)
		}
		return nil, serviceHTTPFailure(browserOperation(path), response.StatusCode)
	}
	return data, nil
}

func (c *browserClient) events(ctx context.Context, token string) (io.ReadCloser, error) {
	response, err := c.open(ctx, token, http.MethodGet, "/events", "", nil, 0, 0)
	if err != nil {
		return nil, err
	}
	if response.StatusCode != http.StatusOK {
		response.Body.Close()
		return nil, serviceHTTPFailure("получение состояния браузера", response.StatusCode)
	}
	return response.Body, nil
}

func (c *browserClient) file(ctx context.Context, token, method, path string, body io.Reader, length int64) (*http.Response, error) {
	return c.open(ctx, token, method, path, "application/octet-stream", body, length, 30*time.Minute)
}
