package workbench

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"time"
)

func validTailnetAuthURL(raw string) bool {
	u, err := url.Parse(raw)
	return err == nil && u.Scheme == "https" && u.Host == "login.tailscale.com" && u.User == nil && u.Fragment == "" && (len(u.Path) > 3 && (u.Path[:3] == "/a/" || u.Path[:3] == "/c/"))
}
func (s *Server) tailnet(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	action := r.PathValue("action")
	if r.Method == http.MethodGet {
		action = "status"
	}
	if action == "install" {
		var input struct{}
		if !readJSON(w, r, &input) {
			return
		}
		s.launch(w, "tailscale-install", s.installTailnet)
		return
	}
	switch action {
	case "status", "connect", "login", "disconnect", "logout", "add-key", "remove-key", "open-service":
	default:
		http.NotFound(w, r)
		return
	}
	var input struct {
		Key  string `json:"key"`
		Host string `json:"host,omitempty"`
		Port int    `json:"port,omitempty"`
	}
	if r.Method != http.MethodGet && !readJSON(w, r, &input) {
		return
	}
	if len(input.Key) > 8192 {
		http.Error(w, "Открытый ключ SSH слишком длинный", 400)
		return
	}
	if action == "open-service" && (len(input.Host) == 0 || len(input.Host) > 253 || input.Port < 1 || input.Port > 65535) {
		http.Error(w, "Выберите устройство частной сети и укажите порт от 1 до 65535", 400)
		return
	}
	s.mu.Lock()
	ready, token := s.ready, s.credentials.Token
	busy := s.jobs.snapshot().Running
	s.mu.Unlock()
	if !ready || busy {
		http.Error(w, "Сначала запустите среду Cage и дождитесь завершения текущего действия", 409)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	body, _ := json.Marshal(struct {
		Action string `json:"action"`
		Key    string `json:"key,omitempty"`
		Host   string `json:"host,omitempty"`
		Port   int    `json:"port,omitempty"`
	}{action, input.Key, input.Host, input.Port})
	data, err := s.guestAPI(ctx, token, http.MethodPost, "/tailnet", body)
	if err != nil {
		http.Error(w, "Операция Tailscale не завершена. Обновите компоненты среды и повторите; идентичность устройства и открытый ключ SSH сохранятся.", 502)
		return
	}
	var result map[string]json.RawMessage
	if json.Unmarshal(data, &result) != nil {
		http.Error(w, "Компонент Tailscale вернул неверное состояние", 502)
		return
	}
	if b := result["tailnet_error"]; len(b) > 0 {
		var reason string
		_ = json.Unmarshal(b, &reason)
		http.Error(w, reason, 502)
		return
	}
	var authURL string
	_ = json.Unmarshal(result["auth_url"], &authURL)
	if authURL != "" && !validTailnetAuthURL(authURL) {
		http.Error(w, "Неверный адрес входа Tailscale; начните вход заново", 502)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(data)
}

var errTailnetNativeInstall = errors.New("Обновите компоненты среды в настройках; Tailscale устанавливается вместе с компонентами гостевой системы")
