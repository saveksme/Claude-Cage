//go:build !windows

package guestos

import (
	"context"
	"errors"
	"os/exec"
)

func WindowsInstallCommand(context.Context, string, string, Installation) (*exec.Cmd, error) {
	return nil, errors.New("Для гостевой системы Windows требуется хост Windows 11 x64 с Hyper-V")
}
