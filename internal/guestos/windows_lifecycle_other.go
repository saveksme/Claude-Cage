//go:build !windows

package guestos

import (
	"context"
	"errors"
)

func WindowsVMAction(context.Context, string, string) error {
	return errors.New("Управление жизненным циклом гостевой системы Windows требует хоста Windows Hyper-V")
}
