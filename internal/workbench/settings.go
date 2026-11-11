// Package workbench owns the trusted host UI; guest web content never runs in it.
package workbench

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/sylvinus/agent-vm/internal/cage"
	"github.com/sylvinus/agent-vm/internal/exitpolicy"
	"github.com/sylvinus/agent-vm/internal/host"
	"github.com/sylvinus/agent-vm/internal/mobilelink"
	"github.com/sylvinus/agent-vm/internal/mounts"
	"github.com/sylvinus/agent-vm/internal/paths"
)

type Preferences struct {
	BalancedDisplay       bool   `json:"balanced_display"`
	MobileRelay           string `json:"mobile_relay,omitempty"`
	Workspace             string `json:"workspace"`
	BrowserHomeURL        string `json:"browser_home_url"`
	ClaudeTerminalCommand string `json:"claude_terminal_command"`
	Keyboard              string `json:"keyboard"`
	AutoTimezone          bool   `json:"auto_timezone"`
	AutoLanguage          bool   `json:"auto_language"`
}

const defaultBrowserHomeURL = "https://www.bing.com/"

func claudeTerminalCommand(p Preferences) string {
	if strings.TrimSpace(p.ClaudeTerminalCommand) == "" {
		return "claude"
	}
	return strings.TrimSpace(p.ClaudeTerminalCommand)
}

func browserHomeURL(p Preferences) string {
	if p.BrowserHomeURL == "" {
		return defaultBrowserHomeURL
	}
	return p.BrowserHomeURL
}

// The environment workspace is separate from the private control profile.
func environmentWorkspace(profile string) string { return cage.EnvironmentDir(profile) }

func guestPath(path string) string { return paths.Guest(paths.Host(path)) }

func (s *Server) prepareEnvironment() error {
	record, err := cage.LoadEnvironmentRecord(s.profile)
	if err != nil {
		return err
	}
	s.mu.Lock()
	p := s.preferences
	s.mu.Unlock()
	path := environmentWorkspace(s.profile)
	// Promote an existing installation's VM once, preserving its disk and login state.
	if _, err := os.Stat(filepath.Join(s.profile, "environment.json")); os.IsNotExist(err) {
		previous := s.workspace()
		if previous != "" {
			if _, err := os.Stat(filepath.Join(s.profile, "state", "lima", cage.InstanceName(s.profile, previous), "lima.yaml")); err == nil {
				path = previous
			}
		}
	}
	if err := os.MkdirAll(path, 0700); err != nil {
		return err
	}
	previous := path
	path, err = validateWorkspace(path, s.profile)
	if err != nil {
		// Older independent profiles generated their default workspace inside
		// the default profile. Keep its files and VM identity while selecting a
		// shareable workspace through the same admission used for every project.
		path, err = validateWorkspace(p.Workspace, s.profile)
		if p.Workspace == "" || err != nil {
			path = cage.DefaultEnvironmentDir(s.profile)
			if err = os.MkdirAll(path, 0700); err != nil {
				return err
			}
			path, err = validateWorkspace(path, s.profile)
			if err != nil {
				return err
			}
		}
		if record.IdentityDirectory == "" {
			record.IdentityDirectory = previous
		}
	}
	record.Directory = path
	if err = writePrivate(filepath.Join(s.profile, "environment.json"), record); err != nil {
		return err
	}
	if p.Workspace == "" || paths.Equal(paths.Host(p.Workspace), paths.Host(previous)) ||
		record.IdentityDirectory != "" && paths.Equal(paths.Host(p.Workspace), paths.Host(record.IdentityDirectory)) {
		p.Workspace = path
	}
	if err := writePrivate(filepath.Join(s.profile, "workbench.json"), p); err != nil {
		return err
	}
	s.mu.Lock()
	s.preferences = p
	s.mu.Unlock()
	return nil
}

type Settings struct {
	Preferences
	DNSURL          string          `json:"dns_url"`
	Timezone        string          `json:"timezone"`
	Locale          string          `json:"locale"`
	BrowserLanguage string          `json:"browser_language"`
	ExitPolicy      cage.ExitPolicy `json:"exit_policy"`
}
type Location struct {
	IP                       string    `json:"ip"`
	Country                  string    `json:"country"`
	CountryCode              string    `json:"country_code"`
	Region                   string    `json:"region"`
	RegionCode               string    `json:"region_code,omitempty"`
	SuggestedLocale          string    `json:"suggested_locale,omitempty"`
	SuggestedBrowserLanguage string    `json:"suggested_browser_language,omitempty"`
	City                     string    `json:"city"`
	Timezone                 string    `json:"timezone"`
	CheckedAt                time.Time `json:"checked_at"`
}
type savedProfile struct {
	Config      cage.Config `json:"config"`
	Preferences Preferences `json:"preferences"`
}

func writePrivate(path string, v any) error {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	if err = host.EnsurePrivateDir(filepath.Dir(path)); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".cage-write-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if err = host.ProtectFile(f.Name()); err == nil {
		_, err = f.Write(append(b, '\n'))
	}
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(f.Name(), path)
}
func settingsView(c cage.Config, p Preferences) Settings {
	if p.MobileRelay == mobilelink.OfficialRelay {
		p.MobileRelay = ""
	}
	p.BrowserHomeURL = browserHomeURL(p)
	p.ClaudeTerminalCommand = claudeTerminalCommand(p)
	return Settings{Preferences: p, DNSURL: c.DNSURL, Timezone: c.Timezone, Locale: c.Locale, BrowserLanguage: c.BrowserLanguage, ExitPolicy: c.ExitPolicy.Normalized()}
}
func proposedSettings(input Settings, old cage.Config, profile string) (cage.Config, Preferences, error) {
	if input.ExitPolicy == (cage.ExitPolicy{}) {
		input.ExitPolicy = old.ExitPolicy
	}
	c := cage.Config{ProxyURL: old.ProxyURL, ProxyRevision: old.ProxyRevision, DNSURL: input.DNSURL, Timezone: input.Timezone, Locale: input.Locale, BrowserLanguage: input.BrowserLanguage, ExitPolicy: input.ExitPolicy.Normalized()}
	if err := c.Validate(); err != nil {
		return c, input.Preferences, err
	}
	if input.Keyboard != "mac" && input.Keyboard != "native" {
		return c, input.Preferences, errors.New("Выберите раскладку Mac или родную для Linux")
	}
	p := input.Preferences
	p.MobileRelay = strings.TrimSuffix(strings.TrimSpace(p.MobileRelay), "/")
	if p.MobileRelay != "" && (!strings.HasPrefix(p.MobileRelay, "https://") || !mobilelink.ValidRelayOrigin(p.MobileRelay)) {
		return c, p, errors.New("Адрес ретранслятора должен быть адресом HTTPS и содержать только хост и необязательный порт")
	}
	if len(p.ClaudeTerminalCommand) > 4096 || strings.ContainsAny(p.ClaudeTerminalCommand, "\x00\r\n") {
		return c, p, errors.New("Команда терминала Claude должна занимать одну строку и не превышать 4096 байт")
	}
	p.ClaudeTerminalCommand = claudeTerminalCommand(p)
	p.BrowserHomeURL = strings.TrimSpace(browserHomeURL(p))
	home, e := url.Parse(p.BrowserHomeURL)
	if e != nil || home == nil || (home.Scheme != "https" && home.Scheme != "http") || home.Hostname() == "" || home.User != nil {
		return c, p, errors.New("Сайт браузера по умолчанию должен быть полным адресом HTTP или HTTPS и не содержать имя пользователя или пароль")
	}
	if p.Workspace != "" {
		workspace, err := validateWorkspace(p.Workspace, profile)
		if err != nil {
			return c, p, err
		}
		p.Workspace = workspace
	}
	return c, p, nil
}
func validateWorkspace(path, profile string) (string, error) {
	home, _ := os.UserHomeDir()
	if strings.HasPrefix(path, "~/") {
		path = filepath.Join(home, path[2:])
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", errors.New("Неверный путь проекта")
	}
	abs, err = paths.Resolve(abs)
	if err != nil {
		return "", errors.New("Каталог проекта не существует или недоступен")
	}
	st, err := os.Stat(abs)
	if err != nil || !st.IsDir() {
		return "", errors.New("Выберите папку проекта")
	}
	if realHome, err := paths.Resolve(home); err == nil {
		home = realHome
	}
	if executable, e := os.Executable(); e == nil {
		if real, e := paths.Resolve(executable); e == nil && cage.StorageContains(abs, real) {
			return "", errors.New("Нельзя открывать общий доступ к каталогу, где работает программа рабочей среды. Разместите установленный Cage вне проекта, перезапустите службу управления и выберите этот проект.")
		}
	}
	if mounts.UnderName(filepath.ToSlash(abs), nil) {
		return "", errors.New("Выберите корневой каталог проекта и не открывайте общий доступ к каталогам метаданных Git и других систем контроля версий")
	}
	if paths.Equal(abs, home) || filepath.Dir(abs) == abs {
		return "", errors.New("Выберите конкретный проект и не открывайте общий доступ к домашнему каталогу, конфигурации Cage или родительским каталогам, содержащим конфигурацию")
	}
	private, err := privateProjectDirectories(profile)
	if err != nil {
		return "", err
	}
	for _, dir := range private {
		if cage.StoragePathsOverlap(abs, dir) {
			return "", errors.New("Конфигурацию Cage, хранилище среды, резервные копии миграции и их родительские каталоги нельзя открывать виртуальной машине")
		}
	}
	if err := validateHostProjectData(abs, profile); err != nil {
		return "", err
	}
	return abs, nil
}

// probeLocation uses the same fail-closed transport as the VM. No host resolver,
// environment proxy, or direct fallback participates, including redirects.
func probeLocation(ctx context.Context, c cage.Config) (Location, error) {
	ip, err := cage.ProbeExitIP(ctx, c)
	if err != nil {
		return Location{}, err
	}
	if state, message := exitpolicy.CheckExitCountry(ip, nil); state == cage.CheckFailed {
		return Location{IP: ip, CheckedAt: time.Now()}, errors.New(message)
	}
	loc, err := probeLocationForIP(ctx, c, ip)
	if err != nil {
		return Location{IP: ip, CheckedAt: time.Now()}, err
	}
	observed := loc.exitLocation()
	if state, message := exitpolicy.CheckExitCountry(ip, &observed); state != cage.CheckPassed {
		return loc, errors.New(message)
	}
	return loc, nil
}

// All exit modes need country evidence. Manual locale settings only control
// whether the observed timezone/language is applied to the environment.
func probeEnvironmentLocation(ctx context.Context, c cage.Config, _ Preferences) (Location, error) {
	return probeLocation(ctx, c)
}

func (l Location) exitLocation() cage.ExitLocation {
	return cage.ExitLocation{IP: l.IP, CountryCode: l.CountryCode, Region: l.Region, City: l.City}
}

func probeLocationForIP(ctx context.Context, c cage.Config, ip string) (Location, error) {
	address := net.ParseIP(ip)
	if address == nil {
		return Location{}, errors.New("Неверный адрес выхода")
	}
	e, err := cage.NewEgress(c)
	if err != nil {
		return Location{}, err
	}
	transport := &http.Transport{Proxy: nil, DialContext: e.DialContext, ForceAttemptHTTP2: true}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 8 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("redirect refused") }}
	return lookupLocation(ctx, client, address)
}
