package workbench

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"al.essio.dev/pkg/shellescape"

	"github.com/sylvinus/agent-vm/internal/cage"
	"github.com/sylvinus/agent-vm/internal/containerenv"
	"github.com/sylvinus/agent-vm/internal/diagnostics"
	"github.com/sylvinus/agent-vm/internal/guestos"
	"github.com/sylvinus/agent-vm/internal/host"
	"github.com/sylvinus/agent-vm/internal/hostimage"
	"github.com/sylvinus/agent-vm/internal/managedproxy"
)

var loadConfig = cage.Load
var defaultConfig = cage.DefaultConfig

type guestCredentials struct {
	Token        string  `json:"token"`
	VNCPassword  string  `json:"-"`
	DisplayScale float64 `json:"display_scale"`
	DynamicScale bool    `json:"dynamic_scale"`
}

func (s *Server) workspaceLocked() string {
	if s.clientWorkspace != "" {
		return s.clientWorkspace
	}
	return s.preferences.Workspace
}
func (s *Server) workspace() string      { s.mu.Lock(); defer s.mu.Unlock(); return s.workspaceLocked() }
func (s *Server) environmentDir() string { return environmentWorkspace(s.profile) }
func (s *Server) sshTarget() string {
	if s.macosGuest != nil {
		return "cage-macos"
	}
	if containerenv.Configured(s.profile) {
		return "cage-container"
	}
	return "lima-" + cage.InstanceName(s.profile, s.environmentDir())
}

func (s *Server) environmentPrepared() bool {
	if s.windowsGuest != nil {
		return true
	}
	if containerenv.Configured(s.profile) {
		environment, err := containerenv.Load(s.profile)
		if err != nil {
			return false
		}
		ctx, cancel := context.WithTimeout(s.lifetimeContext(), 3*time.Second)
		defer cancel()
		state, err := environment.State(ctx)
		return err == nil && state.Exists
	}
	_, err := os.Stat(filepath.Join(s.profile, "state", ".agent-vm-base-version"))
	return err == nil
}
func (s *Server) sshCommand(ctx context.Context, args ...string) *exec.Cmd {
	return s.sshCommandOptions(ctx, false, args...)
}
func (s *Server) sshCommandWithForwarding(ctx context.Context, args ...string) *exec.Cmd {
	return s.sshCommandOptions(ctx, true, args...)
}
func (s *Server) sshCommandOptions(ctx context.Context, maintenance bool, args ...string) *exec.Cmd {
	if s.windowsGuest != nil {
		return &exec.Cmd{Err: errors.New("Гостевая система Windows не поддерживает управляющие скрипты Linux SSH")}
	}
	if s.macosGuest != nil {
		return s.macOSSSHCommand(ctx, args...)
	}
	cfg := filepath.Join(s.instanceDir(), "ssh.config")
	base := []string{"-q", "-e", "none", "-F", cfg, "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "PermitLocalCommand=no", "-o", "PasswordAuthentication=no", "-o", "KbdInteractiveAuthentication=no", "-o", "ProxyCommand=none", "-o", "ProxyJump=none", "-o", "ConnectTimeout=3", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=2", "-o", "ForwardAgent=no", "-o", "IdentityAgent=none", "-o", "ForwardX11=no", "-o", "ClearAllForwardings=yes", "-o", "ControlPath=none"}
	if maintenance {
		for index, value := range base {
			if value == "ClearAllForwardings=yes" {
				base[index] = "ClearAllForwardings=no"
			}
		}
	}
	base = append(base, args...)
	cmd := exec.CommandContext(ctx, sshExecutable(), base...)
	cmd.Env = sshEnvironment()
	host.HideCommandWindow(cmd)
	return cmd
}
func (s *Server) guest(ctx context.Context, script string) ([]byte, error) {
	return s.guestControl(ctx, script, "")
}

func (s *Server) guestControl(ctx context.Context, script, diagnosticSource string) ([]byte, error) {
	if s.windowsGuest != nil {
		return nil, errors.New("Гостевая система Windows не поддерживает управляющие скрипты Linux")
	}
	// SSH enters the user's default shell. Run control scripts in Bash so
	// zsh initialization cannot change their redirection or error behavior.
	command := "exec /bin/bash --noprofile --norc -c " + shellescape.Quote(script)
	cmd := s.sshCommand(ctx, "-T", s.sshTarget(), "--", command)
	var stderr fileControlStderr
	if diagnosticSource != "" {
		cmd.Stderr = &stderr
		defer func() {
			if len(stderr.data) > 0 {
				_ = diagnostics.New(s.profile).Record("warn", diagnosticSource, "guest control stderr: "+string(stderr.data))
			}
		}()
	}
	pipe, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err = cmd.Start(); err != nil {
		return nil, err
	}
	data, readErr := io.ReadAll(io.LimitReader(pipe, (64<<10)+1))
	if readErr != nil || len(data) > 64<<10 {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return nil, errors.New("guest control response exceeded its limit")
	}
	if err = cmd.Wait(); err != nil {
		return nil, err
	}
	return data, nil
}
func (s *Server) attach() error {
	if err := s.requireStorageReady(); err != nil {
		return err
	}
	if s.windowsGuest != nil {
		return s.attachWindowsGuest()
	}
	if s.macosGuest != nil {
		return s.attachMacOSGuest()
	}
	ctx, cancel := s.controlContext()
	defer cancel()
	if containerenv.Configured(s.profile) {
		environment, err := containerenv.Load(s.profile)
		if err != nil {
			return err
		}
		state, err := environment.State(ctx)
		if err != nil {
			return err
		}
		if !state.Running {
			return errors.New("Среда ещё не запущена")
		}
		if !state.Ready {
			s.mu.Lock()
			s.ready = false
			s.mu.Unlock()
			if !state.MountsReady {
				return errors.New("Общий доступ к проектам контейнера требует инициализации; сохраните работу, полностью остановите и снова запустите среду")
			}
			if !state.ResourcesVerified {
				return errors.New("Ограничения ресурсов контейнера ещё не проверены; проверьте конфигурацию ресурсов сервера")
			}
			return errors.New("Сетевые и файловые подключения контейнера ещё не готовы; повторите запуск")
		}
	} else if !s.vmRunning() {
		return errors.New("Среда ещё не запущена")
	}
	b, err := s.guest(ctx, guestConnectionSnapshot)
	if err != nil {
		return errors.New("Среда ещё не готова")
	}
	credentials, manifest, err := parseGuestConnection(b)
	s.mu.Lock()
	s.guestManifest = manifest
	s.guestUpdateRequired = errors.Is(err, errGuestUpdateRequired)
	s.guestUpdateError = ""
	if err != nil {
		s.ready = false
		s.guestUpdateError = err.Error()
	}
	s.mu.Unlock()
	if err != nil {
		if errors.Is(err, errGuestUpdateRequired) {
			_ = s.closeProxyGate("Компоненты среды требуют обновления, внешняя сеть остаётся закрытой")
		}
		return err
	}
	if _, err = s.guestAPI(ctx, credentials.Token, "GET", "/health", nil); err != nil {
		return err
	}
	s.mu.Lock()
	home := browserHomeURL(s.preferences)
	s.mu.Unlock()
	if err = s.setBrowserHome(ctx, credentials.Token, home); err != nil {
		return err
	}
	if containerenv.Configured(s.profile) {
		if err := s.recoverClientMounts(ctx); err != nil {
			return err
		}
	}
	s.mu.Lock()
	s.credentials = credentials
	s.ready = true
	s.mu.Unlock()
	s.restoreProjectShares()
	s.desktopViews.background(s.changeDesktopVisibility)
	s.browserViews.background(s.changeBrowserVisibility)
	return nil
}
func (s *Server) monitor(ctx context.Context) {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	skipped := 0
	for ctx.Err() == nil {
		timing := s.startMonitorTiming()
		if s.op.TryLock() {
			skipped = 0
			if !s.busy() {
				s.mu.Lock()
				ready := s.ready
				token := s.credentials.Token
				s.mu.Unlock()
				if !ready || s.macosGuest != nil || s.windowsGuest != nil {
					_ = s.attach()
				} else {
					ctx, cancel := s.controlContext()
					_, err := s.guestAPI(ctx, token, "GET", "/health", nil)
					cancel()
					if err != nil {
						s.mu.Lock()
						s.ready = false
						s.mu.Unlock()
					}
				}
				timing.stage("environment_health")
				if s.macosGuest != nil {
					s.monitorNetworkTick()
					timing.stage("network_tick")
				}
			} else {
				timing.result = "job_running"
			}
			s.op.Unlock()
		} else {
			skipped++
			timing.result = "operation_lock_busy"
		}
		timing.stages = append(timing.stages, fmt.Sprintf("consecutive_lock_skips=%d", skipped))
		s.recordMonitorTiming("environment", timing)
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (s *Server) runCage(args ...string) error {
	ctx := s.operationContext()
	// Setup and startup can both install dependencies. Downloads own their
	// inactivity timeouts; the operation context still permits an explicit stop.
	if len(args) != 1 || (args[0] != "setup" && args[0] != "up") {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, 30*time.Minute)
		defer cancel()
	}
	cmd := exec.CommandContext(ctx, s.exe, args...)
	host.HideCommandWindow(cmd)
	cmd.Dir = s.environmentDir()
	if cmd.Dir == "" {
		cmd.Dir = s.profile
	}
	cmd.Env = append(os.Environ(), cage.ConfigEnv+"="+s.configPath)
	execution := s.jobs.execution()
	if len(args) == 1 && args[0] == "setup" {
		cmd.Env = append(cmd.Env, "CAGE_SETUP_PROGRESS=1")
	}
	cmd.Env = append(cmd.Env, cage.JobEnv+"="+execution.id)
	cmd.Stdout, cmd.Stderr = execution, execution
	if err := cmd.Run(); err != nil {
		if errors.Is(ctx.Err(), context.Canceled) {
			return context.Canceled
		}
		action := map[string]string{"setup": "подготовка среды Linux", "up": "запуск среды", "down": "остановка среды", "stop": "остановка среды"}[args[0]]
		if action == "" {
			action = "действие со средой"
		}
		if p := s.jobs.snapshot().SetupProgress; p != nil && p.Label != "" {
			action = p.Label
		}
		// CLI failures can include the original QEMU stderr before a generic
		// "Failed to start base VM" footer. Surface that reason in job.error.
		for _, line := range strings.Split(s.jobs.snapshot().Log, "\n") {
			if _, reason, ok := strings.Cut(line, "Error: QEMU 启动失败："); ok {
				return fmt.Errorf("Не удалось выполнить «%s»: виртуальная машина не запустилась. QEMU не запустился: %s. Посмотрите подробности операции; если запуск по-прежнему невозможен, экспортируйте диагностический пакет в настройках.", action, reason)
			}
		}
		diagnostics.Log("error", "environment-operation", fmt.Sprintf("operation=%s error=%v context=%v", args[0], err, ctx.Err()))
		return executionFailure(action, errors.Join(ctx.Err(), err), s.jobs.snapshot().Log)
	}
	return nil
}
func (s *Server) startEnvironment(syncTimezone bool) error {
	s.desktopViews.reset()
	s.browserViews.reset()
	s.controlSession.close()
	s.desktopStatus.invalidate()
	defer s.desktopStatus.invalidate()
	if err := s.requireStorageReady(); err != nil {
		return err
	}
	if s.macosGuest != nil {
		return s.startMacOSGuest()
	}
	if s.windowsGuest != nil {
		return s.startWindowsGuest()
	}
	pending, err := guestos.LoadInstallation(s.profile)
	if err != nil || (pending != nil && !hostimage.IsLinux(pending.System)) {
		return errors.New("Продолжите установку нативной гостевой системы через мастер первой установки")
	}
	linuxSystem, err := s.installedLinuxSystem()
	if err != nil {
		return err
	}
	if pending != nil {
		prepared, err := hostimage.Load(filepath.Join(s.profile, "state", "guest-media"))
		if err != nil || pending.Media == "" || prepared != pending.Source {
			return errors.New("Завершите подготовку материалов системы этого компьютера через мастер первой установки")
		}
	}
	// Check before proxy activation or the first image download. The UI cannot
	// bypass this gate by calling /start or applying settings directly.
	if err := requireHostGit(s.operationContext()); err != nil {
		return err
	}
	if _, err := validateWorkspace(s.environmentDir(), s.profile); err != nil {
		return err
	}
	if containerenv.Configured(s.profile) {
		environment, err := containerenv.Load(s.profile)
		if err != nil {
			return err
		}
		state, err := environment.State(s.operationContext())
		if err != nil {
			return err
		}
		if state.Running && !state.MountsReady {
			s.mu.Lock()
			s.ready = false
			s.mu.Unlock()
			return errors.New("Общий доступ к проектам контейнера требует инициализации; сохраните работу, сначала остановите среду, затем запустите её снова; проекты и данные входа сохранятся")
		}
	}
	cfg, err := loadConfig(s.configPath)
	if err != nil {
		return err
	}
	if err = cfg.RequireManagedProxy(s.profile); err != nil {
		_ = s.closeProxyGate(err.Error())
		return err
	}
	{
		p, e := managedproxy.Load(s.profile)
		if e != nil {
			return e
		}
		if p.Selected == "" || p.Endpoint() != cfg.ProxyURL || p.Revision != cfg.ProxyRevision {
			return errors.New("Конфигурация встроенного прокси не применена; выберите узел заново")
		}
		name, e := physicalProxyInterface(s.operationContext())
		if e != nil {
			_ = s.closeProxyGate(e.Error())
			return e
		}
		bound, _ := managedproxy.BoundInterface(filepath.Join(managedproxy.Dir(s.profile), "config.yaml"))
		if bound != name || !managedproxy.Running(s.operationContext(), s.profile, p) {
			// Every core start changes the report generation, including recovery.
			if e = s.activateProxy(p, cfg); e != nil {
				return e
			}
			cfg, e = loadConfig(s.configPath)
			if e != nil {
				return e
			}
		}
	}

	attachErr := s.attach()
	if errors.Is(attachErr, errGuestUpdateRequired) {
		return s.synchronizeEnvironment()
	}
	if attachErr == nil {
		client, gateErr := s.gateClient()
		if gateErr == nil {
			state, e := client.Status(context.Background())
			if e == nil {
				if state.Mode == cage.GateOpen && state.Report != nil && state.Report.Authorizes(state.RunID, cfg.Fingerprint(), time.Now()) == nil {
					s.publishGate(state)
					return nil
				}
				return s.checkNetworkIfWanted()
			}
		}
		s.setMessage("Перезапуск среды для загрузки внешнего сетевого шлюза виртуальной машины…")
		if err := s.stopEnvironment(); err != nil {
			return err
		}
	}
	s.mu.Lock()
	preferences := s.preferences
	auto := preferences.AutoTimezone || preferences.AutoLanguage
	s.mu.Unlock()
	s.setMessage("Проверка выхода через прокси…")
	loc, probeErr := probeEnvironmentLocation(s.operationContext(), cfg, preferences)
	if s.operationContext().Err() != nil {
		return s.operationContext().Err()
	}
	if err := s.finishLocationProbe(cfg, loc, probeErr); err != nil {
		return err
	}
	if probeErr != nil && !s.environmentPrepared() {
		return probeErr
	}
	if cfg.ExitPolicy.NeedsBinding() && loc.IP != "" && !s.vmRunning() {
		bound := cfg.ExitPolicy.BindMissing(loc.exitLocation())
		if bound != cfg.ExitPolicy {
			cfg.ExitPolicy = bound
			if err = s.saveExitPolicyConfig(cfg); err != nil {
				return err
			}
		}
	}
	if auto && syncTimezone && !s.vmRunning() && probeErr == nil {
		observed := loc.exitLocation()
		within, _ := cfg.ExitPolicy.Evaluate(loc.IP, &observed)
		updated := cfg
		if within == cage.CheckPassed {
			updated = autoRegionSettings(cfg, preferences, loc)
		}
		if updated != cfg {
			// Changing a live hostagent's profile is forbidden. Stop before replacing it.
			s.setMessage("Применение рекомендаций часового пояса и языка для региона выхода…")
			if err = s.stopEnvironment(); err != nil {
				return err
			}
			cfg = updated
			if err = writePrivate(s.configPath, cfg); err != nil {
				return err
			}
		}
	} else if probeErr != nil {
		s.setMessage("Выход через прокси не прошёл проверку, запускается офлайн-среда…")
	}
	if _, err = os.Stat(filepath.Join(s.profile, "state", ".agent-vm-base-version")); !containerenv.Configured(s.profile) && os.IsNotExist(err) {
		s.setMessage("Первая подготовка среды Linux и инструментов разработки может занять несколько минут…")
		job := s.jobs.execution()
		job.setSetupProgress(&SetupProgress{Phase: "image", System: linuxSystem, Label: "Идёт подготовка образа " + guestProgressName(linuxSystem)})
		if err = s.runCage("setup"); err != nil {
			return err
		}
		job.setSetupProgress(&SetupProgress{Phase: "services", Label: "Идёт запуск браузера и редактора"})
		defer job.setSetupProgress(nil)
	}
	s.setMessage("Запуск браузера, редактора и общих файлов…")
	if err = s.runCage("up"); err != nil {
		return err
	}
	for i := 0; i < 8; i++ {
		if s.operationContext().Err() != nil {
			return s.operationContext().Err()
		}
		if err = s.attach(); err == nil {
			return s.checkNetworkIfWanted()
		}
		time.Sleep(time.Second)
	}
	return errors.New("Среда запущена, но подключение браузера ещё не готово. Повторите подключение или посмотрите подробности операции.")
}
func (s *Server) stopEnvironment() (returned error) {
	s.desktopStatus.invalidate()
	defer s.desktopStatus.invalidate()
	explicitStop := s.jobs.snapshot().Kind == "stop"
	defer func() {
		if explicitStop && returned == nil {
			returned = managedproxy.Stop(s.profile)
		}
	}()
	if s.windowsGuest != nil {
		return s.stopWindowsGuest()
	}
	if s.macosGuest != nil {
		return s.stopMacOSGuest()
	}
	s.setMessage("Остановка среды Cage…")
	if (explicitStop || s.jobs.snapshot().Kind == "storage") && cage.InstanceJobID(filepath.Join(s.profile, "state"), "base-building") != "" {
		if err := s.runCage("stop", "base-building"); err != nil {
			return err
		}
	}
	if client, err := s.gateClient(); err == nil {
		if state, e := client.Close(context.Background(), "Среда останавливается"); e == nil {
			s.publishGate(state)
		}
	}
	s.mu.Lock()
	s.ready = false
	s.credentials = guestCredentials{}
	s.guestManifest = nil
	s.guestUpdateRequired = false
	s.guestUpdateError = ""
	s.safety.Error = ""
	s.mu.Unlock()
	s.terminals.closeAll()
	s.mobileCLI.stopAll()
	s.closeProjectShares()
	if s.workspace() == "" {
		return nil
	}
	if _, err := os.Stat(filepath.Join(s.instanceDir(), "lima.yaml")); !containerenv.Configured(s.profile) && os.IsNotExist(err) {
		return nil
	}
	if err := s.runCage("stop"); err != nil {
		return err
	}
	return nil
}
func (s *Server) apply(v savedProfile, validate bool) error {
	old, err := loadConfig(s.configPath)
	if err != nil {
		return err
	}
	// Network endpoints are generated by the node manager, including restore.
	v.Config.ProxyURL, v.Config.ProxyRevision = old.ProxyURL, old.ProxyRevision
	s.mu.Lock()
	oldPrefs := s.preferences
	resumeVersion := s.safety.pauseVersion
	if execution := s.jobs.execution(); execution.id != "" {
		resumeVersion = execution.pauseVersion
	}
	wasReady := vmAlive(s.profile, s.environmentDir())
	if s.windowsGuest != nil {
		wasReady = s.windowsState.Running
	} else if s.macosGuest != nil {
		wasReady = macOSInstanceRunning(s.instanceDir())
	}
	s.mu.Unlock()
	changed := old != v.Config || oldPrefs.AutoTimezone != v.Preferences.AutoTimezone || oldPrefs.AutoLanguage != v.Preferences.AutoLanguage
	if changed && validate && old.RequireManagedProxy(s.profile) == nil {
		s.setMessage("Проверка нового выхода, текущая среда продолжает работать…")
		loc, e := probeEnvironmentLocation(s.operationContext(), v.Config, v.Preferences)
		if err := s.finishLocationProbe(v.Config, loc, e); err != nil {
			return err
		}
		if e != nil {
			if v.Preferences.AutoTimezone || v.Preferences.AutoLanguage || loc.IP == "" {
				return e
			}
		} else {
			v.Config = autoRegionSettings(v.Config, v.Preferences, loc)
		}
		v.Config.ExitPolicy = v.Config.ExitPolicy.BindMissing(loc.exitLocation())
		observed := loc.exitLocation()
		if result, message := v.Config.ExitPolicy.Evaluate(loc.IP, &observed); result != cage.CheckPassed {
			if result == cage.CheckUnknown && e != nil && !v.Preferences.AutoTimezone && !v.Preferences.AutoLanguage {
				return errors.New("Для часового пояса и языка выбрана ручная настройка, но страну или регион всех выходов всё равно нужно подтвердить. Повторите проверку местоположения или переключите узел; статический IP и неограниченные регионы не позволяют пропустить проверку выхода из материкового Китая, исходная конфигурация не меняется")
			}
			return errors.New(message)
		}
	}
	if changed {
		if s.windowsGuest != nil && wasReady && (old.Timezone != v.Config.Timezone || old.Locale != v.Config.Locale) {
			if err := s.closeProxyGate("Применение системных настроек Windows, внешняя сеть ожидает повторной проверки"); err != nil {
				return err
			}
			if err := s.applyWindowsGuestSettings(s.operationContext(), v.Config); err != nil {
				return err
			}
		}
		if err := s.resumeNetworkIntentAt(resumeVersion); err != nil {
			return err
		}
		if s.operationContext().Err() != nil {
			return s.operationContext().Err()
		}
		if err = writePrivate(filepath.Join(s.profile, "previous-profile.json"), savedProfile{old, oldPrefs}); err != nil {
			return err
		}
		if err = s.stopEnvironment(); err != nil {
			return err
		}
	}
	// A project is a live directory grant in the same VM, never a lifecycle change.
	if v.Preferences.Workspace != "" && s.vmRunning() {
		s.setMessage("Подключение папки проекта…")
		if _, err = s.connectProject(v.Preferences.Workspace, true); err != nil {
			return err
		}
	}
	if v.Config.RequireManagedProxy(s.profile) == nil {
		err = s.saveExitPolicyConfig(v.Config)
	} else {
		err = writePrivate(s.configPath, v.Config)
	}
	if err != nil {
		return err
	}
	if err = writePrivate(filepath.Join(s.profile, "workbench.json"), v.Preferences); err != nil {
		_ = writePrivate(s.configPath, old)
		return err
	}
	s.mu.Lock()
	s.preferences = v.Preferences
	token, ready := s.credentials.Token, s.ready
	s.mu.Unlock()
	s.jobs.execution().settingsSaved()
	if !changed && ready && browserHomeURL(oldPrefs) != browserHomeURL(v.Preferences) {
		ctx, cancel := s.controlContext()
		defer cancel()
		if err = s.setBrowserHome(ctx, token, browserHomeURL(v.Preferences)); err != nil {
			return fmt.Errorf("Настройки сохранены, но браузер пока не смог применить сайт по умолчанию; восстановите подключение и повторите: %w", err)
		}
	}
	if changed && wasReady {
		s.setMessage("Переподключение гостевой системы…")
		if err = s.startEnvironment(false); err != nil {
			var network networkCheckError
			if errors.As(err, &network) {
				return fmt.Errorf("Настройки сохранены, среда запущена. Внешняя сеть по-прежнему закрыта; после устранения указанных проблем повторите проверку: %w", err)
			}
			return fmt.Errorf("Настройки сохранены, среда ещё не вернулась в рабочее состояние. Проверьте состояние гостевой системы и повторите запуск: %w", err)
		}
	}
	return nil
}

// Interface recovery uses the ordinary cancellable job queue. Location changes
// remain governed by the saved exit policy and never replace its baseline.
func (s *Server) monitorNetworkTick() {
	timing := s.startMonitorTiming()
	defer s.recordMonitorTiming("network", timing)
	if s.storageRecoveryStatus().Required {
		timing.result = "storage_recovery_pending"
		return
	}
	if s.macSetupPending() {
		timing.result = "setup_pending"
		return
	}
	s.monitorProxyInterface()
	timing.stage("physical_interface")
	s.checkProxyHealth()
	timing.stage("proxy_health")
	s.monitorSafety()
	timing.stage("safety")
	s.recoverNetwork()
	timing.stage("recovery")
	s.refreshProxySubscriptions()
	timing.stage("subscriptions")
}

func (s *Server) monitorNetwork(ctx context.Context) {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	skipped := 0
	for ctx.Err() == nil {
		if s.op.TryLock() {
			skipped = 0
			s.monitorNetworkTick()
			s.op.Unlock()
		} else {
			skipped++
			timing := s.startMonitorTiming()
			timing.result = "operation_lock_busy"
			timing.stages = append(timing.stages, fmt.Sprintf("consecutive_lock_skips=%d", skipped))
			s.recordMonitorTiming("network", timing)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func vmAlive(profile, workspace string) bool {
	if containerenv.Configured(profile) {
		environment, err := containerenv.Load(profile)
		if err != nil {
			return false
		}
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		state, err := environment.State(ctx)
		return err == nil && state.Running
	}
	if workspace == "" {
		return false
	}
	b, e := os.ReadFile(filepath.Join(profile, "state", "lima", cage.InstanceName(profile, workspace), "cage-running.json"))
	if e != nil {
		return false
	}
	var record struct {
		PID     int    `json:"pid"`
		Started string `json:"started"`
	}
	if json.Unmarshal(b, &record) != nil || record.PID < 1 {
		return false
	}
	return processExists(record.PID) && cage.ProcessStartMatches(record.PID, record.Started)
}
func (s *Server) vmRunning() bool {
	if s.windowsGuest != nil {
		s.mu.Lock()
		defer s.mu.Unlock()
		return s.windowsState.Running
	}
	if s.macosGuest != nil {
		return macOSInstanceRunning(s.instanceDir())
	}
	return vmAlive(s.profile, s.environmentDir())
}
