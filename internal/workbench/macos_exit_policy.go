package workbench

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/sylvinus/agent-vm/internal/cage"
)

// Only the measured address is presented to the local trusted view. The run
// and configuration remain attached to the observation inside the workbench.
type macOSExitCandidate struct {
	IP          string    `json:"ip"`
	Fingerprint string    `json:"-"`
	Run         string    `json:"-"`
	Observed    time.Time `json:"-"`
}

func macOSStaticCandidate(config cage.Config, run, host string, terminal, browser networkObservation) *macOSExitCandidate {
	if host == "" || run == "" || terminal.Status != 200 || browser.Status != 200 || host != terminal.IP || host != browser.IP {
		return nil
	}
	if config.ExitPolicy.Mode == "static" && config.ExitPolicy.IP == host {
		return nil
	}
	return &macOSExitCandidate{IP: host, Fingerprint: config.Fingerprint(), Run: run, Observed: time.Now()}
}

func (s *Server) bindMacOSExit(w http.ResponseWriter, r *http.Request) {
	var input struct {
		IP string `json:"ip"`
	}
	if !readJSON(w, r, &input) {
		return
	}
	s.mu.Lock()
	sample := s.safety.MacOSExitCandidate
	s.mu.Unlock()
	if sample == nil || input.IP != sample.IP {
		http.Error(w, "Сначала запустите проверку доступа к сети, чтобы выход терминала, браузера и текущего прокси совпадал", http.StatusConflict)
		return
	}
	s.launch(w, "settings", func() error {
		return s.saveMacOSStaticExit(s.operationContext(), *sample)
	})
}

func (s *Server) saveMacOSStaticExit(ctx context.Context, sample macOSExitCandidate) error {
	cfg, err := loadConfig(s.configPath)
	if err != nil {
		return err
	}
	if s.macosGuest == nil || sample.IP == "" || cfg.Fingerprint() != sample.Fingerprint || time.Since(sample.Observed) > 10*time.Minute || sample.Observed.After(time.Now()) {
		return errors.New("Выборка выхода устарела или узел изменился; повторите проверку доступа к сети")
	}
	if err := cfg.RequireManagedProxy(s.profile); err != nil {
		return err
	}
	client, err := s.gateClient()
	if err != nil {
		return err
	}
	state, err := client.Status(ctx)
	if err != nil {
		return err
	}
	if state.RunID != sample.Run || state.Configuration != sample.Fingerprint {
		return errors.New("Гостевая система или сетевая конфигурация изменились; повторите проверку доступа к сети")
	}
	loc, err := probeLocation(ctx, cfg)
	if err != nil {
		return err
	}
	observed := loc.exitLocation()
	if observed.IP != sample.IP {
		return errors.New("Текущий выход не совпадает с тремя выборками; подтвердите узел заново")
	}
	next := (cage.ExitPolicy{Mode: "static"}).BindMissing(observed)
	if verdict, message := next.Evaluate(sample.IP, &observed); verdict != cage.CheckPassed {
		return errors.New(message)
	}
	cfg.ExitPolicy = next
	if err := cfg.Validate(); err != nil {
		return err
	}
	closed, err := client.Close(ctx, "Фиксированный выход подтверждён; перезапустите гостевую систему и повторите проверку")
	if err != nil {
		return err
	}
	s.publishGate(closed)
	if closed.Mode != cage.GateClosed || closed.RunID != sample.Run || closed.Configuration != sample.Fingerprint {
		return errors.New("Не удалось подтвердить, что внешняя сеть гостевой системы закрыта")
	}
	if err := s.saveExitPolicyConfig(cfg); err != nil {
		return err
	}
	s.mu.Lock()
	s.safety.MacOSExitCandidate = nil
	s.safety.Error = "Фиксированный выход сохранён. Перезапустите гостевую систему macOS, войдите и повторите проверку."
	s.mu.Unlock()
	return nil
}
