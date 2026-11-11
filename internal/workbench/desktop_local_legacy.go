package workbench

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
)

const previousLocalWorkbench = "Откройте существующую локальную рабочую среду командой cage desktop --existing, сохраните и остановите задачи, затем повторите"

// Only explicit local selection calls this path. An older full controller
// can release an idle profile via its own authenticated update handoff. Its
// process and workloads remain under its control throughout this exchange.
func (d *desktopLocal) handoffOldLocal(ctx context.Context) (bool, error) {
	c, err := connectController(d.profile)
	if err != nil {
		return false, errors.New("Не удалось подтвердить подлинность существующей локальной фоновой службы." + previousLocalWorkbench)
	}
	defer c.close()
	id := c.launch.Controller
	if c.launch.DesktopGateway || id.Protocol != controlProtocol || id.PID != c.record.PID || !id.matches(c.record.Controller) || !remoteInstanceID.MatchString(id.Build) {
		return false, errors.New("Идентичность или протокол существующей локальной фоновой службы несовместимы." + previousLocalWorkbench)
	}
	u, _ := url.Parse(c.launch.URL) // connectController verified the origin and ticket.
	status, err := c.callContext(ctx, "POST", "/api/session", map[string]string{"token": u.Fragment}, nil)
	if err != nil || status != http.StatusOK || len(c.client.Jar.Cookies(u)) == 0 {
		return false, errors.New("Не удалось установить сеанс с существующей локальной фоновой службой." + previousLocalWorkbench)
	}
	// Old controllers can answer 401 before the cookie and 423 while locked,
	// even for an unknown route. A working modern route must never be replaced.
	status, err = c.callContext(ctx, "POST", "/api/desktop-local/status", desktopLocalRequest{Token: c.record.Token}, nil)
	if err != nil {
		return false, err
	}
	switch status {
	case http.StatusOK:
		return false, nil
	case http.StatusNotFound, http.StatusMethodNotAllowed, http.StatusLocked:
	default:
		return false, errors.New("Не удалось определить версию существующей локальной фоновой службы." + previousLocalWorkbench)
	}
	f, err := os.Open(d.executable)
	if err != nil {
		return false, err
	}
	defer f.Close()
	h := sha256.New()
	if _, err = io.Copy(h, f); err != nil {
		return false, err
	}
	if id.Build == fmt.Sprintf("%x", h.Sum(nil)) {
		return false, errors.New("Интерфейс запуска локальной фоновой службы недоступен." + previousLocalWorkbench)
	}
	var selection ClientContext
	status, err = c.callContext(ctx, "GET", "/api/client/context", nil, &selection)
	if err != nil || (status != http.StatusOK && status != http.StatusNotFound && status != http.StatusLocked) {
		return false, errors.New("Не удалось определить состояние подключения старой рабочей среды." + previousLocalWorkbench)
	}
	if status == http.StatusOK && (selection.ClientOnly || selection.Mode != "local") {
		return false, errors.New("Существующая рабочая среда управляет другими подключениями." + previousLocalWorkbench)
	}
	var ack struct {
		Stopping bool `json:"stopping"`
	}
	status, err = c.callContext(ctx, "POST", "/api/handoff", map[string]string{"token": c.record.Token}, &ack)
	if err != nil || status != http.StatusOK || !ack.Stopping {
		return false, errors.New("Старая локальная фоновая служба всё ещё используется или не подтвердила выход после простоя." + previousLocalWorkbench)
	}
	if err := c.waitForExit(); err != nil {
		return false, err
	}
	return true, nil
}
