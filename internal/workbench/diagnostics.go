package workbench

import (
	"archive/zip"
	"bufio"
	"bytes"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"time"

	"github.com/sylvinus/agent-vm/internal/diagnostics"
	"github.com/sylvinus/agent-vm/internal/host"
	"github.com/sylvinus/agent-vm/internal/version"
)

func (s *Server) diagnosticStatus(w http.ResponseWriter, r *http.Request) {
	info, err := diagnostics.New(s.profile).Info()
	if err != nil {
		requestError(w, errors.New("Не удалось прочитать диагностические журналы; проверьте права на локальное хранилище и свободное место"))
		return
	}
	jsonReply(w, info)
}
func (s *Server) diagnosticEvent(w http.ResponseWriter, r *http.Request) {
	s.diagnosticRateMu.Lock()
	if time.Since(s.diagnosticWindow) > time.Minute {
		s.diagnosticWindow = time.Now()
		s.diagnosticCount = 0
	}
	s.diagnosticCount++
	permitted := s.diagnosticCount <= 60
	s.diagnosticRateMu.Unlock()
	if !permitted {
		http.Error(w, "Диагностические отчёты отправляются слишком часто", http.StatusTooManyRequests)
		return
	}

	var event struct {
		Source  string `json:"source"`
		Level   string `json:"level"`
		Message string `json:"message"`
	}
	if !readJSON(w, r, &event, 32<<10) {
		return
	}
	if event.Source != "frontend" && event.Source != "react" {
		http.Error(w, "Неверный источник журнала", 400)
		return
	}
	if err := diagnostics.New(s.profile).Record(event.Level, event.Source, event.Message); err != nil {
		http.Error(w, "Не удалось записать диагностический журнал", 503)
		return
	}
	jsonReply(w, map[string]bool{"ok": true})
}
func (s *Server) diagnosticExport(w http.ResponseWriter, r *http.Request) {
	if !s.diagnosticMu.TryLock() {
		http.Error(w, "Экспортируется другой диагностический пакет; подождите", 409)
		return
	}
	defer s.diagnosticMu.Unlock()
	guestState := "environment unavailable"
	var guest []byte
	if s.storageRecoveryStatus().Required {
		guestState = "environment storage recovery pending"
	} else if s.vmRunning() {
		ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
		defer cancel()
		var err error
		if s.macosGuest != nil || s.windowsGuest != nil {
			guest, err = s.nativeGuestDiagnostics(ctx)
		} else {
			guest, err = s.guest(ctx, `sudo python3 - <<'CAGE_DIAGNOSTIC_JOURNAL'
import subprocess, sys
result = subprocess.run(['journalctl','--namespace=cage','--no-pager','-o','short-iso','-n','150','--since','14 days ago'], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=5, check=True)
data = result.stdout
if len(data) > 49152:
    data = data[-49152:]
    data = data.partition(b'\n')[2]
sys.stdout.buffer.write(data)
CAGE_DIAGNOSTIC_JOURNAL`)
		}
		if err != nil {
			guest = nil
			guestState = "guest collection failed"
		} else {
			guestState = "collected last 150 service lines (max 48 KiB)"
		}
	}
	var bundle bytes.Buffer
	if err := diagnostics.New(s.profile).Export(&bundle, version.Version, guest, guestState); err != nil {
		requestError(w, errors.New("Не удалось создать диагностический пакет; проверьте права на хранилище и свободное место"))
		return
	}
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", `attachment; filename="cage-diagnostics.zip"`)
	_, _ = w.Write(bundle.Bytes())
}

// ExportDiagnostics works without a running controller. A reachable
// controller authenticates through the native launch ticket; offline recovery
// exports host logs only. No raw configuration is exported.
func ExportDiagnostics(configPath, destination string) error {
	return ExportDiagnosticsForConnection(configPath, "", destination)
}

func ExportDiagnosticsForConnection(configPath, connectionID, destination string) error {
	return exportDiagnostics(configPath, connectionID, destination, false)
}

// ExportAgentDiagnostics pins the owning local workload and uses its native
// launcher proof. The output is exclusive even if another writer races it.
func ExportAgentDiagnostics(configPath, destination string) error {
	return exportDiagnostics(configPath, "local", destination, true)
}

func exportDiagnostics(configPath, connectionID, destination string, agentLocal bool) error {
	if !filepath.IsAbs(destination) {
		return errors.New("Выберите абсолютный локальный путь сохранения")
	}
	profile := filepath.Dir(configPath)
	store := diagnostics.New(profile)
	dir := filepath.Dir(destination)
	f, err := os.CreateTemp(dir, ".cage-diagnostics-*.zip")
	if err != nil {
		return err
	}
	temp := f.Name()
	defer os.Remove(temp)
	if err = host.ProtectFile(temp); err != nil {
		f.Close()
		return err
	}
	export := func() error {
		var c *controllerClient
		var e error
		if agentLocal {
			c, e = agentConnect(context.Background(), configPath)
		} else {
			c, e = connectController(profile)
		}
		if e != nil {
			if connectionID != "" && connectionID != "local" {
				return errors.New("Удалённое подключение недоступно, облачный диагностический пакет экспортировать нельзя")
			}
			if e := store.ImportLegacy(profile); e != nil {
				return e
			}
			return store.Export(f, version.Version, nil, "controller unavailable or invalid; host logs only")
		}
		defer c.close()
		if !agentLocal {
			parsed, e := url.Parse(c.launch.URL)
			if e != nil {
				return e
			}
			ticket := parsed.Fragment
			code, e := c.call("POST", "/api/session", map[string]string{"token": ticket}, nil)
			if e != nil || code != 200 {
				return errors.New("Не удалось создать сеанс экспорта диагностики; снова откройте Cage")
			}
			if _, err := c.bindConnection(connectionID); err != nil {
				return err
			}
		}
		c.client.Timeout = 30 * time.Second
		req, _ := http.NewRequest("GET", c.origin+"/api/diagnostics/export", nil)
		if agentLocal {
			req.Header.Set(connectionHeader, "local")
		}
		response, e := c.client.Do(req)
		if e != nil {
			return e
		}
		defer response.Body.Close()
		if response.StatusCode != 200 {
			return errors.New("Экспорт диагностического пакета не завершён; снова откройте Cage и повторите")
		}
		if response.Header.Get("Content-Type") != "application/zip" {
			return errors.New("Текущая фоновая служба пока не поддерживает экспорт диагностики; перезапустите приложение")
		}
		n, e := io.Copy(f, io.LimitReader(response.Body, (MaxDiagnosticBundle+1)))
		if n > MaxDiagnosticBundle {
			return errors.New("Диагностический пакет превышает допустимый размер")
		}
		return e
	}
	err = export()
	if err == nil {
		err = addDesktopDiagnosticFile(f, profile)
	}
	if err == nil {
		err = f.Sync()
	}
	err = errors.Join(err, f.Close())
	if err != nil {
		return err
	}
	archive, err := zip.OpenReader(temp)
	if err != nil {
		return errors.New("Диагностический пакет создан не полностью; экспортируйте заново")
	}
	_ = archive.Close()
	if agentLocal {
		return os.Link(temp, destination)
	}
	// Never follow a destination symlink or replace a directory.
	if st, e := os.Lstat(destination); e == nil && !st.Mode().IsRegular() {
		return errors.New("Выберите обычный файл как расположение сохранения")
	}
	return os.Rename(temp, destination)
}

// Two independently bounded 40 MiB stores plus guest logs and ZIP metadata.
const MaxDiagnosticBundle int64 = 96 << 20

// Preserve streaming and WebSocket behavior while observing error statuses.
type diagnosticResponse struct {
	http.ResponseWriter
	status int
}

func (w *diagnosticResponse) Unwrap() http.ResponseWriter { return w.ResponseWriter }
func (w *diagnosticResponse) WriteHeader(status int) {
	if w.status == 0 {
		w.status = status
	}
	w.ResponseWriter.WriteHeader(status)
}
func (w *diagnosticResponse) Write(b []byte) (int, error) {
	if w.status == 0 {
		w.status = 200
	}
	return w.ResponseWriter.Write(b)
}
func (w *diagnosticResponse) Flush() { _ = http.NewResponseController(w.ResponseWriter).Flush() }
func (w *diagnosticResponse) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	return http.NewResponseController(w.ResponseWriter).Hijack()
}
