//go:build windows

package guestos

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/google/uuid"
)

func windowsVMResources(ctx context.Context, root string, memoryGiB, cpus int) (WindowsVMResourceState, error) {
	if (memoryGiB == 0) != (cpus == 0) || memoryGiB < 0 || memoryGiB > 1024 || cpus < 0 || cpus > 1024 {
		return WindowsVMResourceState{}, errors.New("Недопустимые параметры ресурсов гостевой системы Windows")
	}
	binding, err := LoadWindowsProfile(root)
	if err != nil {
		return WindowsVMResourceState{}, err
	}
	if binding == nil {
		return WindowsVMResourceState{}, errors.New("Эта конфигурация ещё не привязана к гостевой системе Windows")
	}
	var result WindowsVMResourceState
	if err := windowsHostManagerCall(ctx, binding.VMID, "resources", memoryGiB, cpus, &result); err != nil {
		return result, err
	}
	if result.CPUs < 1 || result.MemoryStartup < 2<<30 || result.State == "" {
		return result, errors.New("Недопустимое состояние ресурсов гостевой системы Windows")
	}
	if memoryGiB != 0 && !result.MatchesAllocation(memoryGiB, cpus) {
		return result, errors.New("Ресурсы гостевой системы Windows не достигли запрошенных значений")
	}
	return result, nil
}

func windowsVMResourcesNative(ctx context.Context, id uuid.UUID, memoryGiB, cpus int) (WindowsVMResourceState, error) {
	if id == uuid.Nil || (memoryGiB == 0) != (cpus == 0) || memoryGiB < 0 || memoryGiB > 1024 || cpus < 0 || cpus > 1024 {
		return WindowsVMResourceState{}, errors.New("Недопустимые параметры ресурсов гостевой системы Windows")
	}
	script := fmt.Sprintf("$targetId=[guid]'%s'\n$memoryGiB=%d\n$cpus=%d\n", id.String(), memoryGiB, cpus) + windowsVMResourcesScript
	cmd, err := systemPowerShellQuery(ctx, script)
	if err != nil {
		return WindowsVMResourceState{}, err
	}
	data, err := cmd.Output()
	if ctx.Err() != nil {
		return WindowsVMResourceState{}, ctx.Err()
	}
	if err != nil {
		return WindowsVMResourceState{}, errors.New("Операция с ресурсами гостевой системы Windows не завершена; проверьте состояние виртуальной машины и права управления")
	}
	var result WindowsVMResourceState
	if json.Unmarshal(data, &result) != nil || result.CPUs < 1 || result.MemoryStartup < 2<<30 {
		return result, errors.New("Недопустимое состояние ресурсов гостевой системы Windows")
	}
	if memoryGiB != 0 && !result.MatchesAllocation(memoryGiB, cpus) {
		return result, errors.New("Ресурсы гостевой системы Windows не достигли запрошенных значений")
	}
	return result, nil
}
