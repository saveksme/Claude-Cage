package workbench

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/sylvinus/agent-vm/internal/gitguard"
	"github.com/sylvinus/agent-vm/internal/gitx"
)

type hostGitState struct {
	State     string `json:"state"`
	Ready     bool   `json:"ready"`
	CanEnable bool   `json:"can_enable"`
	Message   string `json:"message"`
}

func inspectHostGit(ctx context.Context) hostGitState {
	state := gitguard.BareState(ctx)
	view := hostGitState{State: state}
	switch state {
	case gitguard.BareOK:
		view.Ready = true
		view.Message = "Защита локального Git включена."
	case gitguard.BareNoGit:
		view.Ready = true
		view.Message = "Рабочий Git не установлен, изменения не нужны; при следующем запуске среды проверка повторится."
	case gitguard.BareUnset:
		view.CanEnable = true
		view.Message = "Перед запуском нужно включить защиту локального Git."
	case gitguard.BareOld:
		view.Message = "Локальный Git слишком старый; обновите его до 2.38 или новее и повторите проверку."
	default:
		view.Message = "Пока не удалось проверить локальный Git. Убедитесь, что Git установлен полностью, и повторите проверку; Cage не открывает установщик автоматически."
	}
	return view
}

func (s *Server) hostGit(w http.ResponseWriter, r *http.Request) {
	jsonReply(w, inspectHostGit(r.Context()))
}

func (s *Server) enableHostGit(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Confirm bool `json:"confirm"`
	}
	if !readJSON(w, r, &input) {
		return
	}
	if !input.Confirm {
		http.Error(w, "Сначала подтвердите включение защиты локального Git.", http.StatusBadRequest)
		return
	}
	if !s.op.TryLock() {
		http.Error(w, "Выполняется действие со средой; дождитесь завершения и повторите.", http.StatusConflict)
		return
	}
	defer s.op.Unlock()
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	before := inspectHostGit(ctx)
	if before.Ready {
		jsonReply(w, before)
		return
	}
	if !before.CanEnable {
		http.Error(w, before.Message, http.StatusConflict)
		return
	}
	cmd := gitx.Untrusted(ctx, "config", "--global", "--replace-all", "safe.bareRepository", "explicit")
	cmd.Dir = s.profile
	if err := cmd.Run(); err != nil {
		http.Error(w, "Не удалось сохранить настройки безопасности Git. Проверьте права на запись глобальной конфигурации Git, закройте другие операции с настройками Git и повторите.", http.StatusInternalServerError)
		return
	}
	after := inspectHostGit(ctx)
	if !after.Ready {
		http.Error(w, "Настройки Git записаны, но проверка ещё не пройдена. Проверьте глобальную конфигурацию Git и повторите проверку.", http.StatusConflict)
		return
	}
	jsonReply(w, after)
}

func requireHostGit(ctx context.Context) error {
	state := inspectHostGit(ctx)
	if !state.Ready {
		return errors.New(state.Message + " Запустите из рабочей среды и завершите проверку по подсказкам.")
	}
	return nil
}
