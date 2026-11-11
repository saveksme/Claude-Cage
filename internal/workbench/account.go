package workbench

import (
	"net/http"
	"runtime"

	"github.com/sylvinus/agent-vm/internal/guestos"
)

func (s *Server) macAccountHost() bool {
	return runtime.GOOS == "darwin" && runtime.GOARCH == "arm64" && s.localVMStorage()
}

func (s *Server) accountStatus(w http.ResponseWriter, r *http.Request) {
	v := s.account.viewFor(s.hasTrustedView(r))
	v.MacOSAccountHost = s.macAccountHost()
	v.BackgroundRunning = s.vmRunning()
	if s.macosGuest != nil {
		v.GuestSystem = "macos"
		v.InitialMacSetup = s.macSetupPending()
		v.MacOSGuestUser = s.macosGuest.User
	}
	if s.windowsGuest != nil {
		v.GuestSystem = "windows-11"
	}
	if v.MacOSAccountHost && v.Unlocked && !v.MacOSCredentialsReady && v.MacOSGuestUser == "" {
		if install, err := guestos.LoadInstallation(s.profile); err == nil && install != nil {
			if previous, err := s.account.legacyMacGuestPassword(r.Context(), install.ID); err == nil && previous != "" {
				v.MacOSGuestUser = "cage"
			}
		}
	}
	jsonReply(w, v)
}

func (s *Server) accountAction(w http.ResponseWriter, r *http.Request) {
	if s.account == nil {
		http.Error(w, "Локальный аккаунт ещё не инициализирован", 503)
		return
	}
	action := r.PathValue("action")
	if action != "prepare-macos" && action != "create" && action != "unlock" && action != "profile" && action != "password" && action != "lock" && action != "logout" && action != "suspend" && action != "device-enroll" && action != "device-revoke" && action != "device-unlock" {
		http.NotFound(w, r)
		return
	}
	if action != "create" && action != "unlock" && action != "device-unlock" {
		if _, ok := s.account.accessFor(s.hasTrustedView(r)); !ok {
			http.Error(w, "Сначала разблокируйте Cage", http.StatusLocked)
			return
		}
	}
	if (action == "lock" || action == "logout" || action == "device-enroll") && s.account.view().TrustedLocal {
		http.Error(w, "Сначала задайте пароль на этом компьютере в разделе «Настройки → Аккаунт»", http.StatusConflict)
		return
	}
	var input struct {
		Username        string           `json:"username"`
		Password        string           `json:"password"`
		ConfirmPassword string           `json:"confirm_password"`
		OldPassword     string           `json:"old_password"`
		Avatar          string           `json:"avatar"`
		Kind            string           `json:"kind"`
		Credential      deviceCredential `json:"credential"`
	}
	if !readJSON(w, r, &input, 3<<20) {
		return
	}
	s.account.mu.Lock()
	vaultLease := s.account.vaultLease
	s.account.mu.Unlock()
	var err error
	if action == "password" || action == "prepare-macos" {
		if !s.op.TryLock() {
			http.Error(w, "В среде ещё выполняется действие; дождитесь его завершения и задайте пароль", http.StatusConflict)
			return
		}
		defer s.op.Unlock()
		if s.busy() {
			http.Error(w, "В среде ещё выполняется действие; дождитесь его завершения и задайте пароль", http.StatusConflict)
			return
		}
	}
	switch action {
	case "create":
		if input.Password != input.ConfirmPassword {
			http.Error(w, "Пароли не совпадают", 400)
			return
		}
		err = s.account.createAccount(input.Username, input.Password, input.Avatar, s.macAccountHost())
	case "prepare-macos":
		if !s.macAccountHost() || !s.hasTrustedView(r) {
			http.Error(w, "Задайте общие учётные данные в окне Cage на этом компьютере", http.StatusForbidden)
			return
		}
		if input.Password != input.ConfirmPassword {
			http.Error(w, "Пароли не совпадают", http.StatusBadRequest)
			return
		}
		guests := map[string]macGuestCredential{}
		install, loadErr := guestos.LoadInstallation(s.profile)
		if loadErr != nil {
			requestError(w, loadErr)
			return
		}
		if s.macosGuest != nil && install == nil {
			http.Error(w, "Запись установки исходной гостевой системы отсутствует; восстановите резервную копию и продолжите", http.StatusConflict)
			return
		}
		if install != nil {
			previous, loadErr := s.account.savedMacGuestPassword(r.Context(), install.ID)
			if loadErr != nil {
				requestError(w, loadErr)
				return
			}
			if s.macosGuest != nil && previous == "" {
				http.Error(w, "Учётные данные исходной гостевой системы отсутствуют; восстановите зашифрованное хранилище и продолжите", http.StatusConflict)
				return
			}
			if previous != "" {
				user := "cage"
				if s.macosGuest != nil {
					user = s.macosGuest.User
				}
				if input.Username != user {
					http.Error(w, "Используйте существующее имя пользователя гостевой системы; запись установки и исходные файлы сохранены", http.StatusConflict)
					return
				}
				guests[install.ID.String()] = macGuestCredential{Username: user, Password: previous}
			}
		}
		err = s.account.prepareMacAccount(input.Username, input.Password, guests)
	case "unlock":
		err = s.account.unlock(input.Password)
	case "profile":
		err = s.account.updateProfile(input.Username, input.Avatar)
	case "password":
		if input.Password != input.ConfirmPassword {
			http.Error(w, "Пароли не совпадают", 400)
			return
		}
		err = s.account.changePassword(input.OldPassword, input.Password)
	case "lock":
		err = s.account.lockAccess(false)
	case "suspend":
		s.account.lock()
	case "device-enroll":
		var credential deviceCredential
		credential, err = s.account.enrollDevice(input.Kind)
		if err == nil {
			jsonReply(w, credential)
			return
		}
	case "device-revoke":
		err = s.account.revokeDevice(input.Kind)
	case "device-unlock":
		err = s.account.unlockDevice(input.Kind, input.Credential)
	case "logout":
		s.requestStop(w, true)
		return
	}
	if err != nil {
		requestError(w, err)
		return
	}
	if action == "lock" || action == "suspend" {
		s.clearBrowserVault(vaultLease)
	}
	if (action == "password" || action == "prepare-macos") && s.macosGuest != nil && s.vmRunning() {
		// The account write already succeeded. A failed guest update remains a
		// durable pending state, rather than reporting that the old Cage password works.
		_ = s.syncMacGuestPassword(r.Context())
	}
	s.accountStatus(w, r)
}
