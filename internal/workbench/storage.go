package workbench

import (
	"errors"
	"fmt"
	"net/http"
	"os"
	"runtime"
	"strings"

	"github.com/sylvinus/agent-vm/internal/cage"
	"github.com/sylvinus/agent-vm/internal/containerenv"
	"github.com/sylvinus/agent-vm/internal/diagnostics"
	"github.com/sylvinus/agent-vm/internal/guestos"
)

func (s *Server) localVMStorage() bool {
	return !s.clientOnly && !containerenv.Configured(s.profile)
}

type storageRecoveryView struct {
	Required      bool   `json:"required"`
	Error         string `json:"error,omitempty"`
	RepairAllowed bool   `json:"repair_allowed"`
}

func (s *Server) storageRecoveryStatusLocked() storageRecoveryView {
	return storageRecoveryView{
		Required: s.storageRecoveryError != "", Error: s.storageRecoveryError,
		RepairAllowed: s.storageRecoveryError != "" && s.windowsGuest != nil && runtime.GOOS == "windows",
	}
}

func (s *Server) storageRecoveryStatus() storageRecoveryView {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.storageRecoveryStatusLocked()
}

func (s *Server) requireStorageReady() error {
	state := s.storageRecoveryStatus()
	if state.Required {
		return fmt.Errorf("Хранилище среды требует восстановления; восстановите его в настройках и продолжите. %s", state.Error)
	}
	return nil
}

func (s *Server) failStorageRecovery(err error) error {
	s.mu.Lock()
	s.storageRecoveryError = err.Error()
	s.ready = false
	s.mu.Unlock()
	diagnostics.Log("error", "storage", "environment storage recovery failed: "+err.Error())
	return err
}

// Recovery keeps local account access and host diagnostics available. Guest
// reads can also create sessions, so admission names the host-only reads.
func storageRecoveryRoute(r *http.Request) bool {
	path := r.URL.Path
	if !strings.HasPrefix(path, "/api/") || strings.HasPrefix(path, "/api/account/") || strings.HasPrefix(path, "/api/diagnostics") {
		return true
	}
	switch path {
	case "/api/account", "/api/session", "/api/launch", "/api/handoff", "/api/remote/manifest", "/api/environment/storage/recover":
		return true
	}
	if r.Method == http.MethodGet {
		switch path {
		case "/api/status", "/api/settings", "/api/appearance", "/api/favorites", "/api/proxy", "/api/agent/routes", "/api/environment/storage", "/api/environment/initialization":
			return true
		}
	}
	return false
}

func (s *Server) recoverEnvironmentStorage(w http.ResponseWriter, r *http.Request) {
	if !s.localVMStorage() {
		http.Error(w, "Восстановите хранилище среды на компьютере, где работает виртуальная машина", http.StatusConflict)
		return
	}
	if !s.storageRecoveryStatus().Required {
		http.Error(w, "Текущее хранилище среды не требует восстановления", http.StatusConflict)
		return
	}
	var input struct {
		Repair bool `json:"repair"`
	}
	if !readJSON(w, r, &input) {
		return
	}
	s.launch(w, "storage-recovery", func() error {
		if input.Repair {
			s.setMessage("Идёт восстановление системного помощника Windows, завершите системную авторизацию…")
			kit, _ := s.nativeComponentKit()
			if err := guestos.RepairWindowsHostManager(s.operationContext(), s.profile, kit, s.jobs.execution(), s.jobs.execution()); err != nil {
				return s.failStorageRecovery(executionFailure("восстановление системного помощника Windows", err, s.jobs.snapshot().Log))
			}
		}
		s.setMessage("Идёт восстановление хранилища среды и проверка расположения данных…")
		if err := guestos.RecoverWindowsStorage(s.operationContext(), s.profile); err != nil {
			return s.failStorageRecovery(err)
		}
		if _, err := cage.GetStorageLocation(s.profile); err != nil {
			return s.failStorageRecovery(err)
		}
		if s.windowsGuest != nil {
			binding, err := guestos.LoadWindowsProfile(s.profile)
			if err != nil {
				return s.failStorageRecovery(err)
			}
			if binding == nil || binding.VMID != s.windowsGuest.VMID || binding.GUIUserSID != s.windowsGuest.GUIUserSID {
				return s.failStorageRecovery(errors.New("Привязка гостевой системы Windows изменилась; снова откройте исходную рабочую среду и восстановите"))
			}
		}
		if err := s.prepareEnvironment(); err != nil {
			return s.failStorageRecovery(err)
		}
		s.mu.Lock()
		s.storageRecoveryError = ""
		s.mu.Unlock()
		s.setMessage("Хранилище среды восстановлено, среду можно запускать")
		return nil
	})
}

func (s *Server) environmentStorage(w http.ResponseWriter, r *http.Request) {
	if !s.localVMStorage() {
		http.Error(w, "Изменение расположения хранилища поддерживается только для локальной виртуальной машины", http.StatusConflict)
		return
	}
	if r.Method == http.MethodGet {
		if recovery := s.storageRecoveryStatus(); recovery.Required {
			jsonReply(w, map[string]any{"recovery": recovery})
			return
		}
		location, err := cage.GetStorageLocation(s.profile)
		if err != nil {
			if errors.Is(err, cage.ErrStorageRuntimeRecovery) {
				s.failStorageRecovery(err)
				jsonReply(w, map[string]any{"recovery": s.storageRecoveryStatus()})
				return
			}
			requestError(w, err)
			return
		}
		suggested := ""
		if !location.Custom && !location.HasEnvironment {
			initialization, err := s.initializationState()
			if err != nil {
				requestError(w, err)
				return
			}
			if initialization.Required && !initialization.Started && !initialization.Prepared {
				suggested = cage.InitialStorageDirectory(s.exe)
			}
		}
		jsonReply(w, struct {
			cage.StorageLocation
			SuggestedDirectory string `json:"suggested_directory,omitempty"`
		}{location, suggested})
		return
	}

	var input struct {
		Directory string `json:"directory"`
		Previous  string `json:"previous"`
		Migrate   bool   `json:"migrate"`
	}
	if !readJSON(w, r, &input) {
		return
	}
	s.launch(w, "storage", func() error {
		if err := guestos.RecoverWindowsStorage(s.operationContext(), s.profile); err != nil {
			return s.failStorageRecovery(err)
		}
		current, err := cage.GetStorageLocation(s.profile)
		if err != nil {
			return err
		}
		if current.Directory != input.Previous || current.HasEnvironment != input.Migrate {
			return errors.New("Среда или расположение хранилища изменились; снова откройте настройки и выберите заново")
		}
		if err = cage.ValidateStorageTarget(s.profile, input.Directory); err != nil {
			if errors.Is(err, os.ErrPermission) {
				return errors.New("Не удалось прочитать или записать выбранный каталог хранилища; выберите на текущей странице локальную папку с нужными правами и повторите, существующие данные сохранены")
			}
			return err
		}
		if err = s.validateStoragePlacement(input.Directory); err != nil {
			return err
		}
		if current.HasEnvironment {
			if err = s.stopEnvironment(); err != nil {
				return err
			}
		}
		s.setMessage("Идёт проверка хранилища среды…")
		var runtime cage.StorageRuntime
		if s.windowsGuest != nil {
			runtime = guestos.WindowsStorageRuntime(s.profile)
		}
		_, err = cage.MoveStorageWithRuntime(s.operationContext(), s.profile, input.Directory, current, runtime, func(copied, total int64) {
			s.setMessage(fmt.Sprintf("Идёт перенос данных среды · %.1f / %.1f ГиБ", float64(copied)/(1<<30), float64(total)/(1<<30)))
		})
		if err != nil {
			if _, recoveryErr := cage.GetStorageLocation(s.profile); errors.Is(recoveryErr, cage.ErrStorageRuntimeRecovery) {
				return s.failStorageRecovery(err)
			}
		}
		if errors.Is(err, os.ErrPermission) {
			return errors.New("Не удалось записать в выбранный каталог хранилища. Выберите на текущей странице локальную папку с правом записи и повторите, существующие данные сохранены")
		}
		return err
	})
}
