//go:build !windows

package guestos

import (
	"context"
	"errors"
	"os/exec"
)

func WindowsMaintenanceCommand(context.Context, string, string, string, bool) (*exec.Cmd, error) {
	return nil, errors.New("Обслуживание гостевой системы Windows требует её хоста Windows Hyper-V")
}
