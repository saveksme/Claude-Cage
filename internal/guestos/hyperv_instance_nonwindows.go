//go:build !windows

package guestos

import (
	"context"
	"errors"

	"github.com/google/uuid"
)

func InspectHyperV(context.Context, uuid.UUID) (HyperVInspection, error) {
	return HyperVInspection{}, errors.New("--vm-id поддерживает только запрос виртуальных машин Windows Hyper-V на этом компьютере")
}
