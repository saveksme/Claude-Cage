//go:build !windows

package guestos

import (
	"context"
	"errors"
)

func windowsVMResources(context.Context, string, int, int) (WindowsVMResourceState, error) {
	return WindowsVMResourceState{}, errors.New("Управление ресурсами гостевой системы Windows требует хоста Windows Hyper-V")
}
