//go:build !linux

package containerenv

import (
	"context"
	"errors"
)

func (r *Runtime) inspectMounts(*engineContainer) (MountPropagation, error) {
	return MountPropagation{}, errors.New("Проверка монтирования контейнера поддерживается только в Linux")
}
func (r *Runtime) initializeMounts(context.Context, string) error {
	return errors.New("Инициализация монтирования контейнера поддерживается только в Linux")
}
