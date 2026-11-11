package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"syscall"

	"github.com/sylvinus/agent-vm/internal/cage"
	"github.com/sylvinus/agent-vm/internal/containerenv"
	"github.com/sylvinus/agent-vm/internal/managedproxy"
	"github.com/sylvinus/agent-vm/internal/workbench"
)

func configureContainer(configPath string) error {
	if runtime.GOOS != "linux" {
		return errors.New("Серверу контейнеров требуется Linux; на этом компьютере можно подключиться облегчённым клиентом")
	}
	profile := filepath.Dir(configPath)
	entries, err := os.ReadDir(filepath.Join(profile, "state", "lima"))
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	if len(entries) > 0 {
		return errors.New("В этой конфигурации уже есть данные виртуальной машины; для облачного контейнера используйте отдельную конфигурацию, существующие данные не изменятся")
	}
	var config containerenv.Config
	decoder := json.NewDecoder(io.LimitReader(os.Stdin, 64<<10))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&config); err != nil {
		return errors.New("Неверный формат конфигурации контейнера")
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return errors.New("Принимается только одна конфигурация контейнера")
	}
	if _, err := containerenv.Configure(profile, config); err != nil {
		return err
	}
	return json.NewEncoder(os.Stdout).Encode(map[string]bool{"configured": true})
}

func containerOperation(configPath string, args []string, cfg cage.Config) (bool, error) {
	profile := filepath.Dir(configPath)
	if !containerenv.Configured(profile) {
		return false, nil
	}
	switch args[0] {
	case "setup", "up", "login", "stop", "list", "info", "doctor", "name", "run", "shell", "claude", "update-tools", "access":
	default:
		return false, nil
	}
	if runtime.GOOS != "linux" {
		return true, errors.New("Среда выполнения контейнера доступна только на сервере Linux")
	}
	if args[0] == "access" {
		return true, errors.New("Рабочая среда контейнера использует аутентифицированную точку входа рабочей среды Cage и не предоставляет учётные данные старого отдельного просмотрщика")
	}
	if args[0] != "run" && args[0] != "claude" && len(args) != 1 {
		return true, errors.New("Эта команда управления контейнером не принимает дополнительных аргументов")
	}
	environment, err := containerenv.Load(profile)
	if err != nil {
		return true, err
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	switch args[0] {
	case "stop":
		if len(args) != 1 {
			return true, errors.New("Конфигурация контейнера управляет только собственной постоянной средой")
		}
		if err := environment.Stop(ctx); err != nil {
			return true, err
		}
		return true, managedproxy.Stop(profile)
	case "list", "info":
		state, err := environment.State(ctx)
		if err != nil {
			return true, err
		}
		return true, json.NewEncoder(os.Stdout).Encode(state)
	case "doctor":
		inspection, err := environment.Inspect(ctx)
		if err != nil {
			return true, err
		}
		return true, json.NewEncoder(os.Stdout).Encode(inspection)
	case "name":
		fmt.Println(environment.Name())
		return true, nil
	case "setup":
		return true, environment.Prepare(ctx, os.Stdout)
	}
	if err := cfg.RequireManagedProxy(profile); err != nil {
		return true, err
	}
	if err := cfg.CheckRunning(filepath.Join(profile, "state")); err != nil {
		return true, err
	}
	if err := os.MkdirAll(cage.EnvironmentDir(profile), 0700); err != nil {
		return true, err
	}
	if err := environment.Prepare(ctx, os.Stdout); err != nil {
		return true, err
	}
	state, err := environment.State(ctx)
	if err != nil {
		return true, err
	}
	needsServices := !state.Ready || args[0] == "up" || args[0] == "login"
	if err := environment.Start(ctx, configPath, os.Stdout); err != nil {
		return true, err
	}
	if needsServices {
		if err := workbench.StartGuestServices(ctx, configPath, cfg, os.Stdout, os.Stderr); err != nil {
			return true, err
		}
	}
	switch args[0] {
	case "up":
		fmt.Println("Служба контейнеров Cage запущена; внешняя сеть откроется только после сетевой проверки рабочей среды.")
		return true, nil
	case "update-tools":
		return true, workbench.RunMaintenanceScript(ctx, configPath, cage.ToolsUpdateScript(), os.Stdout, os.Stderr)
	case "login":
		return true, workbench.RunEnvironmentCommand(ctx, configPath, []string{"claude", "auth", "login"}, os.Stdin, os.Stdout, os.Stderr, true)
	case "shell":
		return true, workbench.RunEnvironmentCommand(ctx, configPath, []string{"/bin/bash", "-l"}, os.Stdin, os.Stdout, os.Stderr, true)
	case "claude":
		return true, workbench.RunEnvironmentCommand(ctx, configPath, append([]string{"claude"}, args[1:]...), os.Stdin, os.Stdout, os.Stderr, true)
	case "run":
		if len(args) < 2 {
			return true, errors.New("cage run требует указать команду")
		}
		return true, workbench.RunEnvironmentCommand(ctx, configPath, args[1:], os.Stdin, os.Stdout, os.Stderr, false)
	}
	return true, nil
}
