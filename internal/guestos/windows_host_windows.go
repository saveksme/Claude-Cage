//go:build windows

package guestos

import (
	"context"
	"debug/pe"
	"errors"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/windows"
)

// probeWindowsHost checks the local platform without requiring VM-wide privileges.
// It doesn't create a VM or test whether a guest image can be installed.
func probeWindowsHost(ctx context.Context) (bool, string) {
	version := windows.RtlGetVersion()
	const workstation = 1 // VER_NT_WORKSTATION
	if version.ProductType != workstation || version.MajorVersion < 10 || version.BuildNumber < 22000 {
		return false, "Нативная гостевая система Windows требует хоста с Windows 11 для настольных компьютеров."
	}
	var processMachine, nativeMachine uint16
	if err := windows.IsWow64Process2(windows.CurrentProcess(), &processMachine, &nativeMachine); err != nil {
		return false, "Не удалось прочитать архитектуру процессора хоста Windows."
	}
	if runtime.GOARCH != "amd64" || nativeMachine != pe.IMAGE_FILE_MACHINE_AMD64 {
		return false, "Нативная гостевая система Windows требует хост Intel или AMD x64 и 64-разрядную версию Cage."
	}
	ctx, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()
	cmd, err := systemPowerShellQuery(ctx, hyperVHostProbe)
	if err != nil {
		return false, "Не удалось найти встроенный Windows PowerShell."
	}
	output, err := cmd.Output()
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return false, "Время запроса Hyper-V истекло; проверьте локальную службу управления виртуальными машинами и повторите попытку."
	}
	if ctx.Err() != nil {
		return false, "Предварительная проверка хоста Windows отменена."
	}
	if err != nil {
		var exit *exec.ExitError
		if errors.As(err, &exit) && exit.ExitCode() == 2 {
			if reason := strings.TrimSpace(string(output)); reason != "" {
				return false, reason
			}
		}
		return false, "Не удалось запросить Hyper-V через системный PowerShell; проверьте PowerShell и службы управления Windows."
	}
	if strings.TrimSpace(string(output)) != "ready" {
		return false, "Предварительная проверка Hyper-V вернула нераспознанный результат."
	}
	return true, "Платформа Hyper-V готова; после подтверждения системной авторизации при первой установке помощник управления Cage работает только с привязанными гостевыми системами."
}

func systemPowerShellQuery(ctx context.Context, script string) (*exec.Cmd, error) {
	systemDir, err := windows.GetSystemDirectory()
	if err != nil {
		return nil, err
	}
	shell := filepath.Join(systemDir, "WindowsPowerShell", "v1.0", "powershell.exe")
	cmd := exec.CommandContext(ctx, shell, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	return cmd, nil
}

const hyperVHostProbe = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
function Unavailable([string]$reason) { Write-Output $reason; exit 2 }

$edition = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -Name EditionID).EditionID
if ($edition -like 'Core*') {
    Unavailable 'Домашняя версия Windows не содержит полной роли Hyper-V. Этот прототип поддерживает версии Pro, Enterprise и Education.'
}
$service = Get-Service -Name vmms -ErrorAction SilentlyContinue
if (!$service) {
    Unavailable 'Служба управления виртуальными машинами Hyper-V (vmms) не обнаружена; проверьте компонент «Платформа Hyper-V» в компонентах Windows.'
}
if ($service.Status -ne 'Running') {
    Unavailable 'Служба управления виртуальными машинами Hyper-V (vmms) сейчас не запущена.'
}
if ((Get-CimInstance Win32_ComputerSystem).HypervisorPresent -ne $true) {
    Unavailable 'Windows не обнаружила работающий гипервизор; проверьте настройки виртуализации в прошивке и состояние запуска Hyper-V.'
}
if (!(Get-Command 'Hyper-V\Get-VMHost' -ErrorAction SilentlyContinue)) {
    Unavailable 'Отсутствует модуль управления Hyper-V для PowerShell; проверьте компонент «Средства управления Hyper-V» в компонентах Windows.'
}
Write-Output 'ready'
`
