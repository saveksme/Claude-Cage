package guestos

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/google/uuid"
	"github.com/sylvinus/agent-vm/internal/hostimage"
)

// Installation persists only the media choice and private instance identity.
// macOS secrets live separately in the Cage account's encrypted vault.
type Installation struct {
	Version     int            `json:"version"`
	System      string         `json:"system"`
	Media       string         `json:"media,omitempty"`
	SHA256      string         `json:"sha256,omitempty"`
	EditorTerms bool           `json:"editor_terms,omitempty"`
	ID          uuid.UUID      `json:"id"`
	Source      hostimage.Plan `json:"source,omitzero"`
	// Empty preserves legacy host-clone records. LinuxImageSource selects a
	// catalog image independently of the physical host OS.
	SourceKind string `json:"source_kind,omitempty"`
}

const installRecord = "guest-install.json"
const LinuxImageSource = "linux-image"
const Ubuntu2204 = "ubuntu-22.04"

// Older installers could publish the binding before removing the temporary
// credential. Keep those profiles in setup until their original cleanup runs.
func WindowsCloneCleanupPending(profile string) (bool, error) {
	install, err := LoadInstallation(profile)
	if err != nil || install == nil || install.Source.Host.System != Windows11 {
		return false, err
	}
	path := filepath.Join(profile, "windows-setup-"+strings.ReplaceAll(install.ID.String(), "-", "")+".dpapi")
	_, err = os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	return err == nil, err
}

func (i Installation) Validate() error {
	if i.Version != 1 || i.ID == uuid.Nil || (i.System != MacOS && i.System != Windows11 && !hostimage.IsLinux(i.System)) {
		return errors.New("Недопустимая запись установки гостевой системы")
	}
	if i.SourceKind != "" && (i.SourceKind != LinuxImageSource || i.System != Ubuntu2204 || i.Source.Host.System != i.System) {
		return errors.New("Недопустимый способ выбора образа гостевой системы")
	}
	if i.Media != "" && (!filepath.IsAbs(i.Media) || strings.ContainsAny(i.Media, "\r\n\x00") || filepath.Clean(i.Media) != i.Media) {
		return errors.New("Выберите установочный образ на этом компьютере")
	}
	if i.Source.Host.System != "" {
		if i.System != i.Source.Host.System || (i.System == Windows11 && !i.EditorTerms) {
			return errors.New("Недопустимый выбор установки локальной системы; проверьте заново")
		}
		if i.Media != "" && i.Media != i.Source.Path {
			return errors.New("Установочный носитель не соответствует выбранному источнику локальной системы")
		}
		return i.Source.Validate()
	}
	if hostimage.IsLinux(i.System) {
		return errors.New("Отсутствует источник установки локальной системы Linux")
	}
	if i.System == MacOS {
		if i.SHA256 != "" || (i.Media != "" && !strings.EqualFold(filepath.Ext(i.Media), ".ipsw")) {
			return errors.New("Выберите образ восстановления Apple в формате .ipsw")
		}
	} else if hash, err := hex.DecodeString(i.SHA256); i.Media == "" || !i.EditorTerms || err != nil || len(hash) != 32 || !strings.EqualFold(filepath.Ext(i.Media), ".iso") {
		return errors.New("Выберите ISO-образ Windows 11 x64 и укажите полную контрольную сумму SHA-256 этого образа")
	}
	return nil
}

func LoadInstallation(profile string) (*Installation, error) {
	path := filepath.Join(profile, installRecord)
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() > 32<<10 {
		return nil, errors.New("Не удалось прочитать запись установки гостевой системы")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var i Installation
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&i) != nil || decoder.Decode(new(any)) != io.EOF {
		return nil, errors.New("Недопустимый формат записи установки гостевой системы")
	}
	if err := i.Validate(); err != nil {
		return nil, err
	}
	if i.Source.Host.System != "" {
		var ready struct {
			ID     uuid.UUID      `json:"id"`
			Source hostimage.Plan `json:"source"`
		}
		mediaPath := filepath.Join(profile, "guest-install-media-"+i.ID.String()+".json")
		info, err := os.Lstat(mediaPath)
		if err == nil {
			if !info.Mode().IsRegular() || info.Size() > 32<<10 {
				return nil, errors.New("Недопустимая запись проверенных установочных материалов")
			}
			data, readErr := os.ReadFile(mediaPath)
			if readErr != nil || json.Unmarshal(data, &ready) != nil || ready.ID != i.ID {
				return nil, errors.New("Не удалось прочитать проверенные установочные материалы")
			}
			if err := matchPreparedMedia(i.Source, ready.Source); err != nil {
				return nil, err
			}
			i.Source, i.Media = ready.Source, ready.Source.Path
			i.SHA256 = strings.TrimPrefix(ready.Source.Digest, "sha256:")
		} else if !errors.Is(err, os.ErrNotExist) {
			return nil, err
		}
	}
	return &i, i.Validate()
}

func SaveInstallation(profile string, i Installation) error {
	if err := i.Validate(); err != nil {
		return err
	}
	if current, err := LoadInstallation(profile); err != nil {
		return err
	} else if current != nil {
		if *current == i {
			return nil
		}
		return errors.New("Уже есть другой выбор установки; продолжите исходную установку")
	}
	data, err := json.Marshal(i)
	if err != nil {
		return err
	}
	return publishBinding(profile, installRecord, append(data, '\n'))
}

func matchPreparedMedia(chosen, ready hostimage.Plan) error {
	if err := ready.Validate(); err != nil {
		return err
	}
	if ready.Path == "" || ready.Digest == "" || ready.Host != chosen.Host || ready.Version != chosen.Version || ready.Build != chosen.Build ||
		ready.Format != chosen.Format || ready.URL != chosen.URL || (chosen.Digest != "" && ready.Digest != chosen.Digest) ||
		(chosen.Bytes != 0 && ready.Bytes != chosen.Bytes) || (chosen.Path != "" && ready.Path != chosen.Path) ||
		(chosen.Modified != 0 && ready.Modified != chosen.Modified) {
		return errors.New("Проверенные системные материалы не соответствуют исходному выбору установки")
	}
	return nil
}

// RecordPreparedMedia publishes a create-only receipt. The original choice
// remains immutable throughout downloading, installation and concurrent retries.
func RecordPreparedMedia(profile string, id uuid.UUID, ready hostimage.Plan) error {
	current, err := LoadInstallation(profile)
	if err != nil {
		return err
	}
	if current == nil || current.ID != id {
		return errors.New("Выбор установки изменился")
	}
	if err := matchPreparedMedia(current.Source, ready); err != nil {
		return err
	}
	data, err := json.Marshal(struct {
		ID     uuid.UUID      `json:"id"`
		Source hostimage.Plan `json:"source"`
	}{id, ready})
	if err != nil {
		return err
	}
	return publishBinding(profile, "guest-install-media-"+id.String()+".json", data)
}

func FinishLinuxInstallation(profile string, id uuid.UUID) error {
	installed, err := LoadInstallation(profile)
	if err != nil {
		return err
	}
	if installed == nil || installed.ID != id || !hostimage.IsLinux(installed.System) {
		return errors.New("Запись установки Linux изменилась")
	}
	// Keep recovery information until the persistent image choice can be read.
	system, err := hostimage.LinuxSystem(filepath.Join(profile, "state"))
	if err != nil {
		return err
	}
	if system != installed.System {
		return errors.New("Установка Linux ещё не сохранила выбранную систему; запись установки сохранена для продолжения")
	}
	return os.Remove(filepath.Join(profile, installRecord))
}

// UnstartedInstallation reports whether the choice can be changed while
// retaining every downloaded file and disk. A partial VM counts as started.
func UnstartedInstallation(profile string, i Installation) (bool, error) {
	paths := []string{"macos-guest.json", "windows-guest.json", "windows-install-vm.txt",
		filepath.Join("state", "windows-"+strings.ReplaceAll(i.ID.String(), "-", "")),
		filepath.Join("state", "lima", "mac"), filepath.Join("state", "lima", "base-building"), filepath.Join("state", "lima", "base")}
	for _, rel := range paths {
		_, err := os.Lstat(filepath.Join(profile, rel))
		if err == nil {
			return false, nil
		}
		if !errors.Is(err, os.ErrNotExist) {
			return false, err
		}
	}
	return true, nil
}

func ClearUnstartedInstallation(profile string, id uuid.UUID) error {
	pending, err := LoadInstallation(profile)
	if err != nil {
		return err
	}
	if pending == nil || pending.ID != id {
		return errors.New("Выбор установки гостевой системы изменился")
	}
	canClear, err := UnstartedInstallation(profile, *pending)
	if err != nil {
		return err
	}
	if !canClear {
		return errors.New("Создание гостевой системы уже начато; продолжите исходную установку")
	}
	if hostimage.IsLinux(pending.System) {
		if err := hostimage.ClearLinuxTemplate(filepath.Join(profile, "state"), pending.Source); err != nil {
			return err
		}
	}
	return os.Remove(filepath.Join(profile, installRecord))
}

// The Apple login surface accepts physical keys from the guest's initial US
// layout. Check this before downloading media or creating the local account.
func ValidMacOSInstallPassword(value string) bool {
	return len(value) >= 8 && len(value) <= 256 && strings.IndexFunc(value, func(r rune) bool { return r < ' ' || r > '~' }) < 0
}
