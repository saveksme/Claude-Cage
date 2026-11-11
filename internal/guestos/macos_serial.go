package guestos

import (
	"bufio"
	"bytes"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/crypto/ssh"
)

// MacOSInstallHostKey reads the key written by the fresh guest's root-owned
// first-boot script to its VZ serial attachment, independent of loopback SSH.
func MacOSInstallHostKey(profile string) ([]byte, error) {
	path := filepath.Join(profile, "state", "lima", "mac", "serialv.log")
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() > 8<<20 {
		return nil, errors.New("Недопустимая запись последовательного порта первого запуска гостевой системы macOS")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	return parseInstallHostKey(io.LimitReader(file, info.Size()))
}

func parseInstallHostKey(input io.Reader) ([]byte, error) {
	const prefix = "CAGE-GUEST-HOST-KEY "
	scanner := bufio.NewScanner(input)
	var found []byte
	for scanner.Scan() {
		line := strings.TrimSuffix(scanner.Text(), "\r")
		keyLine, ok := strings.CutPrefix(line, prefix)
		if !ok {
			continue
		}
		key, _, opts, rest, err := ssh.ParseAuthorizedKey([]byte(keyLine))
		if err != nil || key.Type() != ssh.KeyAlgoED25519 || len(opts) != 0 || len(rest) != 0 {
			return nil, errors.New("При первом запуске виртуального Mac получен недопустимый открытый ключ хоста")
		}
		candidate := ssh.MarshalAuthorizedKey(key)
		if found != nil && !bytes.Equal(found, candidate) {
			return nil, errors.New("При первом запуске виртуального Mac получен другой открытый ключ хоста")
		}
		found = candidate
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	if found == nil {
		return nil, errors.New("Открытый ключ хоста ещё не получен через последовательный порт этого виртуального Mac")
	}
	return found, nil
}
