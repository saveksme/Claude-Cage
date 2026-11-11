package workbench

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"path/filepath"
	"strings"
)

func (s *Server) browserPreferences(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		s.mu.Lock()
		home := browserHomeURL(s.preferences)
		s.mu.Unlock()
		jsonReply(w, map[string]string{"browser_home_url": home})
		return
	}
	var input struct {
		Home string `json:"browser_home_url"`
	}
	if !readJSON(w, r, &input) {
		return
	}
	s.saveBrowserHome(w, r, input.Home)
}

func validateBrowserHome(value string) (string, error) {
	home := strings.TrimSpace(value)
	parsed, err := url.Parse(home)
	if err != nil || len(home) > 8192 || parsed == nil || (parsed.Scheme != "https" && parsed.Scheme != "http") || parsed.Hostname() == "" || parsed.User != nil {
		return "", errors.New("Адрес новой вкладки должен быть полным адресом HTTP или HTTPS и не содержать имя пользователя или пароль")
	}
	return home, nil
}

func (s *Server) saveBrowserHome(w http.ResponseWriter, r *http.Request, value string) {
	home, err := validateBrowserHome(value)
	if err != nil {
		requestError(w, err)
		return
	}
	if !s.op.TryLock() {
		http.Error(w, "В среде выполняется другое действие; сохраните позже", http.StatusConflict)
		return
	}
	defer s.op.Unlock()
	s.mu.Lock()
	previous, ready, token, closing := s.preferences, s.ready, s.credentials.Token, s.closing
	s.mu.Unlock()
	if closing {
		http.Error(w, "Служба завершает работу", http.StatusServiceUnavailable)
		return
	}
	if ready {
		if err = s.setBrowserHome(r.Context(), token, home); err != nil {
			requestError(w, err)
			return
		}
	}
	next := previous
	next.BrowserHomeURL = home
	if err = writePrivate(filepath.Join(s.profile, "workbench.json"), next); err != nil {
		if ready {
			_ = s.setBrowserHome(r.Context(), token, browserHomeURL(previous))
		}
		requestError(w, errors.New("Не удалось сохранить настройки браузера; повторите попытку"))
		return
	}
	s.mu.Lock()
	s.preferences = next
	s.mu.Unlock()
	jsonReply(w, map[string]string{"browser_home_url": home})
}

func (s *Server) browserExtensionUpload(w http.ResponseWriter, r *http.Request) {
	const limit = 32 << 20
	if r.ContentLength > limit {
		http.Error(w, "ZIP-архив расширения не должен превышать 32 МБ", 413)
		return
	}
	s.mu.Lock()
	ready, token := s.ready, s.credentials.Token
	s.mu.Unlock()
	if !ready {
		http.Error(w, "Среда ещё не готова", 409)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	if s.macosGuest != nil || s.windowsGuest != nil {
		data, err := s.nativeBrowserClient().uploadExtension(r.Context(), r.Body, r.ContentLength)
		if err != nil {
			requestError(w, err)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(data)
		return
	}
	response, err := s.browserClient().file(r.Context(), token, http.MethodPost, "/extensions-upload", r.Body, r.ContentLength)
	if err != nil {
		http.Error(w, "Загрузка расширения прервалась; повторите попытку", http.StatusBadGateway)
		return
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, browserResponseLimit+1))
	if err != nil || len(data) > browserResponseLimit {
		http.Error(w, "Неверный ответ с пакетом расширения; повторите попытку", http.StatusBadGateway)
		return
	}
	if response.StatusCode != http.StatusOK {
		var failure struct {
			Error string `json:"error"`
		}
		_ = json.Unmarshal(data, &failure)
		if failure.Error == "" {
			failure.Error = "Не удалось прочитать пакет расширения; выберите корректный ZIP-архив расширения"
		}
		http.Error(w, failure.Error, http.StatusBadRequest)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(data)
}
