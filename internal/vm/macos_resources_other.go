//go:build !darwin || !arm64 || !cgo || no_vz

package vm

import "errors"

func macOSRestoreResourceRequirements(string) (MacOSResourceRequirements, error) {
	return MacOSResourceRequirements{}, errors.New("Требования к образу восстановления Apple можно прочитать только на Mac с Apple Silicon")
}
