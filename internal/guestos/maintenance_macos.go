package guestos

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"regexp"
	"runtime"
	"strings"
	"time"

	"al.essio.dev/pkg/shellescape"
	"github.com/sylvinus/agent-vm/internal/hostproxy"
)

// MaintainMacOSComponents operates only on an already bound VZ identity. Its
// staging and installers are independent of account creation and OS restoration.
func MaintainMacOSComponents(ctx context.Context, profile, kit, manifestPath string, tools bool, stdout, stderr io.Writer) error {
	if runtime.GOOS != "darwin" {
		return errors.New("Обслуживание гостевой системы macOS требует её хоста Mac")
	}
	binding, err := LoadMacOSProfile(profile)
	if err != nil {
		return err
	}
	if binding == nil {
		return errors.New("Эта конфигурация ещё не привязана к гостевой системе macOS")
	}
	required, err := RequiredNativeComponents(kit, MacOS)
	if err != nil {
		return err
	}
	data, err := os.ReadFile(manifestPath)
	if err != nil {
		return err
	}
	var selected NativeComponentManifest
	if json.Unmarshal(data, &selected) != nil || selected.Validate() != nil || !reflect.DeepEqual(required, selected) {
		return errors.New("Пакет компонентов приложения изменился; запустите обновление заново")
	}
	provision, err := MacOSProvisionUser(profile)
	if err != nil {
		return err
	}
	args, err := MacOSSSHArgs(profile, provision)
	if err != nil {
		return err
	}
	guest := func(callctx context.Context, script string) *exec.Cmd {
		argv := append(append([]string{}, args...), "-T", "cage-macos", "--", "exec /bin/bash -ec "+shellescape.Quote(script))
		command := exec.CommandContext(callctx, "/usr/bin/ssh", argv...)
		command.Stderr = stderr
		return command
	}
	mode := "components"
	cache := filepath.Join(profile, "state", "guest-media", MacOS)
	if tools {
		mode = "tools"
		exe, err := os.Executable()
		if err != nil {
			return err
		}
		command := exec.CommandContext(ctx, "/bin/bash", filepath.Join(kit, "prepare-macos-media.sh"), cache)
		command.Env = append(append(os.Environ(), hostproxy.DownloadEnvironment()...), "CAGE_REFRESH_TOOLS=1", "CAGE_HOST_DOWNLOADER="+exe)
		command.Stdout, command.Stderr = stdout, stderr
		if err = command.Run(); err != nil {
			return fmt.Errorf("Не удалось подготовить пакет нативных инструментов: %w", err)
		}
	}
	local, err := os.MkdirTemp("", "cage-native-components-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(local)
	if err = os.WriteFile(filepath.Join(local, "native-components.json"), data, 0600); err != nil {
		return err
	}
	output, err := guest(ctx, `umask 077; test "$(id -un)" = `+shellescape.Quote(provision)+`; mktemp -d /private/var/tmp/cage-components.XXXXXXXX`).Output()
	remote := strings.TrimSpace(string(output))
	if err != nil || !regexp.MustCompile(`^/private/var/tmp/cage-components\.[A-Za-z0-9]{8}$`).MatchString(remote) {
		return errors.New("Не удалось подготовить каталог обслуживания компонентов в привязанной гостевой системе")
	}
	passwordInput := ` < /Users/` + provision + `/password`
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = guest(cleanup, `sudo -S -p '' /bin/rm -rf `+remote+passwordInput).Run()
	}()
	archiveArgs := []string{"--no-mac-metadata", "-cf", "-", "-C", kit, ".", "-C", local, "native-components.json"}
	if tools {
		archiveArgs = append(archiveArgs, "-C", cache, "node.tgz", "editor.tgz", "playwright.tgz", "chrome.dmg", "cli")
	}
	archive := exec.CommandContext(ctx, "/usr/bin/tar", archiveArgs...)
	archive.Env = append(os.Environ(), "COPYFILE_DISABLE=1")
	var archiveErrors bytes.Buffer
	archive.Stderr = &archiveErrors
	pipe, err := archive.StdoutPipe()
	if err != nil {
		return err
	}
	receiver := guest(ctx, `umask 077; cd `+remote+`; /usr/bin/tar -xf -`)
	receiver.Stdin = pipe
	if err = archive.Start(); err != nil {
		return err
	}
	receiveErr := receiver.Run()
	pipe.Close()
	archiveErr := archive.Wait()
	if archiveErrors.Len() > 0 {
		_, _ = stderr.Write(archiveErrors.Bytes())
	}
	if err = errors.Join(receiveErr, archiveErr); err != nil {
		return fmt.Errorf("Не удалось передать нативные компоненты: %w", err)
	}
	takeOwnership := guest(ctx, `sudo -S -p '' /usr/sbin/chown -R root:wheel `+remote+passwordInput)
	if err = takeOwnership.Run(); err != nil {
		return errors.New("Не удалось получить права на обслуживание компонентов в привязанной гостевой системе")
	}
	script := shellescape.QuoteCommand([]string{"/bin/bash", remote + "/maintain-macos-workbench.sh", remote, binding.User, mode})
	command := guest(ctx, `sudo -S -p '' `+script+passwordInput)
	command.Stdout = stdout
	if err = command.Run(); err != nil {
		return fmt.Errorf("Обслуживание нативных компонентов не завершено; исходная система и аккаунт сохранены, обновление можно повторить: %w", err)
	}
	return nil
}

func WriteNativeComponentManifest(filename string, manifest NativeComponentManifest) error {
	if err := manifest.Validate(); err != nil {
		return err
	}
	data, err := json.Marshal(manifest)
	if err != nil {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(filename), ".native-components-*.json")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	_, writeErr := file.Write(append(bytes.TrimSpace(data), '\n'))
	err = errors.Join(writeErr, file.Sync(), file.Close())
	if err != nil {
		return err
	}
	return os.Rename(file.Name(), filename)
}
