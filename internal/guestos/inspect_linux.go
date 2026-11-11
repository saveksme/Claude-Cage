package guestos

import (
	"bytes"
	"context"
	"runtime"
	"strings"

	"github.com/sylvinus/agent-vm/internal/host"
)

func Inspect(_ context.Context) Inspection {
	r := Inspection{Guest: Debian13, WorkbenchSupport: "supported"}
	if runtime.GOARCH != "amd64" {
		r.WorkbenchSupport = "unsupported-host"
		r.Detail = "Пакет для Linux-десктопа предназначен для хостов x86_64."
		return r
	}
	var details bytes.Buffer
	r.HostCheckPassed = host.LinuxPrereqs(&details)
	r.Detail = strings.TrimSpace(details.String())
	if r.HostCheckPassed {
		r.Detail = "Обнаружены компоненты виртуализации Linux, необходимые для рабочей среды Debian."
	}
	return r
}
