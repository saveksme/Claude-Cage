package workbench

import (
	"context"
	_ "embed"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"al.essio.dev/pkg/shellescape"
	"github.com/sylvinus/agent-vm/internal/cage"
	"github.com/sylvinus/agent-vm/internal/containerenv"
	"github.com/sylvinus/agent-vm/internal/diagnostics"
	"github.com/sylvinus/agent-vm/internal/exitpolicy"
	"github.com/sylvinus/agent-vm/internal/paths"
	"github.com/sylvinus/agent-vm/internal/usererror"
	"go.yaml.in/yaml/v3"
)

//go:embed safety_probe.py
var guestSafetyProbe string

type safetyState struct {
	MacOSExitCandidate *macOSExitCandidate `json:"macos_exit_candidate,omitempty"`
	pauseVersion       uint64
	monitorError       string
	Gate               *cage.GateStatus   `json:"gate,omitempty"`
	Report             *cage.SafetyReport `json:"report,omitempty"`
	Error              string             `json:"error,omitempty"`
	ExitIP             string             `json:"exit_ip,omitempty"`
	VerifiedAt         time.Time          `json:"verified_at,omitempty"`
}

type networkObservation struct {
	Status int    `json:"status"`
	IP     string `json:"ip"`
}
type macIPv6Probe struct {
	Name          string `json:"name,omitempty"`
	Result        string `json:"result"`
	GlobalSources int    `json:"globalSources"`
	BoundIndex    int    `json:"boundIndex"`
	RouteVerified bool   `json:"routeVerified"`
}
type guestObservation struct {
	IPv6UnscopedAbsent bool           `json:"ipv6_unscoped_absent,omitempty"`
	IPv6Unbound        macIPv6Probe   `json:"ipv6_unbound,omitempty"`
	IPv6Scoped         []macIPv6Probe `json:"ipv6_scoped,omitempty"`
	IPv6LinkSent       bool           `json:"ipv6_link_sent,omitempty"`
	IPv6LinkInterface  string         `json:"ipv6_link_interface,omitempty"`

	ProcessLocale       string             `json:"process_locale,omitempty"`
	SystemLocale        string             `json:"system_locale,omitempty"`
	SystemLanguage      string             `json:"system_language,omitempty"`
	TZ                  string             `json:"tz"`
	Lang                string             `json:"lang"`
	LCAll               string             `json:"lc_all"`
	SystemTimezone      string             `json:"system_timezone"`
	LocaleValid         bool               `json:"locale_valid"`
	LocaltimeTarget     string             `json:"localtime_target,omitempty"`
	UTCOffsetExpected   *int               `json:"utc_offset_expected,omitempty"`
	UTCOffsetActual     *int               `json:"utc_offset_actual,omitempty"`
	UTCOffsetSystem     *int               `json:"utc_offset_system,omitempty"`
	PublicConnected     bool               `json:"public_connected"`
	ManagementConnected bool               `json:"management_connected"`
	IPv6Connected       bool               `json:"ipv6_connected"`
	IPv6DefaultRoutes   int                `json:"ipv6_default_routes"`
	UDPAttempted        bool               `json:"udp_attempted"`
	PublicDNSAnswered   bool               `json:"public_dns_answered"`
	PrivateFile         string             `json:"private_file"`
	SharedFile          bool               `json:"shared_file"`
	Egress              networkObservation `json:"egress"`
	DNS                 networkObservation `json:"dns"`

	// Reported by the Linux probe only: direct DNS transports, host-side
	// endpoints and resolver configuration, which the host network layer
	// cannot observe from denied connections alone.
	LinkLocalConnected     *bool               `json:"link_local_connected,omitempty"`
	ProxyEndpointConnected *bool               `json:"proxy_endpoint_connected,omitempty"`
	DNSUDPAttempted        bool                `json:"dns_udp_attempted,omitempty"`
	DNSTCPConnected        *bool               `json:"dns_tcp_connected,omitempty"`
	DoTConnected           *bool               `json:"dot_connected,omitempty"`
	Resolvers              resolverObservation `json:"resolvers,omitempty"`
	IPv6GlobalAddresses    *int                `json:"ipv6_global_addresses,omitempty"`
}
type resolverObservation struct {
	Count    *int  `json:"count"`
	Confined *bool `json:"confined"`
}
type browserObservation struct {
	Timezone         string             `json:"timezone"`
	ExpectedTimezone string             `json:"expected_timezone"`
	Language         string             `json:"language"`
	Platform         string             `json:"platform"`
	Network          networkObservation `json:"network"`
}

func (s *Server) gateClient() (*cage.GateClient, error) {
	return cage.OpenGateClient(s.instanceDir())
}

func (s *Server) publishGate(state cage.GateStatus) {
	s.mu.Lock()
	defer s.mu.Unlock()
	old := s.safety.Gate
	if old != nil && old.RunID == state.RunID && old.Epoch > state.Epoch {
		return
	}
	s.safety.Gate = &state
	if state.Mode == cage.GateOpen && state.Report != nil {
		s.safety.Report = state.Report
		// A repeated status poll of the old grant is not a new authorization.
		if old == nil || old.RunID != state.RunID || old.Epoch != state.Epoch {
			s.safety.Error = ""
			s.safety.monitorError = ""
			s.exitProbeError = ""
		}
	}
}

// A gate grant resolves a monitoring failure. Independent diagnostics, such
// as a location lookup failure, are cleared by the operation that owns them.
func (s *Server) currentNetworkErrorLocked() string {
	reason := s.networkErrorLocked()
	if recovery := s.networkRecoveryMessageLocked(time.Now()); recovery != "" {
		if reason == "" {
			return recovery
		}
		return reason + "; " + recovery
	}
	return reason
}

func (s *Server) networkErrorLocked() string {
	if s.networkIntentError != "" {
		return s.networkIntentError
	}
	if s.safety.monitorError != "" {
		return s.safety.monitorError
	}
	if s.exitProbeError != "" {
		return s.exitProbeError
	}
	return s.locationError
}

// A probe can confirm the IP and still fail to resolve its location. Only
// a successful location lookup resolves that second diagnostic.
func (s *Server) recordLocationProbeLocked(loc Location, err error) {
	if err != nil && loc.IP == "" {
		s.exitProbeError = err.Error()
		return
	}
	s.exitProbeError = ""
	if err != nil {
		s.locationError = err.Error()
		return
	}
	s.location = &loc
	if loc.CountryCode != "" {
		s.locationError = ""
	}
}

// Location probes outside the periodic monitor must revoke unsafe observations
// too. Bind the result to the applied proxy generation so a late response from
// a previous node cannot revoke the new node's authorization.
func (s *Server) finishLocationProbe(cfg cage.Config, loc Location, probeErr error) error {
	s.safetyOp.Lock()
	defer s.safetyOp.Unlock()
	current, err := loadConfig(s.configPath)
	if err != nil {
		return err
	}
	if current.ProxyURL != cfg.ProxyURL || current.ProxyRevision != cfg.ProxyRevision || current.DNSURL != cfg.DNSURL {
		return nil
	}
	observed := loc.exitLocation()
	state, reason := exitpolicy.CheckExitCountry(loc.IP, &observed)
	s.mu.Lock()
	// A fresh lookup supersedes any cached result for this address, including
	// an older non-mainland result followed by a rejection or lookup failure.
	delete(s.locations, loc.IP)
	if probeErr != nil && s.location != nil && s.location.IP == loc.IP {
		s.location = nil
	}
	s.recordLocationProbeLocked(loc, probeErr)
	s.safety.ExitIP = loc.IP
	unsafe := probeErr != nil || state != cage.CheckPassed
	if unsafe {
		if s.checkCancel != nil {
			s.checkCancel()
		}
		if s.monitorCancel != nil {
			s.monitorCancel()
		}
		s.safety.Error, s.safety.monitorError = reason, reason
	}
	s.mu.Unlock()
	if !unsafe || !s.vmRunning() {
		return nil
	}
	client, err := s.gateClient()
	if err != nil {
		return err
	}
	closed, err := client.Close(context.Background(), reason)
	if err != nil {
		return err
	}
	s.publishGate(closed)
	if state == cage.CheckUnknown {
		s.scheduleNetworkRecovery(closed)
	}
	return nil
}

func (s *Server) publishReport(report cage.SafetyReport) {
	copy := report
	copy.Checks = append([]cage.SafetyCheck(nil), report.Checks...)
	s.mu.Lock()
	s.safety.Report = &copy
	s.mu.Unlock()
}

func (s *Server) safetyCheck(w http.ResponseWriter, r *http.Request) {
	if s.macosGuest != nil {
		s.launch(w, "safety", s.checkMacOSNetwork)
		return
	}
	s.launch(w, "safety", s.runSafetyCheck)
}

func (s *Server) pauseNetwork(w http.ResponseWriter, r *http.Request) {
	if err := s.pauseNetworkNow("Внешняя сеть приостановлена вручную; офлайн-терминал и файлы по-прежнему доступны"); err != nil {
		requestError(w, err)
		return
	}
	jsonReply(w, map[string]bool{"paused": true})
}

func (s *Server) pauseNetworkNow(reason string) error {
	return s.revokeNetworkNow(reason, true)
}

func (s *Server) revokeNetworkNow(reason string, pause bool) error {
	var intentErr error
	s.mu.Lock()
	if pause {
		s.recovery = networkRecovery{}
		s.networkPaused = true
		s.safety.pauseVersion++
		intentErr = s.saveNetworkIntentLocked(true)
	}
	if s.checkCancel != nil {
		s.checkCancel()
	}
	if s.monitorCancel != nil {
		s.monitorCancel()
	}
	s.mu.Unlock()
	s.safetyOp.Lock()
	defer s.safetyOp.Unlock()
	client, err := s.gateClient()
	if err != nil {
		return errors.Join(intentErr, err)
	}
	state, err := client.Close(context.Background(), reason)
	if err == nil {
		s.publishGate(state)
	}
	return errors.Join(intentErr, err)
}

func (s *Server) safetyExport(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	report := s.safety.Report
	s.mu.Unlock()
	if report == nil {
		http.Error(w, "Отчёта о проверке пока нет", 404)
		return
	}
	// Exports cannot authorize networking and contain no proxy hash, address,
	// credentials, launch ticket or host filesystem paths.
	jsonReply(w, map[string]any{"policy": report.Policy, "created_at": report.CreatedAt, "checks": report.Checks, "scope": "Выборочная проверка и проверка политики во время работы; не подтверждает право на аккаунт платформы и не заменяет полный аудит изоляции"})
}

// The probe runs in Linux, while its files are created on the host. Use the
// same guest path mapping as the VM's mounts for both sides of the boundary.
func boundaryProbeInput(port int, nonce, privateFile, sharedFile, challenge string) map[string]any {
	return map[string]any{"stage": "boundary", "control_port": port, "nonce": nonce,
		"management_host": "192.168.5.2",
		"private_file":    guestPath(privateFile), "shared_file": guestPath(sharedFile), "challenge": challenge}
}

func (s *Server) guestObservation(ctx context.Context, input map[string]any) (guestObservation, error) {
	if s.windowsGuest != nil {
		return s.windowsGuestObservation(ctx, input)
	}
	if s.macosGuest != nil {
		return s.macOSGuestObservation(ctx, input)
	}
	var observation guestObservation
	data, err := json.Marshal(input)
	if err != nil {
		return observation, err
	}
	command := "python3 -c " + shellescape.Quote(guestSafetyProbe) + " " + shellescape.Quote(base64.StdEncoding.EncodeToString(data))
	output, err := s.guestControl(ctx, "exec bash -lc "+shellescape.Quote(command), "safety-probe")
	if err != nil {
		return observation, fmt.Errorf("Проверка гостевой системы не вернула полный результат: %w", err)
	}
	if err = json.Unmarshal(output, &observation); err != nil {
		return observation, errors.New("Проверка гостевой системы вернула неверный формат")
	}
	return observation, nil
}

func (s *Server) browserObservation(ctx context.Context, cfg cage.Config, network bool) (browserObservation, error) {
	if s.macosGuest != nil {
		return s.macOSBrowserObservation(ctx, cfg, network)
	}
	var observation browserObservation
	s.mu.Lock()
	token := s.credentials.Token
	s.mu.Unlock()
	body, _ := json.Marshal(map[string]any{"network": network, "timezone": cfg.Timezone})
	data, err := s.guestAPI(ctx, token, "POST", "/audit", body)
	if err != nil || json.Unmarshal(data, &observation) != nil {
		return observation, errors.New("Проверка браузера не вернула полный результат; обновите или перезапустите среду")
	}
	return observation, nil
}

// Retry only a transient network sample, before the failure drill. Settings and
// policy failures retain their evidence; no request grants external access.
func (s *Server) browserExitObservation(ctx context.Context, cfg cage.Config) (browserObservation, error) {
	observation, err := s.browserObservation(ctx, cfg, true)
	if err != nil || s.browserSettingsIssue(observation, cfg) != "" ||
		(observation.Network.Status != 0 && observation.Network.Status != http.StatusServiceUnavailable) {
		return observation, err
	}
	_ = diagnostics.New(s.profile).Record("warn", "safety-probe", fmt.Sprintf("stage=browser retry=1 status=%d", observation.Network.Status))
	s.setMessage("Проверка выхода браузера пока не удалась, выполняется одна повторная попытка; внешняя сеть остаётся закрытой…")
	timer := time.NewTimer(time.Second)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return observation, ctx.Err()
	case <-timer.C:
		return s.browserObservation(ctx, cfg, true)
	}
}

func guestSettingsMatch(v guestObservation, cfg cage.Config) bool {
	return linuxGuestSettingsMismatch(v, cfg) == ""
}

// linuxGuestSettingsMismatch names every configured value the Linux guest did
// not read back. Besides the variables and /etc/timezone it requires the UTC
// offset programs actually observe, so a stale /etc/localtime or missing
// tzdata cannot hide behind a correct TZ variable.
func linuxGuestSettingsMismatch(v guestObservation, cfg cage.Config) string {
	var mismatches []string
	if !v.LocaleValid {
		mismatches = append(mismatches, "Не удалось загрузить языковую среду системы")
	}
	if v.TZ != cfg.Timezone {
		mismatches = append(mismatches, fmt.Sprintf("Переменная TZ не совпадает (ожидалось %q, получено %q)", cfg.Timezone, v.TZ))
	}
	if v.SystemTimezone != cfg.Timezone {
		mismatches = append(mismatches, fmt.Sprintf("Файл часового пояса системы не совпадает (ожидалось %q, получено %q)", cfg.Timezone, v.SystemTimezone))
	}
	if v.Lang != cfg.Locale {
		mismatches = append(mismatches, fmt.Sprintf("LANG не совпадает (ожидалось %q, получено %q)", cfg.Locale, v.Lang))
	}
	if v.LCAll != cfg.Locale {
		mismatches = append(mismatches, fmt.Sprintf("LC_ALL не совпадает (ожидалось %q, получено %q)", cfg.Locale, v.LCAll))
	}
	if issue := effectiveTimezoneIssue(v, cfg); issue != "" {
		mismatches = append(mismatches, issue)
	}
	return strings.Join(mismatches, "; ")
}

func effectiveTimezoneIssue(v guestObservation, cfg cage.Config) string {
	if v.UTCOffsetExpected == nil || v.UTCOffsetActual == nil {
		return "Не удалось прочитать фактическое смещение UTC гостевой системы"
	}
	if *v.UTCOffsetExpected != *v.UTCOffsetActual {
		return fmt.Sprintf("Фактическое смещение UTC не совпадает с часовым поясом (ожидалось %+d с, получено %+d с)", *v.UTCOffsetExpected, *v.UTCOffsetActual)
	}
	// Read the system file separately: time.localtime observes TZ, which can
	// mask a stale or missing /etc/localtime even when it is a regular file.
	if v.UTCOffsetSystem == nil {
		return "Не удалось прочитать фактическое смещение UTC из файла часового пояса системы"
	}
	if *v.UTCOffsetSystem != *v.UTCOffsetExpected {
		return fmt.Sprintf("Смещение UTC в файле часового пояса системы не совпадает (ожидалось %+d с, получено %+d с)", *v.UTCOffsetExpected, *v.UTCOffsetSystem)
	}
	if v.LocaltimeTarget != "" && v.LocaltimeTarget != "/usr/share/zoneinfo/"+cfg.Timezone {
		return fmt.Sprintf("Ссылка локального времени системы не совпадает (ожидалось %q, получено %q)", "/usr/share/zoneinfo/"+cfg.Timezone, v.LocaltimeTarget)
	}
	return ""
}
func browserSettingsMatch(v browserObservation, cfg cage.Config) bool {
	return browserSettingsMismatch(v, cfg) == ""
}

// guestProxyEndpoint is the user's proxy as the guest would have to address
// it: a proxy bound on the host is reached through the VM gateway address.
// The guest must never reach it directly, only through the host network layer.
func guestProxyEndpoint(cfg cage.Config, managementHost string) (string, int) {
	u, err := url.Parse(cfg.ProxyURL)
	if err != nil {
		return "", 0
	}
	port, err := strconv.Atoi(u.Port())
	if err != nil || port <= 0 {
		return "", 0
	}
	host := u.Hostname()
	if ip := net.ParseIP(host); strings.EqualFold(host, "localhost") || (ip != nil && (ip.IsLoopback() || ip.IsUnspecified())) {
		host = managementHost
	}
	return host, port
}

// Missing Linux observations stay unknown; confirmed means a connection succeeded.
func hostReachIssue(v guestObservation, linux, proxyExpected bool) (issue string, confirmed bool) {
	switch {
	case v.LinkLocalConnected != nil && *v.LinkLocalConnected:
		return "Гостевая система напрямую подключилась к link-local адресу метаданных (169.254.169.254)", true
	case v.ProxyEndpointConnected != nil && *v.ProxyEndpointConnected:
		return "Гостевая система в обход сетевого уровня вне среды напрямую подключилась к порту пользовательского прокси", true
	case linux && v.LinkLocalConnected == nil:
		return "Не удалось прочитать результат прямого подключения к link-local адресу метаданных", false
	case linux && proxyExpected && v.ProxyEndpointConnected == nil:
		return "Не удалось прочитать результат прямого подключения к порту пользовательского прокси", false
	}
	return "", false
}

// dnsBypassIssue reports a way around the encrypted DNS path. confirmed is
// true when the guest actually reached a resolver outside the environment.
func dnsBypassIssue(v guestObservation, linux bool) (issue string, confirmed bool) {
	switch {
	case v.DNSTCPConnected != nil && *v.DNSTCPConnected:
		return "Гостевая система напрямую подключилась к публичному DNS по TCP/53", true
	case v.DoTConnected != nil && *v.DoTConnected:
		return "Гостевая система напрямую подключилась к публичному DNS по DoT/853", true
	case !linux:
		return "", false
	case !v.DNSUDPAttempted:
		return "UDP/53-проба прямого подключения из гостевой системы не отправилась", false
	case v.DNSTCPConnected == nil || v.DoTConnected == nil:
		return "Не удалось прочитать результат прямого подключения к публичному DNS по TCP/53 или DoT/853", false
	case v.Resolvers.Count == nil || *v.Resolvers.Count < 0 || v.Resolvers.Confined == nil:
		return "Не удалось прочитать конфигурацию резолвера гостевой системы", false
	case *v.Resolvers.Count == 0:
		return "В гостевой системе не настроен ни один резолвер", false
	case !*v.Resolvers.Confined:
		return "Резолвер гостевой системы указывает на адрес вне среды; запросы могут обходить шифрованный DNS", true
	}
	return "", false
}

func (s *Server) ipv6PolicyVerified(v guestObservation, before, after cage.GateStatus, networkLayout bool) bool {
	if v.IPv6Connected || !after.PolicyVerified {
		return false
	}
	if s.macosGuest != nil {
		return networkLayout && (macOSIPv6LinkVerified(v, before, after) ||
			(v.IPv6DefaultRoutes == 0 && v.IPv6UnscopedAbsent && v.IPv6Unbound.Result == "no-route"))
	}
	if s.windowsGuest == nil && (v.IPv6GlobalAddresses == nil || *v.IPv6GlobalAddresses != 0) {
		return false
	}
	return v.IPv6DefaultRoutes == 0 || after.Counters.IPv6Denied > before.Counters.IPv6Denied
}

func browserSettingsMismatch(v browserObservation, cfg cage.Config) string {
	var mismatches []string
	if v.Timezone == "" || v.Timezone != v.ExpectedTimezone {
		mismatches = append(mismatches, fmt.Sprintf("Часовой пояс не совпадает (ожидалось %q, получено %q)", cfg.Timezone, v.Timezone))
	}
	// Chromium's Japanese UI locale may report the language-only tag even
	// with ja-JP preferences. Keep other regional language distinctions.
	japanese := strings.EqualFold(cfg.BrowserLanguage, "ja-JP") && strings.EqualFold(v.Language, "ja")
	if !strings.EqualFold(v.Language, cfg.BrowserLanguage) && !japanese {
		mismatches = append(mismatches, fmt.Sprintf("Язык не совпадает (ожидалось %q, получено %q)", cfg.BrowserLanguage, v.Language))
	}
	if !strings.HasPrefix(v.Platform, "Linux") {
		mismatches = append(mismatches, fmt.Sprintf("Идентификатор системы не совпадает (ожидалось Linux, получено %q)", v.Platform))
	}
	return strings.Join(mismatches, "; ")
}

func (s *Server) inspectVMLayout() (bool, bool) {
	if s.windowsGuest != nil {
		return s.windowsVMLayout()
	}
	if s.macosGuest != nil {
		return s.macOSVMLayout()
	}
	if containerenv.Configured(s.profile) {
		environment, err := containerenv.Load(s.profile)
		if err != nil {
			return false, false
		}
		ctx, cancel := s.controlContext()
		defer cancel()
		inspection, err := environment.Inspect(ctx)
		if err != nil {
			return false, false
		}
		return inspection.FilesystemConfined, inspection.NetworkConfined
	}
	workspace, err := validateWorkspace(s.environmentDir(), s.profile)
	if err != nil {
		return false, false
	}
	data, err := os.ReadFile(filepath.Join(s.profile, "state", "lima", cage.InstanceName(s.profile, workspace), "lima.yaml"))
	if err != nil {
		return false, false
	}
	var spec struct {
		Mounts []struct {
			Location   string `yaml:"location"`
			MountPoint string `yaml:"mountPoint"`
			Writable   bool   `yaml:"writable"`
			SSHFS      struct {
				Driver string `yaml:"sftpDriver"`
			} `yaml:"sshfs"`
		} `yaml:"mounts"`
		Networks  []any  `yaml:"networks"`
		MountType string `yaml:"mountType"`
	}
	if yaml.Unmarshal(data, &spec) != nil {
		return false, false
	}
	shares := len(spec.Mounts) == 1 && spec.MountType == "reverse-sshfs"
	if shares {
		m := spec.Mounts[0]
		shares = paths.Equal(paths.Host(m.Location), paths.Host(workspace)) && m.MountPoint == guestPath(workspace) && m.Writable && m.SSHFS.Driver == "builtin"
	}
	return shares, len(spec.Networks) == 0
}

func (s *Server) managementRequiresSession(ctx context.Context) bool {
	client := &http.Client{Transport: &http.Transport{Proxy: nil}, Timeout: 3 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("redirect refused") }}
	defer client.CloseIdleConnections()
	req, _ := http.NewRequestWithContext(ctx, "GET", s.origin+"/api/settings", nil)
	response, err := client.Do(req)
	if err != nil {
		return false
	}
	response.Body.Close()
	return response.StatusCode == http.StatusUnauthorized
}

// A location is cached by its measured address, never borrowed from the last
// proxy request. The provider's free quota makes per-heartbeat lookups wasteful.
func (s *Server) locationForIP(ctx context.Context, cfg cage.Config, ip string) (Location, error) {
	s.mu.Lock()
	loc, ok := s.locations[ip]
	if !ok && s.location != nil && s.location.IP == ip {
		loc, ok = *s.location, true
	}
	s.mu.Unlock()
	if ok && time.Since(loc.CheckedAt) < time.Hour && loc.CountryCode != "" {
		return loc, nil
	}
	loc, err := probeLocationForIP(ctx, cfg, ip)
	if err != nil {
		return Location{}, err
	}
	s.mu.Lock()
	if s.locations == nil {
		s.locations = map[string]Location{}
	}
	if len(s.locations) >= 64 {
		for key, value := range s.locations {
			if time.Since(value.CheckedAt) >= time.Hour {
				delete(s.locations, key)
			}
		}
		if len(s.locations) >= 64 {
			for key := range s.locations {
				delete(s.locations, key)
				break
			}
		}
	}
	s.locations[ip] = loc
	s.mu.Unlock()
	return loc, nil
}

func (s *Server) checkExitPolicy(ctx context.Context, cfg cage.Config, ip string) (cage.CheckState, string) {
	policy := cfg.ExitPolicy.Normalized()
	if state, message := exitpolicy.CheckExitCountry(ip, nil); state == cage.CheckFailed {
		return state, message
	}
	loc, err := s.locationForIP(ctx, cfg, ip)
	if err != nil {
		return cage.CheckUnknown, "Геолокация выхода временно недоступна; подтвердить выход за пределами материкового Китая нельзя, внешняя сеть остаётся закрытой"
	}
	observed := loc.exitLocation()
	state, message := policy.Evaluate(ip, &observed)
	s.mu.Lock()
	s.recordLocationProbeLocked(loc, nil)
	s.mu.Unlock()
	return state, message
}

func (s *Server) runSafetyCheck() (returned error) {
	defer func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.networkPaused {
			returned = context.Canceled
			s.safety.Error = ""
		}
	}()
	if err := s.attach(); err != nil {
		return err
	}
	cfg, err := loadConfig(s.configPath)
	if err != nil {
		return err
	}
	if err = cfg.RequireManagedProxy(s.profile); err != nil {
		_ = s.closeProxyGate(err.Error())
		return err
	}
	client, err := s.gateClient()
	if err != nil {
		s.mu.Lock()
		s.safety.Error = err.Error()
		s.mu.Unlock()
		return err
	}
	ctx, cancel := context.WithTimeout(s.operationContext(), 170*time.Second)
	defer cancel()
	s.safetyOp.Lock()
	s.mu.Lock()
	paused := s.networkPaused
	if !paused {
		s.checkCancel = cancel
		s.safety.MacOSExitCandidate = nil
	}
	s.mu.Unlock()
	if paused {
		s.safetyOp.Unlock()
		return errors.New("Внешняя сеть приостановлена вручную; повторная проверка может восстановить доступ")
	}
	defer func() { s.mu.Lock(); s.checkCancel = nil; s.mu.Unlock() }()
	state, err := client.BeginCheck(ctx)
	if err == nil {
		s.publishGate(state)
	}
	s.safetyOp.Unlock()
	if err != nil {
		_, _ = client.Close(context.Background(), "Проверка не запущена, внешняя сеть остаётся закрытой")
		return err
	}
	granted := false
	defer func() {
		s.safetyOp.Lock()
		defer s.safetyOp.Unlock()
		s.mu.Lock()
		paused := s.networkPaused
		s.mu.Unlock()
		if !granted && !paused {
			reason := "Проверка доступа к сети ещё не завершена, полных результатов пока нет. Внешняя сеть остаётся закрытой."
			if returned != nil {
				reason = returned.Error()
			}
			closed, e := client.Close(context.Background(), reason)
			if e == nil {
				s.publishGate(closed)
			}
		}
		s.mu.Lock()
		if returned != nil {
			s.safety.Error = returned.Error()
		} else {
			s.safety.Error = ""
		}
		s.mu.Unlock()
	}()
	if cfg.ExitPolicy.NeedsBinding() {
		s.setMessage("Первая привязка IP или региона этого узла выхода…")
		loc, err := probeLocation(ctx, cfg)
		if err != nil {
			return err
		}
		cfg.ExitPolicy = cfg.ExitPolicy.BindMissing(loc.exitLocation())
		observed := loc.exitLocation()
		if result, message := cfg.ExitPolicy.Evaluate(loc.IP, &observed); result != cage.CheckPassed {
			return errors.New(message)
		}
		if err := s.saveExitPolicyConfig(cfg); err != nil {
			return err
		}
		// Completing an empty anchor changes the fingerprint. Revoke the first
		// check and collect all evidence again under the bound configuration.
		s.safetyOp.Lock()
		_, err = client.SyncProxyRevision(ctx)
		if err == nil {
			state, err = client.BeginCheck(ctx)
		}
		s.safetyOp.Unlock()
		if err != nil {
			return err
		}
		s.publishGate(state)
	}
	report := cage.SafetyReport{Policy: cage.SafetyPolicyVersion, ID: randomToken()[:32], RunID: state.RunID, CheckID: state.CheckID, Configuration: cfg.Fingerprint(), CreatedAt: time.Now()}
	defer func() {
		// Preserve partial reports too: cancellation or a transport failure must
		// not leave the last successful report as the only diagnostic evidence.
		s.publishReport(report)
		if err := writePrivate(filepath.Join(s.profile, "last-safety-report.json"), report); err != nil {
			_ = diagnostics.New(s.profile).Record("error", "safety", "Не удалось сохранить отчёт о проверке: "+err.Error())
		}
		for _, check := range report.Checks {
			level := "info"
			if check.Critical && check.State != cage.CheckPassed {
				level = "warn"
			}
			_ = diagnostics.New(s.profile).Record(level, "safety", fmt.Sprintf("check_started=%s check=%s state=%s critical=%t evidence=%s remedy=%s operation_error=%v", report.CreatedAt.UTC().Format(time.RFC3339Nano), check.ID, check.State, check.Critical, check.Evidence, check.Remedy, returned))
		}
	}()
	for _, item := range [][2]string{{"egress_policy", "Ограничения исходящих соединений вне среды"}, {"proxy_transport", "Канал проверки терминала"}, {"dns_transport", "DNS и ограничения резолвинга"}, {"guest_settings", "Часовой пояс и язык системы"}, {"browser_settings", "Часовой пояс и язык браузера"}, {"filesystem_boundary", "Общие файлы и приватный каталог хоста"}, {"management_boundary", "Интерфейс управления хостом"}, {"fail_closed", "Отказ прокси с закрытием"}, {"udp_policy", "Ограничения исходящего UDP"}, {"ipv6_policy", "Ограничения исходящего IPv6"}, {"exit_consistency", "Выход соответствует сохранённым правилам"}} {
		report.Checks = append(report.Checks, cage.SafetyCheck{ID: item[0], Title: item[1], Critical: true, State: cage.CheckUnknown, Evidence: "Доказательств пока нет", Remedy: "Посмотрите результат после завершения проверки; неизвестные пункты не считаются пройденными автоматически", CheckedAt: report.CreatedAt})
	}
	set := func(id string, result cage.CheckState, evidence, remedy string) {
		for i := range report.Checks {
			if report.Checks[i].ID == id {
				report.Checks[i].State = result
				report.Checks[i].Evidence = evidence
				report.Checks[i].Remedy = remedy
				report.Checks[i].CheckedAt = time.Now()
			}
		}
		s.publishReport(report)
	}
	s.publishReport(report)
	if s.macosGuest != nil {
		// BeginCheck has already revoked external access. This path is shared
		// by initial setup, startup, controller reconnects and later rechecks.
		if err := s.syncMacOSRegion(ctx, cfg); err != nil {
			set("guest_settings", cage.CheckUnknown, err.Error(), "Сверьте сохранённые часовой пояс и язык и повторите проверку")
			return err
		}
	}
	shares, networkLayout := s.inspectVMLayout()
	private, err := os.CreateTemp(s.profile, ".cage-private-probe-*")
	if err != nil {
		return usererror.Wrap("Создание проверочного файла в приватном каталоге", err, "Проверьте права на запись в каталог конфигурации Cage и свободное место на диске, затем повторите проверку. Внешняя сеть остаётся закрытой.")
	}
	defer os.Remove(private.Name())
	defer private.Close()
	shareRoot := s.environmentDir()
	if s.macosGuest != nil {
		shareRoot = s.workspace()
		approved, e := s.projectWorkspace(shareRoot)
		if e != nil || isClientMountPath(approved) {
			return errors.New("Сначала подключите в рабочей среде macOS рабочее пространство по умолчанию или авторизованный проект хоста, затем проверьте файловые границы")
		}
		if e = s.ensureProjectShare(approved); e != nil {
			set("filesystem_boundary", cage.CheckUnknown, e.Error(), "Сначала завершите вход в гостевую систему, включите расширение файловой системы или авторизуйте доступ к рабочему пространству, затем повторите проверку")
			var failure *projectShareError
			if errors.As(e, &failure) {
				return &projectShareError{Path: approved, Recovery: failure.Recovery, Message: failure.Message}
			}
			return e
		}
		shareRoot = approved
	}
	shared, err := os.CreateTemp(shareRoot, ".cage-share-probe-*")
	if err != nil {
		return usererror.Wrap("Создание проверочного файла в общем каталоге проекта", err, "Убедитесь, что каталог среды существует и доступен для записи, и повторите проверку; не удаляйте каталог личной конфигурации. Внешняя сеть остаётся закрытой.")
	}
	defer os.Remove(shared.Name())
	defer shared.Close()
	challenge := randomToken()
	if _, err = shared.WriteString(challenge); err != nil {
		return err
	}
	if err = shared.Sync(); err != nil {
		return err
	}
	control, _ := url.Parse(s.origin)
	port, _ := strconv.Atoi(control.Port())
	s.setMessage("Проверка офлайн-ограничений, общих файлов и конфигурации системы…")
	boundaryInput := boundaryProbeInput(port, report.ID, private.Name(), shared.Name(), challenge)
	boundaryInput["timezone"] = cfg.Timezone
	if s.windowsGuest != nil {
		if err := s.windowsBoundaryInput(shareRoot, private.Name(), shared.Name(), challenge, boundaryInput); err != nil {
			return err
		}
	}
	if s.macosGuest != nil {
		boundaryInput["run_id"] = state.RunID
		boundaryInput["check_id"] = state.CheckID
	}
	if containerenv.Configured(s.profile) {
		boundaryInput["management_host"] = containerenv.GatewayIP
	}
	linuxProbe := s.windowsGuest == nil && s.macosGuest == nil
	if linuxProbe {
		if host, port := guestProxyEndpoint(cfg, boundaryInput["management_host"].(string)); port != 0 {
			boundaryInput["proxy_host"], boundaryInput["proxy_port"] = host, port
		}
	}
	boundary, boundaryErr := s.guestObservation(ctx, boundaryInput)
	after, err := client.Status(ctx)
	_ = diagnostics.New(s.profile).Record("info", "safety-probe", fmt.Sprintf("stage=boundary error=%v status_error=%v observation=%+v counters_before=%+v counters_after=%+v shares=%t network_layout=%t", boundaryErr, err, boundary, state.Counters, after.Counters, shares, networkLayout))
	if err != nil {
		return err
	}
	if boundaryErr == nil {
		if s.guestSettingsOK(boundary, cfg) {
			evidence := "Прочитанные в процессах и системе гостевой системы часовой пояс и язык соответствуют применённой конфигурации"
			if linuxProbe {
				evidence += "; фактическое смещение UTC в процессах и файле часового пояса системы соответствует применённому часовому поясу"
			}
			set("guest_settings", cage.CheckPassed, evidence, "")
		} else {
			evidence := "Прочитанные системные значения не совпадают с применённой конфигурацией"
			if linuxProbe {
				if detail := linuxGuestSettingsMismatch(boundary, cfg); detail != "" {
					evidence += ": " + detail
				}
			}
			set("guest_settings", cage.CheckFailed, evidence, "Повторно примените часовой пояс и язык и перезапустите среду")
		}
		_, _ = shared.Seek(0, io.SeekStart)
		sharedData, _ := io.ReadAll(io.LimitReader(shared, 256))
		if shares && boundary.PrivateFile == "unreachable" && boundary.SharedFile && string(sharedData) == challenge+":guest" {
			set("filesystem_boundary", cage.CheckPassed, "Проверочный обмен с общим каталогом прошёл успешно; приватный каталог хоста недоступен для чтения; базовые общие каталоги среды и явно открытые проекты используют передачу с ограничением по каталогу, внутри проекта Git может читать и писать", "")
		} else {
			set("filesystem_boundary", cage.CheckFailed, "Общий обмен, проба приватного каталога или область монтирования не соответствуют ожиданиям", "Проверьте общие каталоги; не открывайте общий доступ к домашнему каталогу или каталогу конфигурации Cage")
		}
		if after.PolicyVerified && networkLayout && after.Configuration == cfg.Fingerprint() && !boundary.PublicConnected && after.Counters.TCPDenied > state.Counters.TCPDenied {
			set("egress_policy", cage.CheckPassed, "Проверка политики во время работы соответствует ожиданиям; дополнительные сетевые адаптеры не настроены; публичные TCP-запросы во время проверки отклонены сетевым уровнем вне среды", "")
		}
		hostReach, hostReachConfirmed := hostReachIssue(boundary, linuxProbe, boundaryInput["proxy_port"] != nil)
		if hostReach == "" && !boundary.ManagementConnected && after.Counters.PrivateDenied > state.Counters.PrivateDenied && s.managementRequiresSession(ctx) {
			evidence := "Подключение из гостевой системы к порту управления хоста отклонено; доступ к локальным интерфейсам без сеанса отклонён"
			if linuxProbe {
				evidence += "; проба прямого подключения к link-local адресу метаданных не установила соединение"
				if boundaryInput["proxy_port"] != nil {
					evidence += "; проба прямого подключения к порту пользовательского прокси не установила соединение"
				}
			}
			set("management_boundary", cage.CheckPassed, evidence, "")
		} else {
			result, evidence := cage.CheckUnknown, "Доказательства отказа в доступе к интерфейсу управления неполны"
			if boundary.ManagementConnected {
				result = cage.CheckFailed
			}
			if hostReach != "" {
				evidence = hostReach
				if hostReachConfirmed {
					result = cage.CheckFailed
				}
			}
			set("management_boundary", result, evidence, "Остановите среду и запустите её снова; не открывайте порт управления хоста")
		}
		if boundary.UDPAttempted && after.Counters.UDPDenied > state.Counters.UDPDenied && after.PolicyVerified {
			set("udp_policy", cage.CheckPassed, "UDP-проба из гостевой системы отправлена, сетевой уровень вне среды зафиксировал отказ; отсутствие ответа само по себе не считается доказательством", "")
		}
		ipv6Verified := s.ipv6PolicyVerified(boundary, state, after, networkLayout)
		if ipv6Verified && s.macosGuest != nil && macOSIPv6LinkVerified(boundary, state, after) {
			set("ipv6_policy", cage.CheckPassed, fmt.Sprintf("Обычная проверка маршрута IPv6 явно недоступна; %d маршрутов по умолчанию, привязанных к интерфейсам, проверены по одному — соединение не установлено или обнаружен внешний адрес источника. Единственный сетевой адаптер гостевой системы %s отбрасывает случайные UDP-пробы IPv6 этого раунда на входе Ethernet-кадров.", boundary.IPv6DefaultRoutes, boundary.IPv6LinkInterface), "")
		} else if ipv6Verified {
			evidence := "Политика публичного IPv6 в гостевой системе — запрет; выборка соединений не установлена, записи маршрутов или отказов соответствуют политике. Текущая версия проверяет выход IPv4"
			if linuxProbe {
				evidence += fmt.Sprintf("; глобальных адресов IPv6 в гостевой системе: %d, маршрутов по умолчанию: %d", *boundary.IPv6GlobalAddresses, boundary.IPv6DefaultRoutes)
			}
			set("ipv6_policy", cage.CheckPassed, evidence, "")
		} else if s.macosGuest != nil {
			set("ipv6_policy", cage.CheckUnknown, fmt.Sprintf("Записей маршрута IPv6 по умолчанию: %d. Обычные подключения, поинтерфейсное наблюдение и свидетельства отбрасывания текущим адаптером VZ пока совпадают не полностью.", boundary.IPv6DefaultRoutes), "Оставьте внешнюю сеть закрытой. Убедитесь, что используются совместимые средства диагностики гостевой системы и среда выполнения виртуальной машины, перезапустите и повторите проверку")
		} else if linuxProbe {
			set("ipv6_policy", cage.CheckUnknown, "Не удалось подтвердить отсутствие глобальных адресов IPv6 в гостевой системе или доказательства маршрутов и отказов IPv6 неполны", "Оставьте внешнюю сеть закрытой. Проверьте конфигурацию IPv6 гостевой системы и повторите проверку")
		}
	} else {
		message := usererror.Display("чтение результата проверки изоляции в среде", boundaryErr, "Убедитесь, что среда всё ещё работает, и повторите проверку; если ошибка повторяется, экспортируйте диагностический пакет.").Error()
		for _, id := range []string{"guest_settings", "filesystem_boundary", "egress_policy", "management_boundary", "udp_policy", "ipv6_policy"} {
			set(id, cage.CheckUnknown, message, "Повторите проверку; если она снова не даёт результата, экспортируйте диагностический пакет в настройках")
		}
	}
	s.setMessage("Проверка прокси и DNS через фиксированный канал проверки…")
	network, networkErr := s.guestObservation(ctx, map[string]any{"stage": "network"})
	normalState, err := client.Status(ctx)
	_ = diagnostics.New(s.profile).Record("info", "safety-probe", fmt.Sprintf("stage=network error=%v status_error=%v observation=%+v counters=%+v", networkErr, err, network, normalState.Counters))
	if err != nil {
		return err
	}
	if networkErr == nil && network.Egress.Status == 200 && network.Egress.IP != "" && normalState.Counters.ProbeTCP > after.Counters.ProbeTCP {
		set("proxy_transport", cage.CheckPassed, "Запросы терминала проходят через фиксированный канал проверки сетевого уровня среды, а запрос выхода HTTPS выполняет указанный прокси; произвольные сайты не открываются", "")
	} else {
		evidence := fmt.Sprintf("Среда не смогла выполнить запрос выхода через прокси (канал проверки HTTP %d); доступность прокси пока не подтверждена", network.Egress.Status)
		if network.Egress.Status == 0 {
			evidence = "Среда не получила результат запроса выхода через прокси; доступность прокси пока не подтверждена"
		}
		if networkErr != nil {
			evidence = usererror.Display("чтение результата проверки прокси", networkErr, "Убедитесь, что среда всё ещё работает.").Error()
		}
		set("proxy_transport", cage.CheckUnknown, evidence, "В настройках сети и прокси убедитесь, что узел применён и доступен для подключения, и повторите проверку")
	}
	dnsBypass, dnsBypassConfirmed := dnsBypassIssue(boundary, linuxProbe)
	if networkErr == nil && boundaryErr == nil && !boundary.PublicDNSAnswered && after.Counters.DNSDenied > state.Counters.DNSDenied && network.DNS.Status == 200 && normalState.Counters.ProbeDNS > after.Counters.ProbeDNS && dnsBypass == "" {
		evidence := "Во время проверки публичный резолвинг был отклонён; фиксированные DNS-запросы выполнены через указанный DoH и прокси"
		if linuxProbe {
			evidence += "; резолвер гостевой системы указывает только на адреса внутри среды, прямые подключения к публичному DNS по UDP/53, TCP/53 и DoT/853 не обошли шлюз"
		}
		set("dns_transport", cage.CheckPassed, evidence, "")
	} else {
		result, evidence := cage.CheckUnknown, "Записи отказа публичного резолвинга или доказательства шифрованных DNS-запросов неполны"
		if boundaryErr == nil && dnsBypass != "" {
			evidence = dnsBypass
			if dnsBypassConfirmed {
				result = cage.CheckFailed
			}
		}
		set("dns_transport", result, evidence, "Проверьте конфигурацию DNS, доступность прокси и компоненты среды")
	}
	s.setMessage("Чтение фактической конфигурации изолированного браузера…")
	browser, browserErr := s.browserExitObservation(ctx, cfg)
	_ = diagnostics.New(s.profile).Record("info", "safety-probe", fmt.Sprintf("stage=browser error=%v observation=%+v", browserErr, browser))
	if browserErr == nil {
		if s.browserSettingsIssue(browser, cfg) == "" {
			set("browser_settings", cage.CheckPassed, "Диагностическая страница браузера определила платформу гостевой системы; фактический часовой пояс и предпочитаемый язык соответствуют применённой конфигурации", "")
		} else {
			set("browser_settings", cage.CheckFailed, s.browserSettingsIssue(browser, cfg), "Обновите компоненты среды, чтобы дополнить языковой пакет браузера и применить сохранённые настройки; если ошибка остаётся, сравните ожидаемые и фактические значения полей")
		}
	} else {
		set("browser_settings", cage.CheckUnknown, browserErr.Error(), "Остановите и перезапустите среду, чтобы загрузить последние компоненты браузера, и повторите проверку")
	}
	s.setMessage("Имитация отказа прокси; текущий процесс прокси продолжает работать…")
	faultStart, err := client.SetFault(ctx, true)
	if err != nil {
		return err
	}
	fault, faultErr := s.guestObservation(ctx, map[string]any{"stage": "network"})
	faultBrowser, faultBrowserErr := s.browserObservation(ctx, cfg, true)
	faultEnd, err := client.Status(ctx)
	_ = diagnostics.New(s.profile).Record("info", "safety-probe", fmt.Sprintf("stage=fault terminal_error=%v browser_error=%v status_error=%v terminal=%+v browser=%+v counters_before=%+v counters_after=%+v", faultErr, faultBrowserErr, err, fault, faultBrowser, faultStart.Counters, faultEnd.Counters))
	if err != nil {
		return err
	}
	if faultErr == nil && faultBrowserErr == nil && fault.Egress.Status == 503 && fault.DNS.Status == 503 && faultBrowser.Network.Status == 503 && faultEnd.Counters.FaultTCP >= faultStart.Counters.FaultTCP+2 && faultEnd.Counters.FaultDNS > faultStart.Counters.FaultDNS {
		set("fail_closed", cage.CheckPassed, "В соединение, выделенное для проверки, внедрена недоступность прокси: терминал, браузер и DNS завершились ошибкой, прямого подключения не произошло; процесс прокси пользователя не остановлен", "")
	} else {
		set("fail_closed", cage.CheckUnknown, "В имитации отказа отсутствуют записи ошибок терминала, браузера или DNS", "Исправьте канал проверки или компоненты браузера и повторите; неизвестность не означает подтверждённую безопасность")
	}
	if _, err = client.SetFault(ctx, false); err != nil {
		return err
	}
	s.setMessage("Проверка статического IP или динамического диапазона регионов…")
	hostIP, hostErr := cage.ProbeExitIP(ctx, cfg)
	_ = diagnostics.New(s.profile).Record("info", "safety-probe", fmt.Sprintf("stage=host-exit error=%v ip=%s", hostErr, hostIP))
	result, message := cage.CheckPassed, "Выходы терминала, браузера и проверки хоста не попали в диапазоны материкового Китая; выход определён как находящийся за пределами материкового Китая и соответствует сохранённым правилам изменения IP; вывод ограничен выборкой проверки"
	if missing := incompleteExitSamples(hostIP, hostErr, network.Egress, networkErr, browser.Network, browserErr); missing != "" {
		result, message = cage.CheckUnknown, missing
	} else {
		for _, ip := range []string{hostIP, network.Egress.IP, browser.Network.IP} {
			observed, why := s.checkExitPolicy(ctx, cfg, ip)
			if observed == cage.CheckFailed {
				result, message = observed, why
				break
			}
			if observed == cage.CheckUnknown {
				result, message = observed, why
			}
		}
	}
	set("exit_consistency", result, message, "Выберите выход за пределами материкового Китая и сверьте статический IP или разрешённые регионы; для статического IP и неограниченных регионов нужно подтвердить страну выхода, существующая база не меняется при повторной проверке")
	report.Checks = append(report.Checks, cage.SafetyCheck{ID: "third_party_reputation", Title: "Репутация IP у третьих сторон", State: cage.CheckUnknown, CheckedAt: time.Now(), Evidence: "Оценка сообщества не запрашивается автоматически. Дополнительную проверку можно открыть в браузере Cage; её результат не заменяет доказательства базовой изоляции."})
	s.mu.Lock()
	autoLanguage, location := s.preferences.AutoLanguage, s.location
	s.mu.Unlock()
	if autoLanguage && (location == nil || location.SuggestedLocale == "") {
		report.Checks = append(report.Checks, cage.SafetyCheck{ID: "language_suggestion", Title: "Рекомендация языка по региону", State: cage.CheckUnknown, CheckedAt: time.Now(), Evidence: "Для текущего региона нет автоматической рекомендации языка, сохранён язык из конфигурации.", Remedy: "Автоматический выбор можно отключить в настройках часового пояса и языка и выбрать язык вручную"})
	}
	s.publishReport(report)
	s.mu.Lock()
	s.safety.ExitIP = hostIP
	if s.macosGuest != nil {
		s.safety.MacOSExitCandidate = nil
		if hostErr == nil && networkErr == nil && browserErr == nil {
			s.safety.MacOSExitCandidate = macOSStaticCandidate(cfg, state.RunID, hostIP, network.Egress, browser.Network)
		}
	}
	s.mu.Unlock()
	if err = report.Authorizes(state.RunID, cfg.Fingerprint(), time.Now()); err != nil {
		return err
	}
	s.safetyOp.Lock()
	defer s.safetyOp.Unlock()
	s.mu.Lock()
	paused = s.networkPaused
	s.mu.Unlock()
	if paused || ctx.Err() != nil {
		return errors.New("Проверка отменена, внешняя сеть остаётся закрытой")
	}
	state, err = client.Grant(ctx, report)
	if err != nil {
		return err
	}
	granted = true
	s.publishGate(state)
	s.mu.Lock()
	s.safety.VerifiedAt = time.Now()
	s.mu.Unlock()
	return nil
}

// Monitoring renews a short host-owned lease without replaying the disruptive
// failure drill. Lost supervision eventually closes existing guest connections.
func (s *Server) networkMonitorBlockedLocked() bool {
	job := s.jobs.snapshot()
	return s.closing || s.networkPaused || (job.Running && job.Kind != "environment-tools" && job.Kind != "claude-desktop-install")
}

func (s *Server) monitorSafety() {
	s.monitorSafetyWithProbe(cage.ProbeExitIP)
}

func (s *Server) monitorSafetyWithProbe(probe func(context.Context, cage.Config) (string, error)) {
	if !s.monitorSafetyOp.TryLock() {
		return
	}
	defer s.monitorSafetyOp.Unlock()
	timing := s.startMonitorTiming()
	defer s.recordMonitorTiming("safety", timing)
	s.mu.Lock()
	ready, busy, last := s.ready, s.networkMonitorBlockedLocked(), s.safety.VerifiedAt
	paused, closing := s.networkPaused, s.closing
	s.mu.Unlock()
	switch {
	case closing:
		timing.result = "closing"
		return
	case paused:
		timing.result = "network_paused"
		return
	case busy:
		timing.result = "job_running"
		return
	case !ready:
		timing.result = "environment_not_ready"
		return
	case time.Since(last) < 30*time.Second:
		timing.result = "not_due"
		return
	}
	client, err := s.gateClient()
	timing.stage("gate_client")
	if err != nil {
		timing.result = "gate_client_failed"
		s.mu.Lock()
		s.safety.Gate = nil
		s.safety.Error = err.Error()
		s.mu.Unlock()
		return
	}
	ctx, cancel := context.WithTimeout(s.lifetimeContext(), 45*time.Second)
	s.mu.Lock()
	s.monitorCancel = cancel
	s.mu.Unlock()
	defer func() { cancel(); s.mu.Lock(); s.monitorCancel = nil; s.mu.Unlock() }()
	state, err := client.Status(ctx)
	timing.stage("gate_status")
	if err != nil {
		timing.result = "gate_status_failed"
		s.mu.Lock()
		s.safety.Gate = nil
		s.safety.Error = err.Error()
		s.mu.Unlock()
		return
	}
	timing.until = state.Until
	s.publishGate(state)
	if state.Mode != cage.GateOpen || state.Report == nil {
		timing.result = "gate_not_open"
		// A packet helper can reconnect before the next GUI status tick. Its
		// gate stays closed until a fresh check, even though the helper never
		// exited and the new receipt is already available.
		recheckClosed := state.Reason == "Срок авторизации проверки или мониторинга истёк" || s.windowsGuest != nil && state.Reason == windowsPacketDisconnectedReason
		if state.Mode == cage.GateClosed && recheckClosed && state.Report != nil {
			s.mu.Lock()
			pending := s.recovery.RunID != ""
			s.mu.Unlock()
			if !pending {
				s.scheduleNetworkRecovery(state)
			}
		}
		return
	}
	var issue string
	var recoverable bool
	cfg, err := loadConfig(s.configPath)
	if err != nil || cfg.Fingerprint() != state.Configuration {
		issue = "Конфигурация не совпадает с работающей средой; примените настройки и повторите проверку"
	}
	if issue == "" {
		if err = state.Report.Authorizes(state.RunID, state.Configuration, time.Now()); err != nil {
			issue = err.Error()
		}
	}
	timing.stage("configuration_report")
	var ip string
	if issue == "" {
		ip, err = probe(ctx, cfg)
		timing.stage("exit_ip")
		if err != nil {
			if errors.Is(err, context.DeadlineExceeded) && ctx.Err() == nil && s.deferTimedOutExitProbe(ctx, client, state) {
				timing.result = "exit_timeout_retry"
				return
			}
			issue = "Не удалось получить выборку выхода хоста, внешняя сеть приостановлена: " + diagnostics.Redact(usererror.Display("чтение выхода хоста", err, "Повторите проверку.").Error())
			recoverable = true
		} else {
			result, message := s.checkExitPolicy(ctx, cfg, ip)
			timing.stage("exit_policy")
			if result != cage.CheckPassed {
				issue = message
				recoverable = result == cage.CheckUnknown
			}
		}
	}
	if issue == "" {
		guest, e := s.guestObservation(ctx, map[string]any{"stage": "environment", "timezone": cfg.Timezone})
		timing.stage("guest_settings")
		if e != nil || !s.guestSettingsOK(guest, cfg) {
			issue = "Не удалось подтвердить рабочее состояние часового пояса или языка системы; повторите проверку"
			recoverable = e != nil
		}
	}
	if issue == "" {
		browser, e := s.browserObservation(ctx, cfg, false)
		timing.stage("browser_settings")
		if e != nil {
			issue = "Не удалось подтвердить рабочее состояние часового пояса или языка браузера; повторите проверку"
			recoverable = true
		} else if mismatch := s.browserSettingsIssue(browser, cfg); mismatch != "" {
			issue = "Проверка конфигурации браузера не пройдена: " + mismatch
		}
	}
	if issue != "" {
		timing.result = "observation_failed"
	}
	s.finishSafetyObservation(ctx, client, state, ip, issue, recoverable)
	timing.stage("finish_observation")
}

// Keep the already granted lease unchanged while retrying a timed-out exit
// query. The gate's own timer still closes all connections at its deadline.
func (s *Server) deferTimedOutExitProbe(ctx context.Context, client *cage.GateClient, observed cage.GateStatus) bool {
	s.safetyOp.Lock()
	defer s.safetyOp.Unlock()
	s.mu.Lock()
	blocked := s.networkMonitorBlockedLocked()
	s.mu.Unlock()
	if blocked || ctx.Err() != nil {
		return true
	}
	cfg, err := loadConfig(s.configPath)
	if err != nil || cfg.Fingerprint() != observed.Configuration {
		return false
	}
	current, err := client.Status(ctx)
	if err != nil {
		return true // The existing gate expires independently if it is unreachable.
	}
	if current.RunID != observed.RunID || current.Epoch != observed.Epoch || current.Mode != cage.GateOpen {
		return true // A newer transition owns this gate.
	}
	s.mu.Lock()
	s.safety.monitorError = "Проверка выхода временно истекла по времени, выполняется повторная попытка; текущее разрешение на доступ к сети не продлено"
	s.mu.Unlock()
	return true
}

// Recheck the user operation and configuration at the actual lease write.
func (s *Server) finishSafetyMonitor(ctx context.Context, client *cage.GateClient, state cage.GateStatus, ip, issue string) {
	s.finishSafetyObservation(ctx, client, state, ip, issue, false)
}

func (s *Server) finishSafetyObservation(ctx context.Context, client *cage.GateClient, state cage.GateStatus, ip, issue string, recoverable bool) {
	timing := s.startMonitorTiming()
	timing.until = state.Until
	defer s.recordMonitorTiming("renewal", timing)
	s.safetyOp.Lock()
	defer s.safetyOp.Unlock()
	timing.stage("safety_lock")
	s.mu.Lock()
	busy := s.networkMonitorBlockedLocked()
	s.mu.Unlock()
	if busy {
		timing.result = "operation_cancelled"
		return
	} // A user operation cancelled this monitor; it owns the next transition.
	current, e := loadConfig(s.configPath)
	if e != nil || current.Fingerprint() != state.Configuration {
		issue = "Рабочая конфигурация изменилась; примените настройки заново"
		recoverable = false
	}
	timing.stage("configuration")
	if issue != "" {
		timing.result = "observation_failed"
		closed, e := client.Close(context.Background(), issue)
		timing.stage("gate_close")
		if e == nil {
			s.publishGate(closed)
			if recoverable {
				s.scheduleNetworkRecovery(closed)
			}
		}
		s.mu.Lock()
		s.safety.Error = issue
		s.safety.ExitIP = ip
		s.safety.monitorError = issue
		s.mu.Unlock()
		return
	}
	renewed, err := client.Renew(ctx, state.Report.ID)
	timing.stage("gate_renew")
	if err != nil {
		timing.result = "renew_failed"
		closed, e := client.Close(context.Background(), "Не удалось продлить рабочий мониторинг; повторите проверку")
		timing.stage("gate_close")
		if e == nil {
			s.publishGate(closed)
			s.scheduleNetworkRecovery(closed)
		}
		s.mu.Lock()
		s.safety.Error = "Не удалось продлить рабочий мониторинг; повторите проверку"
		s.mu.Unlock()
		return
	}
	timing.result = "renewed"
	s.publishGate(renewed)
	s.mu.Lock()
	s.safety.VerifiedAt = time.Now()
	s.safety.Error = ""
	s.safety.monitorError = ""
	s.exitProbeError = ""
	s.safety.ExitIP = ip
	s.mu.Unlock()
}
