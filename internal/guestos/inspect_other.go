//go:build !darwin && !linux && !windows

package guestos

import "context"

func Inspect(_ context.Context) Inspection {
	return Inspection{WorkbenchSupport: "unsupported-host", Detail: "На этой платформе нет локальной рабочей среды Cage."}
}
