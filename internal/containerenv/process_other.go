//go:build !linux

package containerenv

import (
	"context"
	"errors"
	"os/exec"
)

func detachWorker(*exec.Cmd) {}
func tryLockRuntime(string) (func(), error) {
	return nil, errors.New("Среда выполнения контейнера поддерживается только на серверах Linux")
}
func lockRuntime(context.Context, string) (func(), error) {
	return nil, errors.New("Среда выполнения контейнера поддерживается только на серверах Linux")
}
