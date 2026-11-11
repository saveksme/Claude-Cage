package workbench

import (
	"al.essio.dev/pkg/shellescape"
	"bytes"
	"compress/gzip"
	"context"
	"errors"
	"github.com/sylvinus/agent-vm/internal/tailnetassets"
	"io"
	"strings"
	"time"
)

// Stage beside the installed executable so a running node can finish on its old
// inode. Identity and user data live elsewhere and are never part of installation.
const tailnetInstallScript = `set -eu; tmp=$(mktemp /tmp/cage-tailnet.XXXXXX); stage=; trap 'rm -f "$tmp"; if test -n "$stage"; then sudo rm -f "$stage"; fi' EXIT; cat > "$tmp"; stage=$(sudo mktemp /usr/local/bin/.cage-tailnet.XXXXXX); sudo install -m 0755 "$tmp" "$stage"; sudo mv -f "$stage" /usr/local/bin/cage-tailnet; printf 'cage-browser ALL=(cage) NOPASSWD: /usr/local/bin/cage-tailnet\n' | sudo tee /etc/sudoers.d/cage-tailnet >/dev/null; sudo chmod 0440 /etc/sudoers.d/cage-tailnet`

func (s *Server) refreshInstalledTailnet() error {
	ctx, cancel := context.WithTimeout(s.operationContext(), 15*time.Second)
	defer cancel()
	installed, err := s.guest(ctx, "if test -x /usr/local/bin/cage-tailnet; then printf installed; fi")
	if err != nil {
		return err
	}
	if strings.TrimSpace(string(installed)) == "installed" {
		return s.installTailnet()
	}
	return nil
}

func (s *Server) installTailnet() error {
	if s.macosGuest != nil || s.windowsGuest != nil {
		return errTailnetNativeInstall
	}
	if !s.vmRunning() {
		return errors.New("Сначала запустите среду Cage")
	}
	ctx, cancel := context.WithTimeout(s.operationContext(), 2*time.Minute)
	defer cancel()
	arch, err := s.guest(ctx, "uname -m")
	if err != nil {
		return err
	}
	name := "amd64"
	if string(bytes.TrimSpace(arch)) == "aarch64" {
		name = "arm64"
	} else if string(bytes.TrimSpace(arch)) != "x86_64" {
		return errors.New("Архитектура текущей гостевой системы пока не поддерживает Tailscale")
	}
	payload, err := tailnetassets.Linux(name)
	if err != nil {
		return errors.New("В этой сборке отсутствует компонент Tailscale для гостевой системы; установите полную сборку Cage")
	}
	defer payload.Close()
	reader, err := gzip.NewReader(payload)
	if err != nil {
		return err
	}
	defer reader.Close()
	cmd := s.sshCommand(ctx, "-T", s.sshTarget(), "--", "/bin/bash -c "+shellescape.Quote(tailnetInstallScript))
	cmd.Stdin = reader
	cmd.Stdout = io.Discard
	cmd.Stderr = io.Discard
	s.setMessage("Установка Tailscale, существующие терминалы и браузер продолжают работать…")
	if err := cmd.Run(); err != nil {
		return errors.New("Установка Tailscale не завершена; проверьте подключение гостевой системы и повторите")
	}
	return nil
}
