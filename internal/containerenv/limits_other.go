//go:build !linux

package containerenv

import (
	"context"
	"errors"
)

func (r *Runtime) ensureResourceSlice(context.Context) error {
	return errors.New("Граница ресурсов контейнера поддерживается только в Linux")
}
func (r *Runtime) verifyHostResources(context.Context, string) (resourceEvidence, error) {
	return resourceEvidence{}, errors.New("Граница ресурсов контейнера поддерживается только в Linux")
}
