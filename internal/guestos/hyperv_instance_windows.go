package guestos

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/google/uuid"
)

//go:embed hyperv_instance.ps1
var hyperVInstanceQuery string

// InspectHyperV reads Hyper-V configuration without starting the VM, opening a
// guest session, enumerating unrelated VMs, or binding this VM to Cage.
func InspectHyperV(ctx context.Context, id uuid.UUID) (HyperVInspection, error) {
	if id == uuid.Nil {
		return HyperVInspection{}, errors.New("expected a non-empty Hyper-V VM GUID")
	}
	report := HyperVInspection{Inspection: Inspect(ctx), VMID: id.String(), Lookup: "unavailable"}
	if !report.HostCheckPassed {
		return report, nil
	}
	var actual HyperVInspection
	if err := windowsHostManagerCall(ctx, id, "inspect", 0, 0, &actual); err != nil {
		if ctx.Err() != nil {
			return report, ctx.Err()
		}
		report.LookupDetail = err.Error()
		return report, nil
	}
	if actual.VMID != id.String() || actual.Lookup != "found" || actual.VM == nil {
		return report, errors.New("Помощник системного управления Windows вернул недопустимую идентичность виртуальной машины")
	}
	actual.Inspection = report.Inspection
	return actual, nil
}

func inspectHyperVNative(ctx context.Context, id uuid.UUID) (HyperVInspection, error) {
	if id == uuid.Nil {
		return HyperVInspection{}, errors.New("expected a non-empty Hyper-V VM GUID")
	}
	report := HyperVInspection{Inspection: Inspection{Guest: Windows11, HostCheckPassed: true, WorkbenchSupport: nativeWorkbenchSupport(Windows11, true)}, VMID: id.String(), Lookup: "unavailable"}
	// UUID.String supplies only hexadecimal digits and dashes.
	query := fmt.Sprintf("$targetId = [guid]'%s'\n", id.String()) + hyperVInstanceQuery
	cmd, err := systemPowerShellQuery(ctx, query)
	if err != nil {
		return report, err
	}
	output, err := cmd.Output()
	if ctx.Err() != nil {
		return report, ctx.Err()
	}
	if err != nil {
		report.LookupDetail = "Не удалось прочитать конфигурацию Hyper-V этой виртуальной машины; проверьте права текущего пользователя и состояние виртуальной машины."
		return report, nil
	}
	if err := json.Unmarshal(output, &report.VM); err != nil {
		return report, errors.New("Hyper-V вернул нераспознанную конфигурацию виртуальной машины")
	}
	if report.VM == nil {
		report.Lookup = "not-found"
		report.LookupDetail = "Текущий пользователь не нашёл локальную виртуальную машину Hyper-V с этим идентификатором."
	} else {
		report.Lookup = "found"
	}
	return report, nil
}
