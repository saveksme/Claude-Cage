package workbench

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os/exec"
	"strings"
	"time"

	"github.com/sylvinus/agent-vm/internal/cage"
	"github.com/sylvinus/agent-vm/internal/host"
	"github.com/sylvinus/agent-vm/internal/managedproxy"
)

var errGuestUpdateRequired = errors.New("Компоненты среды требуют обновления; сначала сохраните изменения в браузере и редакторе. Терминалы рабочей среды и диск сохраняются, терминалы внутри редактора могут завершиться.")

const guestConnectionSnapshot = `sudo cat /etc/claude-cage/browser-control.json; printf '\n'; cat "$HOME/.config/claude-cage/browser-password"; printf '\n'; if sudo test -f /etc/claude-cage/components.json; then sudo cat /etc/claude-cage/components.json; else printf 'null'; fi`

func parseGuestConnection(data []byte) (guestCredentials, *cage.GuestManifest, error) {
	lines := strings.SplitN(strings.TrimSpace(string(data)), "\n", 3)
	var credentials guestCredentials
	if len(lines) != 3 || json.Unmarshal([]byte(lines[0]), &credentials) != nil || credentials.Token == "" || strings.TrimSpace(lines[1]) == "" {
		return credentials, nil, errors.New("Служба управления браузером ещё не установлена")
	}
	credentials.VNCPassword = strings.TrimSpace(lines[1])
	var manifest *cage.GuestManifest
	if json.Unmarshal([]byte(lines[2]), &manifest) != nil || manifest == nil || !manifest.Current() {
		return credentials, manifest, errGuestUpdateRequired
	}
	return credentials, manifest, nil
}

type componentVersions struct {
	Status         string              `json:"status"`
	UpdateRequired bool                `json:"update_required"`
	Required       cage.GuestManifest  `json:"required"`
	Current        *cage.GuestManifest `json:"current"`
}
type toolVersion struct {
	Current  string `json:"current"`
	Required string `json:"required"`
}

// Version commands run only for this explicit request, never in status polling.
func (s *Server) environmentVersions(w http.ResponseWriter, r *http.Request) {
	if s.macosGuest != nil || s.windowsGuest != nil {
		s.nativeEnvironmentVersions(w, r)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 25*time.Second)
	defer cancel()
	running := s.vmRunning()
	components := componentVersions{Status: "stopped", Required: cage.RequiredGuestManifest()}
	tools := map[string]toolVersion{}
	for name, required := range cage.RequiredToolVersions() {
		tools[name] = toolVersion{Required: required}
	}
	var detail string
	if running {
		data, err := s.guest(ctx, `python3 - <<'CAGE_VERSIONS'
import json,subprocess,os
from pathlib import Path
p=Path('/etc/claude-cage/components.json')
try: manifest=json.loads(p.read_text())
except (OSError,ValueError): manifest=None
versions={}
env={**os.environ,'DISABLE_AUTOUPDATER':'1','PATH':str(Path.home()/'.local/bin')+':'+os.environ.get('PATH','')}
for name,args in {'chromium':['chromium','--version'],'code_server':['code-server','--version'],'claude':['claude','--version'],'gh':['gh','--version'],'git':['git','--version'],'mise':[str(Path.home()/'.local/bin/mise'),'--version']}.items():
 try:
  result=subprocess.run(args,env=env,capture_output=True,text=True,timeout=4)
  versions[name]=result.stdout.strip().splitlines()[0][:200] if result.returncode==0 and result.stdout.strip() else ''
 except (OSError,subprocess.TimeoutExpired): versions[name]=''
print(json.dumps({'manifest':manifest,'tools':versions}))
CAGE_VERSIONS`)
		var snapshot struct {
			Manifest *cage.GuestManifest `json:"manifest"`
			Tools    map[string]string   `json:"tools"`
		}
		if err != nil || json.Unmarshal(data, &snapshot) != nil {
			components.Status = "unknown"
			detail = "Пока не удалось прочитать версии среды; восстановите подключение и повторите."
		} else {
			components.Current = snapshot.Manifest
			components.UpdateRequired = snapshot.Manifest == nil || !snapshot.Manifest.Current()
			components.Status = "current"
			if components.UpdateRequired {
				components.Status = "update_required"
			}
			for name, current := range snapshot.Tools {
				entry := tools[name]
				entry.Current = current
				tools[name] = entry
			}
		}
	}
	var proxy struct {
		Version string `json:"version"`
	}
	_ = managedproxy.API(ctx, s.profile, "GET", "/version", nil, &proxy)
	requiredProxy := ""
	if core, err := managedproxy.CorePath(); err == nil {
		probeCtx, done := context.WithTimeout(ctx, 2*time.Second)
		cmd := exec.CommandContext(probeCtx, core, "-v")
		host.HideCommandWindow(cmd)
		b, e := cmd.Output()
		done()
		if e == nil {
			fields := strings.Fields(strings.SplitN(string(b), "\n", 2)[0])
			if len(fields) >= 3 && fields[0] == "Mihomo" {
				requiredProxy = fields[2]
			}
		}
	}
	tools["proxy"] = toolVersion{Current: proxy.Version, Required: requiredProxy}
	s.mu.Lock()
	busy := s.jobs.snapshot().Running
	allowed := s.toolsNetworkAllowedLocked()
	identity := s.identity
	s.mu.Unlock()
	jsonReply(w, map[string]any{"vm_running": running, "busy": busy, "components": components, "controller": identity, "tools": tools, "tools_update_allowed": allowed && components.Status == "current" && !busy, "error": detail})
}

func (s *Server) updateEnvironment(w http.ResponseWriter, r *http.Request) {
	if err := s.nativeMaintenancePreflight(); err != nil {
		http.Error(w, err.Error(), http.StatusConflict)
		return
	}
	s.launch(w, "environment-update", s.synchronizeEnvironment)
}
func (s *Server) updateEnvironmentTools(w http.ResponseWriter, r *http.Request) {
	if err := s.nativeMaintenancePreflight(); err != nil {
		http.Error(w, err.Error(), http.StatusConflict)
		return
	}
	s.launch(w, "environment-tools", s.upgradeEnvironmentTools)
}

func (s *Server) synchronizeEnvironment() error {
	if s.macosGuest != nil || s.windowsGuest != nil {
		return s.maintainNativeComponents(false)
	}
	if !s.vmRunning() {
		return errors.New("Сначала запустите среду Cage.")
	}
	if err := s.closeProxyGate("Идёт обновление компонентов среды, внешняя сеть временно закрыта"); err != nil {
		return err
	}
	// Publish the new guest-only binary before runCage restarts its controller;
	// otherwise updated JavaScript would keep talking to the old protocol.
	if err := s.refreshInstalledTailnet(); err != nil {
		return err
	}
	s.mu.Lock()
	s.ready = false
	s.guestUpdateRequired = true
	s.guestUpdateError = "Обновление компонентов среды ещё не завершено; дождитесь результата; при ошибке можно повторить."
	s.mu.Unlock()
	s.setMessage("Идёт перезапуск компонентов браузера и редактора, терминалы рабочей среды продолжают работать…")
	if err := s.runCage("up"); err != nil {
		return err
	}
	if err := s.attach(); err != nil {
		return err
	}
	s.mu.Lock()
	paused := s.networkPaused
	s.mu.Unlock()
	if paused {
		return nil
	}
	return s.runSafetyCheck()
}

func (s *Server) toolsNetworkAllowedLocked() bool {
	return !s.closing
}
func (s *Server) upgradeEnvironmentTools() error {
	if s.macosGuest != nil || s.windowsGuest != nil {
		return s.maintainNativeComponents(true)
	}
	if !s.vmRunning() {
		return errors.New("Сначала запустите среду Cage.")
	}
	s.mu.Lock()
	allowed := s.toolsNetworkAllowedLocked()
	manifest := s.guestManifest
	s.mu.Unlock()
	if !allowed {
		return errors.New("Рабочая среда завершает работу; повторите обновление инструментов позже.")
	}
	if manifest == nil || !manifest.Current() {
		return errGuestUpdateRequired
	}
	monitorContext, stopMonitor := context.WithCancel(s.operationContext())
	monitorDone := make(chan struct{})
	go func() {
		defer close(monitorDone)
		ticker := time.NewTicker(10 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-monitorContext.Done():
				return
			case <-ticker.C:
				s.monitorSafety()
			}
		}
	}()
	finishMonitor := func() {
		stopMonitor()
		s.mu.Lock()
		if s.monitorCancel != nil {
			s.monitorCancel()
		}
		s.mu.Unlock()
		<-monitorDone
	}
	s.setMessage("Идёт обновление Chromium, редактора и инструментов разработки, терминалы и диск рабочей среды сохраняются…")
	err := s.runCage("update-tools")
	finishMonitor()
	if err != nil {
		return err
	}
	return s.synchronizeEnvironment()
}
