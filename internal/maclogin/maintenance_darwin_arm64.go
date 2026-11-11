//go:build darwin && arm64 && cgo && !no_vz

package maclogin

/*
#include "bridge.h"
*/
import "C"

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"os/exec"
	"time"

	"al.essio.dev/pkg/shellescape"
	"github.com/sylvinus/agent-vm/internal/guestos"
)

func (s *loginSession) maintenanceCommand(ctx context.Context, operation string) (*exec.Cmd, string, error) {
	open := operation == "--maintenance-open"
	if !guestos.ValidMacMaintenancePurpose(s.maintenance) {
		return nil, "", errors.New("Недопустимое назначение обслуживания")
	}
	bound, err := guestos.LoadMacOSProfile(s.profile)
	if err != nil || bound == nil || bound.SetupID != "" {
		return nil, "", errors.New("Сначала завершите первоначальную настройку виртуального Mac")
	}
	if open {
		s.maintenanceMachineID = bound.MachineID
	} else if s.maintenanceMachineID != bound.MachineID {
		return nil, "", errors.New("Идентичность виртуального Mac изменилась; откройте экран обслуживания заново")
	}
	user, err := guestos.MacOSProvisionUser(s.profile)
	if err != nil {
		return nil, "", err
	}
	if open {
		s.maintenanceAdministrator = user
	} else if s.maintenanceAdministrator != user {
		return nil, "", errors.New("Идентичность установки гостевой системы изменилась; откройте экран обслуживания заново")
	}
	cmd, err := guestGUIProbeCommand(ctx, s.profile, user, bound.User, operation, s.maintenance)
	return cmd, bound.User, err
}

func (s *loginSession) maintenanceProbe(open bool) (maintenanceWindow, error) {
	var result maintenanceWindow
	operation := "--maintenance-probe"
	if open {
		operation = "--maintenance-open"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	cmd, user, err := s.maintenanceCommand(ctx, operation)
	if err != nil {
		return result, err
	}
	pipe, err := cmd.StdoutPipe()
	if err != nil || cmd.Start() != nil {
		result.Error = "component_update_required"
		return result, errors.New("Компоненты обслуживания гостевой системы не подключены; обновите компоненты среды и повторите попытку")
	}
	data, readErr := io.ReadAll(io.LimitReader(pipe, 8193))
	if readErr != nil || len(data) > 8192 {
		cancel()
	}
	if err = cmd.Wait(); err != nil {
		var exit *exec.ExitError
		if errors.As(err, &exit) && exit.ExitCode() == 73 {
			result.Error = "requires_gui_login"
			return result, errors.New("Сначала войдите и разблокируйте аккаунт гостевой системы виртуального Mac")
		}
		result.Error = "component_update_required"
		return result, errors.New("Компоненты обслуживания гостевой системы требуют обновления; обновите компоненты в настройках среды")
	}
	if readErr != nil || len(data) > 8192 || json.Unmarshal(data, &result) != nil {
		result.Error = "component_update_required"
		return result, errors.New("Компоненты обслуживания гостевой системы требуют обновления; обновите компоненты в настройках среды")
	}
	if result.Error != "" {
		return result, errors.New(result.probeMessage())
	}
	if !open && !result.valid(user) {
		return result, errors.New("Не удалось подтвердить идентичность окна авторизации гостевой системы; откройте экран обслуживания заново")
	}
	return result, nil
}

func maintenanceFailure(surface maintenanceWindow, err error, closed bool) reply {
	result := reply{Closed: closed, Error: err.Error()}
	if surface.Error == "component_update_required" {
		result.Recovery = "environment-update"
	} else if surface.Error == "requires_gui_login" {
		result.Recovery = "guest-login"
	}
	return result
}

func (s *loginSession) handleMaintenance(in request) (result reply) {
	defer func() { result.MaintenanceVersion = 1 }()
	if in.Setup || !guestos.ValidMacMaintenancePurpose(in.Maintenance) || len(in.Geometry) > 64 {
		return reply{Closed: true, Error: "Недопустимое назначение обслуживания"}
	}
	if in.Action == "open" {
		s.close()
		s.maintenance = in.Maintenance
		surface, err := s.maintenanceProbe(true)
		if err != nil {
			s.close()
			return maintenanceFailure(surface, err, true)
		}
		deadline := time.Now().Add(3 * time.Second)
		for {
			surface, err = s.maintenanceProbe(false)
			if err == nil || time.Now().After(deadline) {
				break
			}
			time.Sleep(100 * time.Millisecond)
		}
		if err != nil {
			s.close()
			return maintenanceFailure(surface, err, true)
		}
		s.token, s.screenID = rand.Text(), "maintenance-"+surface.Session
		s.expires = time.Now().Add(5 * time.Minute)
		C.cageLoginEnable(true)
		return reply{Session: s.token, Administrator: s.maintenanceAdministrator}
	}
	if s.token == "" || s.maintenance != in.Maintenance || subtle.ConstantTimeCompare([]byte(in.Session), []byte(s.token)) != 1 {
		return reply{Closed: true}
	}
	if in.Action == "close" || time.Now().After(s.expires) {
		s.close()
		return reply{Closed: true}
	}
	surface, err := s.maintenanceProbe(false)
	if err != nil || s.screenID != "maintenance-"+surface.Session {
		s.close()
		if err == nil {
			err = errors.New("Сеанс входа гостевой системы изменился; откройте экран обслуживания заново")
		}
		return maintenanceFailure(surface, err, true)
	}
	if in.Action == "frame" {
		region := surface.region()
		var size C.int
		data := C.cageLoginImageRegion(C.int(region[0]), C.int(region[1]), C.int(region[2]), C.int(region[3]), &size)
		if data == nil {
			return reply{Error: "Ожидание изображения окна системных настроек"}
		}
		defer C.free(data)
		after, err := s.maintenanceProbe(false)
		if err != nil {
			s.close()
			return maintenanceFailure(after, err, true)
		}
		if after != surface {
			return reply{Error: "Окно авторизации изменилось, изображение обновляется"}
		}
		s.maintenanceFrame = surface.geometry()
		return reply{Image: C.GoBytes(data, size), MIME: "image/jpeg", Geometry: s.maintenanceFrame, Region: region[:]}
	}
	if in.Geometry == "" || in.Geometry != s.maintenanceFrame || in.Geometry != surface.geometry() {
		return reply{Error: "Окно авторизации изменилось; дождитесь нового изображения и повторите попытку"}
	}
	switch in.Action {
	case "fill-password":
		if err := s.fillMaintenancePassword(surface); err != nil {
			return reply{Closed: s.token == "", Error: err.Error()}
		}
	case "select-all":
		s.passwordSelection = passwordSelection{}
		if !bool(C.cageLoginSelectAll()) {
			return reply{Error: "Окно авторизации ещё не готово"}
		}
	case "click":
		s.passwordSelection = passwordSelection{}
		if !surface.contains(in.X, in.Y) || !bool(C.cageLoginClick(C.int(in.X), C.int(in.Y))) {
			return reply{Error: "Точка нажатия выходит за пределы текущего окна авторизации"}
		}
		if probe, err := s.openMaintenancePasswordProbe(); err == nil {
			target, err := probe.target()
			if err == nil {
				s.passwordSelection.selectMaintenance(surface, target, probe.user, in.X, in.Y, time.Now())
			}
			probe.close()
		}
	case "key":
		s.passwordSelection = passwordSelection{}
		navigation := in.Code >= 123 && in.Code <= 126 || in.Code == 116 || in.Code == 121
		if in.Code < 0 || (in.Code > 53 && !navigation) || !bool(C.cageLoginKey(C.int(in.Code), C.bool(in.Shift))) {
			return reply{Error: "Эту клавишу нельзя использовать в окне авторизации"}
		}
	case "scroll":
		s.passwordSelection = passwordSelection{}
		if !surface.contains(in.X, in.Y) || in.DeltaX < -512 || in.DeltaX > 512 || in.DeltaY < -512 || in.DeltaY > 512 ||
			!bool(C.cageLoginScroll(C.int(in.X), C.int(in.Y), C.int(in.DeltaX), C.int(in.DeltaY))) {
			return reply{Error: "Позиция прокрутки выходит за пределы текущего окна авторизации"}
		}
	default:
		return reply{Error: "Недопустимая операция обслуживания"}
	}
	return reply{}
}

func (s *loginSession) openMaintenancePasswordProbe() (*passwordProbe, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 7*time.Second)
	command, user, err := s.maintenanceCommand(ctx, "--maintenance-password-probe")
	if err != nil {
		cancel()
		return nil, err
	}
	input, err := command.StdinPipe()
	if err != nil {
		cancel()
		return nil, err
	}
	output, err := command.StdoutPipe()
	if err != nil {
		input.Close()
		cancel()
		return nil, err
	}
	if err = command.Start(); err != nil {
		input.Close()
		output.Close()
		cancel()
		return nil, err
	}
	scanner := bufio.NewScanner(output)
	scanner.Buffer(make([]byte, 4096), 32<<10)
	return &passwordProbe{command: command, input: input, output: output, scanner: scanner, cancel: cancel, user: user}, nil
}

func (s *loginSession) fillMaintenancePassword(window maintenanceWindow) error {
	selected := s.passwordSelection
	s.passwordSelection = passwordSelection{}
	probe, err := s.openMaintenancePasswordProbe()
	if err != nil {
		return err
	}
	defer probe.close()
	target, err := probe.target()
	if err != nil {
		return err
	}
	selection, permitted := selected.consumeMaintenance(window, target, probe.user, time.Now())
	if !permitted {
		return errors.New("Сначала выберите поле пароля в окне системной авторизации, затем нажмите, чтобы заполнить пароль администратора")
	}
	password, err := s.maintenancePassword()
	if err != nil {
		return err
	}
	defer func() { clear(password) }()
	sequence, valid := passwordKeys(string(bytes.TrimRight(password, "\r\n")))
	if !valid {
		return errors.New("Недопустимый формат учётных данных администратора установки; проверьте запись установки")
	}
	check := func() error {
		current, err := probe.target()
		if err != nil {
			return err
		}
		if time.Now().After(s.expires) || s.screenID != "maintenance-"+current.Session {
			s.close()
			return errors.New("Сеанс авторизации гостевой системы завершён; откройте экран обслуживания заново")
		}
		if !window.permitsPassword(current, selection, probe.user, time.Now()) {
			return errors.New("Окно системной авторизации или поле пароля изменились; ввод остановлен, выберите поле пароля заново")
		}
		return nil
	}
	if err = check(); err != nil {
		return err
	}
	if !target.Accessibility && !bool(C.cageLoginClick(C.int(selection.X), C.int(selection.Y))) {
		return errors.New("Выбранное поле пароля изменилось; выберите его заново")
	}
	if err = check(); err != nil {
		return err
	}
	if !bool(C.cageLoginSelectAll()) {
		return errors.New("Системное поле пароля ещё не готово; повторите попытку")
	}
	for _, key := range sequence {
		if err = check(); err != nil {
			return err
		}
		if !bool(C.cageLoginKey(C.int(key.code), C.bool(key.shift))) {
			return errors.New("Не удалось заполнить пароль администратора; выберите поле пароля заново и повторите попытку")
		}
	}
	return nil
}

func (s *loginSession) maintenancePassword() ([]byte, error) {
	user, err := guestos.MacOSProvisionUser(s.profile)
	if err != nil || user != s.maintenanceAdministrator {
		return nil, errors.New("Идентичность установки гостевой системы изменилась; откройте экран обслуживания заново")
	}
	args, err := guestos.MacOSSSHArgs(s.profile, user)
	if err != nil {
		return nil, err
	}
	script := `set -eu; p=` + shellescape.Quote("/Users/"+user+"/password") + `
test ! -L "$p" && test "$(/usr/bin/stat -f %u "$p")" = "$(/usr/bin/id -u)"
mode=$(/usr/bin/stat -f %Lp "$p"); test "$((0$mode & 077))" = 0
exec /bin/cat "$p"`
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "/usr/bin/ssh", append(args, "-T", "cage-macos", "--", "exec /bin/sh -c "+shellescape.Quote(script))...)
	cmd.Env = []string{"PATH=/usr/bin:/bin", "LC_ALL=C"}
	pipe, err := cmd.StdoutPipe()
	if err != nil || cmd.Start() != nil {
		return nil, errors.New("Учётные данные администратора установки временно недоступны")
	}
	data, readErr := io.ReadAll(io.LimitReader(pipe, 1025))
	if readErr != nil || len(data) > 1024 {
		cancel()
	}
	if err = cmd.Wait(); err != nil || readErr != nil || len(data) == 0 || len(data) > 1024 {
		clear(data)
		return nil, errors.New("Учётные данные администратора установки недоступны; проверьте запись установки")
	}
	return data, nil
}
