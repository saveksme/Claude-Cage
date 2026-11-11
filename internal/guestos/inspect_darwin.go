package guestos

import "context"

func Inspect(ctx context.Context) Inspection {
	r := Inspection{Guest: MacOS, WorkbenchSupport: nativeWorkbenchSupport(MacOS, false)}
	image, err := probeMacHost(ctx)
	if err != nil {
		r.Detail = "Не удалось получить совместимый с этим компьютером образ восстановления Apple: " + err.Error()
		return r
	}
	r.HostCheckPassed = true
	r.WorkbenchSupport = nativeWorkbenchSupport(MacOS, true)
	r.Restore = &image
	r.Detail = "Apple предоставляет образ восстановления macOS, совместимый с этим хостом."
	return r
}
