package workbench

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"path/filepath"
	"strings"

	"github.com/sylvinus/agent-vm/internal/cage"
	"github.com/sylvinus/agent-vm/internal/diagnostics"
	"github.com/sylvinus/agent-vm/internal/guestos"
)

func (s *Server) windowsGuestObservation(ctx context.Context, input map[string]any) (guestObservation, error) {
	var observation guestObservation
	cfg, err := loadConfig(s.configPath)
	if err != nil {
		return observation, err
	}
	input["timezone"] = cfg.Timezone
	cmd, err := guestos.WindowsRelayCommand(ctx, s.profile, "safety")
	if err != nil {
		return observation, err
	}
	data, err := json.Marshal(input)
	if err != nil {
		return observation, err
	}
	cmd.Stdin = bytes.NewReader(append(data, '\n'))
	cmd.Stderr = io.Discard
	var output bytes.Buffer
	cmd.Stdout = &boundedWindowsStatusWriter{buffer: &output, remaining: 64 << 10}
	if err = cmd.Run(); err != nil {
		return observation, errors.New("Проверка гостевой системы Windows не вернула полный результат")
	}
	var failure struct {
		Error      string `json:"error"`
		Stage      string `json:"stage"`
		Code       string `json:"error_code"`
		NativeCode int    `json:"native_code"`
	}
	if json.Unmarshal(output.Bytes(), &failure) == nil && failure.Error == "safety_probe_failed" {
		stages := map[string]bool{"request": true, "environment": true, "network": true, "public-tcp": true, "udp": true, "dns": true, "project-grant": true, "shared-read": true, "shared-write": true, "private-scope": true}
		codes := map[string]bool{"invalid_probe": true, "access_denied": true, "file_io": true, "socket": true, "probe_failed": true}
		if stages[failure.Stage] && codes[failure.Code] && failure.NativeCode >= 0 && failure.NativeCode <= 65535 {
			_ = diagnostics.New(s.profile).Record("warn", "windows-safety", fmt.Sprintf("stage=%s code=%s native_code=%d", failure.Stage, failure.Code, failure.NativeCode))
		}
	}
	return decodeWindowsObservation(output.Bytes())
}

func decodeWindowsObservation(data []byte) (guestObservation, error) {
	var observation guestObservation
	var status struct {
		Error string `json:"error"`
		Stage string `json:"stage"`
	}
	if json.Unmarshal(data, &status) != nil {
		return observation, errors.New("Проверка гостевой системы Windows не завершена, внешняя сеть остаётся закрытой; посмотрите этап проверки и повторите")
	}
	if status.Error != "" {
		stage := map[string]string{"request": "Проверка запроса", "environment": "Чтение системных значений", "network": "Прокси и DNS", "public-tcp": "Ограничения публичных подключений", "udp": "Ограничения UDP", "dns": "Ограничения публичного DNS", "project-grant": "Авторизация проектов", "shared-read": "Чтение общих файлов", "shared-write": "Запись общих файлов", "private-scope": "Ограничения приватного каталога"}[status.Stage]
		if stage == "" {
			stage = "Гостевая система"
		}
		return observation, errors.New("Windows " + stage + "Проверка не завершена, внешняя сеть остаётся закрытой")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	if decoder.Decode(&observation) != nil || decoder.Decode(new(any)) != io.EOF {
		return observation, errors.New("Проверка гостевой системы Windows вернула недействительный результат")
	}
	if observation.TZ == "" || observation.SystemTimezone == "" || observation.ProcessLocale == "" || observation.SystemLocale == "" || !observation.LocaleValid {
		return observation, errors.New("В проверке гостевой системы Windows отсутствует результат чтения системных значений, внешняя сеть остаётся закрытой")
	}
	return observation, nil
}

func (s *Server) windowsVMLayout() (bool, bool) {
	ctx, cancel := s.controlContext()
	defer cancel()
	report, err := guestos.InspectHyperV(ctx, s.windowsGuest.VMID)
	if err != nil || report.VM == nil || report.Lookup != "found" {
		return false, false
	}
	vm := report.VM
	network := vm.NetworkAdapterCount == 0 && vm.Generation == 2 && vm.SecureBoot && vm.VirtualTPM
	projects, err := s.projectPaths()
	if err != nil {
		return false, network
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	allowed := make(map[string]bool, len(projects))
	for _, path := range projects {
		allowed[path] = true
	}
	for path, share := range s.projectShares {
		if share == nil || share.windowsProject == nil || !allowed[path] {
			return false, network
		}
		select {
		case <-share.done:
			return false, network
		default:
		}
	}
	share := s.projectShares[s.environmentDir()]
	return share != nil && share.windowsProject != nil && vm.DiskCount == 1 && vm.SingleLocalVHDX != nil && *vm.SingleLocalVHDX, network
}

func windowsGuestSettingsMatch(observation guestObservation, cfg cage.Config) bool {
	locale := strings.ReplaceAll(strings.TrimSuffix(cfg.Locale, ".UTF-8"), "_", "-")
	return observation.LocaleValid && effectiveWindowsZone(observation.SystemTimezone) == effectiveWindowsZone(cfg.Timezone) && effectiveWindowsZone(observation.TZ) == effectiveWindowsZone(cfg.Timezone) && strings.EqualFold(observation.ProcessLocale, locale) && strings.EqualFold(observation.SystemLocale, locale)
}

func effectiveWindowsZone(zone string) string {
	switch zone {
	case "Etc/UTC", "Etc/GMT", "UTC", "GMT":
		return "UTC"
	default:
		return zone
	}
}

func (s *Server) windowsBoundaryInput(root, private, shared, challenge string, input map[string]any) error {
	project, err := s.windowsProjectForHost(root)
	if err != nil || project == nil {
		return errors.New("Каталог среды Windows ещё не подключён")
	}
	input["project_id"] = project.ID
	input["grant"] = project.Grant
	input["shared_name"] = filepath.Base(shared)
	input["private_name"] = filepath.Base(private)
	input["challenge"] = challenge
	delete(input, "private_file")
	delete(input, "shared_file")
	return nil
}

func (s *Server) applyWindowsGuestSettings(ctx context.Context, cfg cage.Config) error {
	cmd, err := guestos.WindowsRelayCommand(ctx, s.profile, "network-settings")
	if err != nil {
		return err
	}
	data, err := json.Marshal(windowsGuestSettingsInput(cfg))
	if err != nil {
		return err
	}
	cmd.Stdin = bytes.NewReader(append(data, '\n'))
	cmd.Stderr = io.Discard
	var output bytes.Buffer
	cmd.Stdout = &boundedWindowsStatusWriter{buffer: &output, remaining: 4096}
	if err = cmd.Run(); err != nil {
		return errors.New("Не удалось подтвердить системные настройки гостевой системы Windows, внешняя сеть остаётся закрытой; повторите применение и сверьте фактические настройки")
	}
	var result struct {
		OK bool `json:"ok"`
	}
	if json.Unmarshal(output.Bytes(), &result) != nil || !result.OK {
		return errors.New("Системные настройки гостевой системы Windows не подтверждены")
	}
	return nil
}

func windowsGuestSettingsInput(cfg cage.Config) map[string]string {
	return map[string]string{"action": "apply", "timezone": cfg.Timezone, "locale": cfg.Locale, "browser_language": cfg.BrowserLanguage}
}
