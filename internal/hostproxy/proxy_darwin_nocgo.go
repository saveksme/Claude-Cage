//go:build darwin && !cgo

package hostproxy

import (
	"errors"
	"net/http"
	"net/url"
)

func systemProxy(*http.Request) (*url.URL, error) {
	return nil, errors.New("Эта сборка не может прочитать системный прокси macOS; используйте официальную нативную сборку или задайте HTTPS_PROXY; переключения на прямое подключение не было")
}
