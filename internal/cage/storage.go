package cage

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/sylvinus/agent-vm/internal/host"
	"github.com/sylvinus/agent-vm/internal/paths"
)

type StorageLocation struct {
	Directory      string `json:"directory"`
	Custom         bool   `json:"custom"`
	HasEnvironment bool   `json:"has_environment"`
	Backup         string `json:"backup,omitempty"`
}

type storageRecord struct {
	Directory string   `json:"directory"`
	ID        string   `json:"id"`
	Backups   []string `json:"backups,omitempty"`
}

const locationFile = "environment-storage.json"
const pendingFile = "environment-storage-pending.json"
const storageMarker = ".cage-storage-id"

type storageMove struct {
	Next storageRecord
	// Previous anchor is retained when the old storage is a directory.
	// If it was a link, only the link is discarded after commit.
	PreviousCustom bool
	Runtime        string            `json:",omitempty"`
	Transition     StorageTransition `json:",omitempty"`
}

func readStorageRecord(profile string) (storageRecord, error) {
	var r storageRecord
	b, err := os.ReadFile(filepath.Join(profile, locationFile))
	if errors.Is(err, os.ErrNotExist) {
		return r, nil
	}
	if err != nil {
		return r, err
	}
	if err = json.Unmarshal(b, &r); err != nil || !filepath.IsAbs(r.Directory) || !validStorageID(r.ID) {
		return storageRecord{}, errors.New("Конфигурация хранилища среды Cage повреждена. Сначала восстановите конфигурацию")
	}
	return r, nil
}

func validStorageID(id string) bool {
	return len(id) == 32 && strings.Trim(id, "0123456789abcdef") == ""
}

func writeStorageJSON(path string, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".storage-config-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	_, err = f.Write(data)
	if err == nil {
		err = f.Sync()
	}
	if err = errors.Join(err, f.Close()); err != nil {
		return err
	}
	return renameStorage(f.Name(), path)
}

func sameStoragePath(a, b string) bool {
	a, b = filepath.Clean(a), filepath.Clean(b)
	if runtime.GOOS == "windows" || runtime.GOOS == "darwin" {
		return strings.EqualFold(a, b)
	}
	return a == b
}

// Resolve the existing prefix too: both a new data directory and an offline
// project grant can have a final component which does not exist yet.
func StoragePhysicalPath(path string) (string, error) {
	if !filepath.IsAbs(path) {
		return "", errors.New("Выберите абсолютный путь")
	}
	path = filepath.Clean(path)
	real, err := paths.Resolve(path)
	if err == nil {
		return real, nil
	}
	if !os.IsNotExist(err) || filepath.Dir(path) == path {
		return "", err
	}
	if _, err = os.Lstat(path); err == nil || !os.IsNotExist(err) {
		return "", errors.New("Каталог содержит неразрешимую ссылку")
	}
	parent, err := StoragePhysicalPath(filepath.Dir(path))
	if err != nil {
		return "", err
	}
	return filepath.Join(parent, filepath.Base(path)), nil
}

func StorageContains(parent, child string) bool {
	rel, err := filepath.Rel(paths.Fold(filepath.Clean(parent)), paths.Fold(filepath.Clean(child)))
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

func StoragePathsOverlap(a, b string) bool {
	return StorageContains(a, b) || StorageContains(b, a)
}

// Resolve the application folder, including macOS bundles and Windows resources.
func runningApplicationDir() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	exe, err = paths.Resolve(exe)
	if err != nil {
		return "", err
	}
	dir := filepath.Dir(exe)
	for parent := dir; parent != filepath.Dir(parent); parent = filepath.Dir(parent) {
		if strings.EqualFold(filepath.Ext(parent), ".app") {
			return parent, nil
		}
	}
	if strings.EqualFold(filepath.Base(dir), "resources") {
		return filepath.Dir(dir), nil
	}
	return dir, nil
}

// StoragePrivatePaths reports every externally located copy, including old
// disks retained for recovery. The main profile itself is already private.
func StoragePrivatePaths(profile string) ([]string, error) {
	r, err := readStorageRecord(profile)
	if err != nil {
		return nil, err
	}
	private := append([]string(nil), r.Backups...)
	if r.Directory != "" {
		private = append(private, r.Directory)
	} else if _, e := os.Readlink(storageAnchor(profile)); e == nil {
		real, e := paths.Resolve(storageAnchor(profile))
		if e != nil {
			return nil, e
		}
		private = append(private, real)
	}
	// A partially copied environment must also be protected from new shares.
	b, err := os.ReadFile(filepath.Join(profile, pendingFile))
	if errors.Is(err, os.ErrNotExist) {
		return private, nil
	}
	if err != nil {
		return nil, err
	}
	var p storageMove
	if err = json.Unmarshal(b, &p); err != nil {
		return nil, err
	}
	return append(private, p.Next.Directory), nil
}

func storageAnchor(profile string) string { return filepath.Join(profile, "state") }

func getStorageLocation(profile string) (StorageLocation, error) {
	r, err := readStorageRecord(profile)
	if err != nil {
		return StorageLocation{}, err
	}
	anchor := storageAnchor(profile)
	loc := StorageLocation{Directory: anchor, Custom: r.Directory != ""}
	if loc.Custom {
		loc.Directory = r.Directory
		real, err := paths.Resolve(anchor)
		target, te := paths.Resolve(filepath.Join(r.Directory, "state"))
		marker, me := os.ReadFile(filepath.Join(r.Directory, storageMarker))
		if err != nil || te != nil || me != nil || string(marker) != r.ID || !sameStoragePath(real, target) {
			return loc, fmt.Errorf("Хранилище среды недоступно. Подключите исходный диск заново: %s", r.Directory)
		}
		if err = localStorageVolume(target); err != nil {
			return loc, err
		}
	} else if _, e := os.Readlink(anchor); e == nil {
		// Older installs may have an operator-managed symlink. Keep their
		// original cache, VM identity and path resolution on ordinary starts.
		real, e := paths.Resolve(anchor)
		if e != nil {
			return loc, e
		}
		fi, e := os.Stat(real)
		if e != nil || !fi.IsDir() {
			return loc, fmt.Errorf("Каталог среды недоступен: %s", anchor)
		}
		if _, e = os.Stat(filepath.Join(filepath.Dir(real), storageMarker)); !errors.Is(e, os.ErrNotExist) {
			return loc, errors.New("Конфигурация хранилища среды отсутствует. Восстановите исходную конфигурацию")
		}
		loc.Directory = real
	} else if info, err := os.Lstat(anchor); err == nil && !info.IsDir() {
		return loc, fmt.Errorf("Неожиданный тип каталога среды: %s", anchor)
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return loc, err
	}
	if len(r.Backups) > 0 {
		loc.Backup = r.Backups[len(r.Backups)-1]
	}
	entries, err := os.ReadDir(filepath.Join(anchor, "lima"))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return loc, err
	}
	for _, entry := range entries {
		if entry.IsDir() && !strings.HasPrefix(entry.Name(), "_") {
			loc.HasEnvironment = true
			break
		}
	}
	if _, err := os.Stat(filepath.Join(profile, "windows-guest.json")); err == nil {
		loc.HasEnvironment = true
	} else if !errors.Is(err, os.ErrNotExist) {
		return loc, err
	}
	return loc, nil
}

func GetStorageLocation(profile string) (StorageLocation, error) {
	lock, err := openStorageLock(profile, false)
	if err != nil {
		return StorageLocation{}, err
	}
	defer lock.Close()
	return getStorageLocation(profile)
}

// AcquireStorageUse holds the same shared lease for the entire Cage command,
// including detached hostagents. A migration cannot run in the launch window.
func AcquireStorageUse(profile string) (*os.File, StorageLocation, error) {
	lock, err := openStorageLock(profile, false)
	if err != nil {
		return nil, StorageLocation{}, err
	}
	loc, err := getStorageLocation(profile)
	if err != nil {
		lock.Close()
		return nil, loc, err
	}
	return lock, loc, nil
}

func openStorageLock(profile string, exclusive bool) (*os.File, error) {
	return openStorageLockWithRuntime(context.Background(), profile, exclusive, nil)
}

func openStorageLockWithRuntime(ctx context.Context, profile string, exclusive bool, runtime StorageRuntime) (*os.File, error) {
	f, err := os.OpenFile(filepath.Join(profile, "environment-storage.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	ok, err := lockStorageFile(f, exclusive)
	if err != nil || !ok {
		f.Close()
		if err == nil {
			err = errors.New("Среда работает или переносится. Остановите среду и дождитесь завершения текущей операции")
		}
		return nil, err
	}
	if _, err = os.Stat(filepath.Join(profile, pendingFile)); errors.Is(err, os.ErrNotExist) {
		return f, nil
	}
	if err != nil {
		f.Close()
		return nil, err
	}
	if !exclusive {
		f.Close()
		// Acquire exclusively before attempting recovery, then reacquire a
		// shared lease. Recheck the journal once more under the new lease.
		w, err := openStorageLockWithRuntime(ctx, profile, true, runtime)
		if err != nil {
			return nil, err
		}
		w.Close()
		return openStorageLockWithRuntime(ctx, profile, false, runtime)
	}
	if err = recoverStorageWithRuntime(ctx, profile, runtime); err != nil {
		f.Close()
		return nil, err
	}
	return f, nil
}

func ValidateStorageTarget(profile, directory string) error {
	app, err := runningApplicationDir()
	if err != nil {
		return err
	}
	return validateStorageTarget(profile, directory, app, runtime.GOOS)
}

func validateStorageTarget(profile, directory, app, platform string) error {
	if _, err := os.Readlink(storageAnchor(profile)); err == nil {
		r, err := readStorageRecord(profile)
		if err != nil {
			return err
		}
		if r.Directory == "" {
			return errors.New("Текущая среда использует вручную настроенную ссылку на каталог. Сначала восстановите исходный каталог, затем используйте перенос Cage")
		}
	}
	if !filepath.IsAbs(directory) || filepath.Clean(directory) == filepath.VolumeName(directory)+string(os.PathSeparator) {
		return errors.New("Выберите отдельный абсолютный путь на локальном диске; корень диска использовать нельзя")
	}
	target, err := StoragePhysicalPath(directory)
	if err != nil {
		return err
	}
	// Check the actual mount, including junctions and symlinked parents.
	existing := target
	for {
		if _, err = os.Stat(existing); err == nil {
			break
		}
		if !errors.Is(err, os.ErrNotExist) || filepath.Dir(existing) == existing {
			return err
		}
		existing = filepath.Dir(existing)
	}
	if sameStoragePath(existing, target) {
		root, e := storageMountRoot(existing)
		if e != nil {
			return e
		}
		if root {
			return errors.New("Создайте отдельную папку на диске; корень тома использовать нельзя")
		}
	}
	if err = localStorageVolume(existing); err != nil {
		return err
	}
	private, err := StoragePrivatePaths(profile)
	if err != nil {
		return err
	}
	private = append(private, profile, EnvironmentDir(profile))
	appData := windowsApplicationDataDirectory(app, platform)
	// Windows reserves this one data folder beside its program files. The
	// installer preserves it by file ownership during update and uninstall.
	if appData == "" || !sameStoragePath(directory, appData) {
		private = append(private, app)
	}
	for _, p := range private {
		real, e := StoragePhysicalPath(p)
		if e != nil && !errors.Is(e, os.ErrNotExist) {
			return e
		}
		if StoragePathsOverlap(directory, p) || (real != "" && StoragePathsOverlap(target, real)) {
			return errors.New("Выберите отдельный пустой каталог, не пересекающийся с программой, конфигурацией, рабочей областью, текущим хранилищем или резервными копиями")
		}
	}
	if info, e := os.Lstat(directory); e == nil && (!info.IsDir() || info.Mode()&(os.ModeSymlink|os.ModeIrregular) != 0) {
		return errors.New("Цель должна быть настоящим локальным каталогом")
	} else if e != nil && !errors.Is(e, os.ErrNotExist) {
		return e
	}
	entries, err := os.ReadDir(directory)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if len(entries) > 0 {
		return errors.New("Для хранилища среды нужен отдельный пустой каталог. Создайте папку")
	}
	return nil
}

func stoppedStorage(source string) error {
	// Examine every instance, including interrupted base construction.
	instances, err := os.ReadDir(filepath.Join(source, "lima"))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	for _, inst := range instances {
		if !inst.IsDir() || strings.HasPrefix(inst.Name(), "_") {
			continue
		}
		dir := filepath.Join(source, "lima", inst.Name())
		entries, err := os.ReadDir(dir)
		if err != nil {
			return err
		}
		for _, entry := range entries {
			name := entry.Name()
			if !strings.HasSuffix(name, ".pid") && name != "cage-running.json" {
				continue
			}
			data, err := os.ReadFile(filepath.Join(dir, name))
			if err != nil {
				return err
			}
			var pid int
			started := ""
			if name == "cage-running.json" {
				var record runningProfile
				err = json.Unmarshal(data, &record)
				pid, started = record.PID, record.Started
			} else {
				pid, err = strconv.Atoi(strings.TrimSpace(string(data)))
			}
			if err != nil || pid < 1 {
				return fmt.Errorf("Не удалось проверить запись процесса виртуальной машины %s", name)
			}
			if profileProcessAlive(pid) && ProcessStartMatches(pid, started) {
				return fmt.Errorf("Сначала остановите виртуальную машину %s, затем переносите среду", inst.Name())
			}
		}
	}
	return nil
}

func MoveStorage(ctx context.Context, profile, directory string, expected StorageLocation, report func(copied, total int64)) (loc StorageLocation, err error) {
	return MoveStorageWithRuntime(ctx, profile, directory, expected, nil, report)
}

func MoveStorageWithRuntime(ctx context.Context, profile, directory string, expected StorageLocation, runtime StorageRuntime, report func(copied, total int64)) (loc StorageLocation, err error) {
	lock, err := openStorageLockWithRuntime(ctx, profile, true, runtime)
	if err != nil {
		return loc, err
	}
	defer lock.Close()
	if _, bindingErr := os.Stat(filepath.Join(profile, "windows-guest.json")); bindingErr == nil && runtime == nil {
		return loc, errors.New("При переносе гостевой системы Windows нужно синхронно обновить привязку диска в помощнике управления системой")
	} else if bindingErr != nil && !errors.Is(bindingErr, os.ErrNotExist) {
		return loc, bindingErr
	}
	loc, err = getStorageLocation(profile)
	if err != nil {
		return loc, err
	}
	if !sameStoragePath(expected.Directory, loc.Directory) || expected.HasEnvironment != loc.HasEnvironment {
		return loc, errors.New("Среда или расположение хранилища изменились. Выберите заново")
	}
	if err = ValidateStorageTarget(profile, directory); err != nil {
		return loc, err
	}
	directory, err = StoragePhysicalPath(directory)
	if err != nil {
		return loc, err
	}
	anchor := storageAnchor(profile)
	if err = stoppedStorage(anchor); err != nil {
		return loc, err
	}
	previous, err := readStorageRecord(profile)
	if err != nil {
		return loc, err
	}
	var token [16]byte
	if _, err = rand.Read(token[:]); err != nil {
		return loc, err
	}
	id := fmt.Sprintf("%x", token)
	next := storageRecord{Directory: directory, ID: id, Backups: append([]string(nil), previous.Backups...)}
	anchorBackup := filepath.Join(profile, "state-backup-"+id)
	src := anchor
	info, statErr := os.Lstat(anchor)
	if statErr != nil && !errors.Is(statErr, os.ErrNotExist) {
		return loc, statErr
	}
	if statErr == nil {
		backup := anchorBackup
		if loc.Custom {
			backup = loc.Directory
			src = filepath.Join(loc.Directory, "state")
		}
		next.Backups = append(next.Backups, backup)
	}
	move := storageMove{Next: next, PreviousCustom: loc.Custom}
	var excluded []string
	if runtime != nil {
		snapshot, snapshotErr := runtime.Snapshot(ctx, src)
		if snapshotErr != nil {
			return loc, snapshotErr
		}
		backup := anchorBackup
		if loc.Custom {
			backup = src
		}
		move.Runtime = runtime.Name()
		move.Transition = StorageTransition{ID: id, Source: src, Destination: filepath.Join(directory, "state"), Backup: backup, State: snapshot.State}
		if move.Runtime == "" || !json.Valid(snapshot.State) {
			return loc, errors.New("В транзакции хранилища гостевой системы отсутствуют действительные данные восстановления")
		}
		for _, retained := range snapshot.Backups {
			if !filepath.IsAbs(retained) || StoragePathsOverlap(retained, directory) {
				return loc, errors.New("Путь резервной копии гостевой системы конфликтует с целью переноса")
			}
			move.Next.Backups = append(move.Next.Backups, retained)
		}
		next = move.Next
		for _, path := range snapshot.Excluded {
			if !filepath.IsAbs(path) || sameStoragePath(path, src) || !StorageContains(src, path) {
				return loc, errors.New("Файл управления гостевой системой выходит за текущий каталог хранилища")
			}
		}
		excluded = snapshot.Excluded
	}
	if err = host.EnsurePrivateDir(directory); err != nil {
		if errors.Is(err, os.ErrPermission) {
			return loc, fmt.Errorf("Не удалось ограничить доступ к целевому каталогу текущим пользователем. Выберите пустую папку, созданную вами, с правом изменения разрешений: %w", err)
		}
		return loc, err
	}
	if err = ValidateStorageTarget(profile, directory); err != nil {
		return loc, err
	}
	if err = writeStorageJSON(filepath.Join(profile, pendingFile), move); err != nil {
		return loc, err
	}
	// Recovery only removes files under the newly claimed target with a
	// matching random identity. It never recursively removes an old copy.
	defer func() {
		// A cancelled copy still needs bounded time to restore its VM binding.
		recovery, cancel := context.WithTimeout(context.WithoutCancel(ctx), 3*time.Minute)
		defer cancel()
		if recErr := recoverStorageWithRuntime(recovery, profile, runtime); recErr != nil {
			err = errors.Join(err, fmt.Errorf("восстановление переноса: %w", recErr))
		}
	}()
	if err = claimStorageTarget(directory, id); err != nil {
		return loc, err
	}
	destState := filepath.Join(directory, "state")
	if err = os.Mkdir(destState, 0700); err != nil {
		return loc, err
	}
	// An independently created state directory must never be mistaken for
	// one owned by this transfer when recovering after a failed mkdir.
	if err = claimStorageTarget(destState, id); err != nil {
		_ = os.Remove(destState)
		return loc, err
	}
	if runtime != nil {
		if err = runtime.Begin(ctx, move.Transition); err != nil {
			return loc, err
		}
	}
	if info != nil {
		if err = copyStorageExcluding(ctx, src, destState, excluded, report); err != nil {
			return loc, err
		}
	}
	staged := filepath.Join(profile, ".storage-link-"+id)
	if err = linkStorage(staged, destState); err != nil {
		return loc, err
	}
	if err = syncStorageDir(directory); err != nil {
		return loc, err
	}
	if err = ctx.Err(); err != nil {
		return loc, err
	}
	if runtime != nil {
		if err = runtime.Switch(ctx, move.Transition); err != nil {
			return loc, err
		}
	}
	if err = ctx.Err(); err != nil {
		return loc, err
	}
	if info != nil {
		if err = renameStorage(anchor, anchorBackup); err != nil {
			return loc, err
		}
	}
	if err = renameStorage(staged, anchor); err != nil {
		return loc, err
	}
	if err = writeStorageJSON(filepath.Join(profile, locationFile), next); err != nil {
		return loc, err
	}
	return getStorageLocation(profile)
}

func claimStorageTarget(dir, id string) error {
	f, err := os.OpenFile(filepath.Join(dir, storageMarker), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	_, err = io.WriteString(f, id)
	if err == nil {
		err = f.Sync()
	}
	return errors.Join(err, f.Close())
}

func recoverStorage(profile string) error {
	return recoverStorageWithRuntime(context.Background(), profile, nil)
}

func recoverStorageWithRuntime(ctx context.Context, profile string, runtime StorageRuntime) error {
	journal := filepath.Join(profile, pendingFile)
	b, err := os.ReadFile(journal)
	if err != nil {
		return err
	}
	var p storageMove
	if err = json.Unmarshal(b, &p); err != nil {
		return err
	}
	next := p.Next
	if !validStorageID(next.ID) || !filepath.IsAbs(next.Directory) {
		return errors.New("Запись переноса хранилища повреждена")
	}
	if p.Runtime != "" && (runtime == nil || runtime.Name() != p.Runtime) {
		return ErrStorageRuntimeRecovery
	}
	if p.Runtime != "" && (p.Transition.ID != next.ID || !sameStoragePath(p.Transition.Destination, filepath.Join(next.Directory, "state")) || !filepath.IsAbs(p.Transition.Source) || !filepath.IsAbs(p.Transition.Backup) || !json.Valid(p.Transition.State)) {
		return errors.New("Запись восстановления хранилища гостевой системы повреждена")
	}
	r, err := readStorageRecord(profile)
	if err != nil {
		return err
	}
	old := filepath.Join(profile, "state-backup-"+next.ID)
	stage := filepath.Join(profile, ".storage-link-"+next.ID)
	anchor := storageAnchor(profile)
	dest := filepath.Join(next.Directory, "state")
	if r.ID == next.ID {
		if p.Runtime != "" {
			if err = runtime.Recover(ctx, p.Transition, true); err != nil {
				return err
			}
		}
		if token, e := os.ReadFile(filepath.Join(dest, storageMarker)); e == nil && string(token) == next.ID {
			if err = os.Remove(filepath.Join(dest, storageMarker)); err != nil {
				return err
			}
		}
		if p.PreviousCustom {
			if err = os.Remove(old); err != nil && !errors.Is(err, os.ErrNotExist) {
				return err
			}
		}
	} else {
		if t, e := os.Readlink(anchor); e == nil && sameStoragePath(t, dest) {
			if err = os.Remove(anchor); err != nil {
				return err
			}
		}
		if _, e := os.Lstat(old); e == nil {
			if _, e = os.Lstat(anchor); !errors.Is(e, os.ErrNotExist) {
				return fmt.Errorf("Сохраните старую среду и проверьте каталог переноса: %s", old)
			}
			if err = renameStorage(old, anchor); err != nil {
				return err
			}
		} else if !errors.Is(e, os.ErrNotExist) {
			return e
		}
		if p.Runtime != "" {
			if err = runtime.Recover(ctx, p.Transition, false); err != nil {
				return err
			}
		}
		// Disconnected destination disks never prevent resuming the old copy.
		marker := filepath.Join(next.Directory, storageMarker)
		if token, e := os.ReadFile(marker); e == nil && string(token) == next.ID {
			if owner, e := os.ReadFile(filepath.Join(dest, storageMarker)); e == nil && string(owner) == next.ID {
				if err = os.RemoveAll(dest); err != nil {
					return err
				}
			}
			if err = os.Remove(marker); err != nil {
				return err
			}
		}
	}
	if err = os.Remove(stage); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return os.Remove(journal)
}
