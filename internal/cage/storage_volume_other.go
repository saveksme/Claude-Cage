//go:build !windows && !linux && !darwin

package cage

import "errors"

func localStorageVolume(string) error {
	return errors.New("Эта платформа не поддерживает пользовательское хранилище среды")
}
