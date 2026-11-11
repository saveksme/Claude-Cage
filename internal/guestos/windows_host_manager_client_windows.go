//go:build windows

package guestos

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
	"unsafe"

	"github.com/Microsoft/go-winio"
	"github.com/google/uuid"
	"golang.org/x/sys/windows"
)

func windowsHostManagerCall(ctx context.Context, id uuid.UUID, operation string, memory, cpus int, result any) error {
	request := windowsHostManagerRequest{Version: windowsHostManagerVersion, VMID: id, Operation: operation, MemoryGiB: memory, CPUs: cpus}
	return windowsHostManagerRequestCall(ctx, request, result)
}

func windowsHostManagerRequestCall(ctx context.Context, request windowsHostManagerRequest, result any) error {
	id := request.VMID
	if err := request.validate(); err != nil {
		return errors.New("Недопустимые параметры управления гостевой системой Windows")
	}
	ctx, cancel := context.WithTimeout(ctx, 3*time.Minute)
	defer cancel()
	connect, finish := context.WithTimeout(ctx, 10*time.Second)
	level := winio.PipeImpLevelIdentification
	if request.Storage != nil && request.Storage.Action == "attach" {
		// The verified service opens the destination using this caller's rights.
		level = winio.PipeImpLevelImpersonation
	}
	connection, err := winio.DialPipeAccessImpLevel(connect, `\\.\pipe\Cage.HyperV.`+id.String(), 0x120003, level)
	finish()
	if err != nil && ctx.Err() == nil {
		if startErr := startRegisteredWindowsHostManager(id); startErr == nil {
			retry, finish := context.WithTimeout(ctx, 10*time.Second)
			connection, err = winio.DialPipeAccessImpLevel(retry, `\\.\pipe\Cage.HyperV.`+id.String(), 0x120003, level)
			finish()
		}
	}
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return errors.New("Помощник системного управления Windows не подключён; завершите системную авторизацию или восстановите помощник в процессе установки Cage; исходная виртуальная машина и данные сохранены")
	}
	defer connection.Close()
	stop := context.AfterFunc(ctx, func() { _ = connection.Close() })
	defer stop()
	if deadline, ok := ctx.Deadline(); ok {
		_ = connection.SetDeadline(deadline)
	}
	if err := verifyWindowsHostManagerPeer(connection, id); err != nil {
		return err
	}
	if err := json.NewEncoder(connection).Encode(request); err != nil {
		return errors.New("Запрос системного управления Windows доставлен не полностью")
	}
	line, err := bufio.NewReaderSize(connection, windowsHostManagerWireLimit).ReadSlice('\n')
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return errors.New("Результат системного управления Windows возвращён не полностью; текущая среда сохранена")
	}
	var response windowsHostManagerResponse
	decoder := json.NewDecoder(bytes.NewReader(line))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&response) != nil || decoder.Decode(new(any)) != io.EOF || response.Version != windowsHostManagerVersion || response.VMID != id {
		return errors.New("Идентичность или формат ответа системного управления Windows не совпадают")
	}
	if err := verifyWindowsHostManagerPeer(connection, id); err != nil {
		return err
	}
	if !response.OK || response.Error != "" {
		if response.Error == "storage_pending" {
			return errors.New("У гостевой системы Windows есть незавершённая миграция хранилища; откройте исходную рабочую среду и завершите восстановление")
		}
		if response.Error == "vm_running" {
			return errors.New("Дождитесь полного выключения гостевой системы Windows, затем переносите хранилище среды")
		}
		if response.Error == "unauthorized" || response.Error == "permission_denied" {
			return errors.New("У текущего системного пользователя нет прав управления этой гостевой системой Cage")
		}
		if response.Error == "binding_mismatch" || response.Error == "layout_mismatch" || response.Error == "binding_invalid" {
			return errors.New("Зарегистрированная конфигурация гостевой системы Windows изменилась; сверьтесь с исходной виртуальной машиной; текущие данные сохранены")
		}
		return errors.New("Операция системного управления Windows не завершена; повторите попытку или выгрузите пакет диагностики в настройках; текущая среда сохранена")
	}
	if len(response.Result) == 0 || bytes.Equal(bytes.TrimSpace(response.Result), []byte("null")) || result == nil || json.Unmarshal(response.Result, result) != nil {
		return errors.New("В ответе системного управления Windows отсутствует фактический результат чтения")
	}
	return nil
}

func verifyWindowsHostManagerPeer(connection net.Conn, id uuid.UUID) error {
	f, ok := connection.(interface{ Fd() uintptr })
	if !ok {
		return errors.New("Не удалось проверить канал системного управления Windows")
	}
	var pid uint32
	if windows.GetNamedPipeServerProcessId(windows.Handle(f.Fd()), &pid) != nil || pid == 0 {
		return errors.New("Не удалось проверить процесс системного управления Windows")
	}
	// Query the SCM with read-only rights. A normal user cannot open the
	// LocalSystem process token; the protected service account and live PID
	// provide the corresponding identity without requesting that privilege.
	manager, err := windows.OpenSCManager(nil, nil, windows.SC_MANAGER_CONNECT)
	if err != nil {
		return errors.New("Не удалось прочитать идентичность службы системного управления Windows")
	}
	defer windows.CloseServiceHandle(manager)
	name, _ := windows.UTF16PtrFromString("CageHV-" + id.String())
	service, err := windows.OpenService(manager, name, windows.SERVICE_QUERY_CONFIG|windows.SERVICE_QUERY_STATUS)
	if err != nil {
		return errors.New("Служба системного управления Windows не зарегистрирована или недоступна текущему пользователю")
	}
	defer windows.CloseServiceHandle(service)
	var status windows.SERVICE_STATUS_PROCESS
	var needed uint32
	if windows.QueryServiceStatusEx(service, windows.SC_STATUS_PROCESS_INFO, (*byte)(unsafe.Pointer(&status)), uint32(unsafe.Sizeof(status)), &needed) != nil || status.ProcessId != pid || status.CurrentState != windows.SERVICE_RUNNING {
		return errors.New("Канал системного управления Windows не принадлежит текущей зарегистрированной службе")
	}
	return verifyWindowsHostManagerService(service, id)
}

func verifyWindowsHostManagerService(service windows.Handle, id uuid.UUID) error {
	binaryPath, account, err := windowsHostServiceConfig(service)
	if err != nil {
		return errors.New("Не удалось проверить конфигурацию службы системного управления Windows")
	}
	if !strings.EqualFold(account, "LocalSystem") && !strings.EqualFold(account, `NT AUTHORITY\SYSTEM`) {
		return errors.New("Служба системного управления Windows не использует ограниченную системную учётную запись")
	}
	program, err := windows.KnownFolderPath(windows.FOLDERID_ProgramFiles, 0)
	if err != nil {
		return err
	}
	expected := filepath.Join(program, "Cage Host Manager", id.String(), "Cage.HyperVManager.exe")
	data, err := windows.KnownFolderPath(windows.FOLDERID_ProgramData, 0)
	if err != nil {
		return err
	}
	binding := filepath.Join(data, "Cage", "HyperVManager", id.String(), "binding.json")
	arguments, err := windows.DecomposeCommandLine(binaryPath)
	if err != nil || len(arguments) != 4 || !strings.EqualFold(filepath.Clean(arguments[0]), filepath.Clean(expected)) || arguments[1] != "service" || arguments[2] != "--binding" || !strings.EqualFold(filepath.Clean(arguments[3]), filepath.Clean(binding)) {
		return errors.New("Программа системного управления Windows находится не в зарегистрированном месте установки")
	}
	if err := checkWindowsSystemOwnedObject(binding); err != nil {
		return err
	}
	for current := expected; !strings.EqualFold(current, program); current = filepath.Dir(current) {
		if current == filepath.Dir(current) {
			return fmt.Errorf("Недопустимый путь программы системного управления Windows")
		}
		if err := checkWindowsSystemOwnedObject(current); err != nil {
			return err
		}
	}
	return nil
}

// Installation already grants the bound user SERVICE_START. Restoring that
// fixed service after a reboot does not grant VM discovery or service editing.
func startRegisteredWindowsHostManager(id uuid.UUID) error {
	binding, err := LoadWindowsHostManagerBinding(WindowsHostManagerBindingPath(id))
	if err != nil {
		return err
	}
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil || user.User.Sid.String() != binding.HostSID {
		return errors.New("unauthorized")
	}
	manager, err := windows.OpenSCManager(nil, nil, windows.SC_MANAGER_CONNECT)
	if err != nil {
		return err
	}
	defer windows.CloseServiceHandle(manager)
	name, _ := windows.UTF16PtrFromString(WindowsHostManagerServiceName(id))
	service, err := windows.OpenService(manager, name, windows.SERVICE_QUERY_CONFIG|windows.SERVICE_START)
	if err != nil {
		return err
	}
	defer windows.CloseServiceHandle(service)
	if err = verifyWindowsHostManagerService(service, id); err != nil {
		return err
	}
	err = windows.StartService(service, 0, nil)
	if errors.Is(err, windows.ERROR_SERVICE_ALREADY_RUNNING) {
		return nil
	}
	return err
}

func windowsHostServiceConfig(service windows.Handle) (string, string, error) {
	// QUERY_SERVICE_CONFIG contains pointers into this native output buffer.
	// A variable-sized allocation stays on the heap when later Go calls grow
	// the stack; copy its strings before releasing the retained buffer.
	size := uint32(1024)
	for size <= windowsHostManagerWireLimit {
		buffer := make([]byte, size)
		config := (*windows.QUERY_SERVICE_CONFIG)(unsafe.Pointer(&buffer[0]))
		var needed uint32
		err := windows.QueryServiceConfig(service, config, size, &needed)
		if err == nil {
			binaryPath, account := windows.UTF16PtrToString(config.BinaryPathName), windows.UTF16PtrToString(config.ServiceStartName)
			runtime.KeepAlive(buffer)
			return binaryPath, account, nil
		}
		runtime.KeepAlive(buffer)
		if !errors.Is(err, windows.ERROR_INSUFFICIENT_BUFFER) || needed <= size {
			return "", "", err
		}
		size = needed
	}
	return "", "", errors.New("Windows service configuration exceeds limit")
}

func checkWindowsSystemOwnedObject(path string) error {
	info, err := os.Lstat(path)
	if err != nil {
		return errors.New("Программа или каталог системного управления Windows недоступны для чтения")
	}
	ptr, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	attributes, err := windows.GetFileAttributes(ptr)
	if err != nil || attributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 || !info.Mode().IsRegular() && !info.IsDir() {
		return errors.New("Программа системного управления Windows не должна проходить через ссылку на каталог")
	}
	sd, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return errors.New("Не удалось прочитать права программы системного управления Windows")
	}
	owner, _, err := sd.Owner()
	if err != nil || owner == nil || !owner.IsWellKnown(windows.WinLocalSystemSid) && !owner.IsWellKnown(windows.WinBuiltinAdministratorsSid) {
		return errors.New("Программа системного управления Windows не защищена системными правами")
	}
	acl, _, err := sd.DACL()
	if err != nil || acl == nil || acl.AceCount == 0 {
		return errors.New("Программа системного управления Windows не имеет ограничений доступа")
	}
	const fileDeleteChild = 0x40 // FILE_DELETE_CHILD is absent from x/sys/windows.
	const writes = windows.FILE_WRITE_DATA | windows.FILE_APPEND_DATA | windows.FILE_WRITE_EA | windows.FILE_WRITE_ATTRIBUTES | fileDeleteChild | windows.DELETE | windows.WRITE_DAC | windows.WRITE_OWNER | windows.GENERIC_WRITE | windows.GENERIC_ALL
	for i := uint32(0); i < uint32(acl.AceCount); i++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if windows.GetAce(acl, i, &ace) != nil {
			return errors.New("Не удалось проверить права программы системного управления Windows")
		}
		if ace.Header.AceType == windows.ACCESS_DENIED_ACE_TYPE {
			continue
		}
		if ace.Header.AceType != windows.ACCESS_ALLOWED_ACE_TYPE {
			return errors.New("Программа системного управления Windows содержит неподдерживаемые правила прав")
		}
		principal := (*windows.SID)(unsafe.Pointer(&ace.SidStart))
		if ace.Mask&writes != 0 && !principal.IsWellKnown(windows.WinLocalSystemSid) && !principal.IsWellKnown(windows.WinBuiltinAdministratorsSid) {
			return errors.New("Программа системного управления Windows может быть изменена обычным пользователем")
		}
	}
	return nil
}
