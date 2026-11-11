//go:build !windows

package hostimage

import (
	"context"
	"errors"
)

func expandWindowsCatalog(context.Context, []byte) ([]byte, error) {
	return nil, errors.New("Для каталога установки Windows требуются системные компоненты распаковки Windows")
}
