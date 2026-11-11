package workbench

import (
	"errors"
	"net/http"
	"path/filepath"
)

type connectionTransport struct {
	base http.RoundTripper
	id   string
}

func (t connectionTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	copy := r.Clone(r.Context())
	copy.Header.Set(connectionHeader, t.id)
	return t.base.RoundTrip(copy)
}

func (t connectionTransport) CloseIdleConnections() {
	if closer, ok := t.base.(interface{ CloseIdleConnections() }); ok {
		closer.CloseIdleConnections()
	}
}

// A native picker captures the connection before the user selects a file.
// Matching it here prevents a slow picker from sending that file to a newly
// selected server. Native calls from old local builds may omit it only locally.
func (c *controllerClient) bindConnection(expected string) (ClientContext, error) {
	var current ClientContext
	status, err := c.call("GET", "/api/client/context", nil, &current)
	if err == nil && status == http.StatusNotFound && expected == "" {
		return ClientContext{Mode: "local", ConnectionID: "local"}, nil
	}
	if err != nil || status != http.StatusOK {
		return current, errors.New("Не удалось проверить текущее подключение передачи файлов")
	}
	if current.DesktopGateway && (expected == "" || current.Mode == "none") {
		return current, errors.New("Сначала выберите рабочую среду, затем повторите файловую операцию")
	}
	if current.Mode == "remote" && (expected == "" || current.State.State != "connected") {
		return current, errors.New("Удалённое подключение недоступно; переподключитесь и выберите файл")
	}
	if expected != "" && expected != current.ConnectionID {
		return current, errors.New("Подключение переключилось; выберите файл заново на текущем хосте")
	}
	c.connectionID = current.ConnectionID
	c.client.Transport = connectionTransport{base: c.client.Transport, id: current.ConnectionID}
	return current, nil
}

func clientDownloadProfile(profile string, current ClientContext) (string, error) {
	if current.Mode != "remote" {
		return profile, nil
	}
	if !remoteInstanceID.MatchString(current.InstanceID) {
		return "", errors.New("Неверная идентичность удалённого экземпляра")
	}
	return filepath.Join(profile, "remote-downloads", current.InstanceID), nil
}
