//go:build !linux

package containerenv

import (
	"context"
	"errors"
	"io"
)

func RunTAP(context.Context, io.Reader, io.Writer) error {
	return errors.New("Среда выполнения контейнера Cage поддерживается только на серверах Linux")
}
