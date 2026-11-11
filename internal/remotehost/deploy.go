package remotehost

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/sylvinus/agent-vm/deploy/cloud"
	"golang.org/x/crypto/ssh"
)

func runSSH(client *ssh.Client, command string, input io.Reader) ([]byte, error) {
	session, err := client.NewSession()
	if err != nil {
		return nil, err
	}
	defer session.Close()
	out := &limitedOutput{limit: 64 << 10}
	session.Stdout, session.Stderr, session.Stdin = out, io.Discard, input
	err = session.Run(command)
	return out.Bytes(), err
}

func lifecycleCommand(p HostProfile, action string, extra ...string) string {
	args := []string{"bash", "-c", cloud.Lifecycle, "cage-cloud", action, p.Executable, p.ConfigPath}
	args = append(args, extra...)
	for i := range args {
		args[i] = shellQuote(args[i])
	}
	return strings.Join(args, " ")
}

func deploymentError(err error) error {
	var exit *ssh.ExitError
	if errors.As(err, &exit) {
		messages := map[int]string{
			61: "Требуется сервер Linux x86_64; войдите как обычный пользователь SSH",
			62: "На сервере отсутствуют сопоставление пользователей, инструменты, FUSE, TUN или cgroup v2, необходимые для rootless-контейнеров",
			63: "Пользовательские службы systemd пользователя SSH недоступны",
			64: "Для автоматического развёртывания нужен абсолютный путь конфигурации из букв, цифр, точек, дефисов, подчёркиваний и косых черт",
			65: "Целевой каталог или служба уже принадлежат другой конфигурации. Выберите пустой каталог конфигурации или укажите путь к установленной программе Cage",
			66: "Указанная программа Cage не найдена. При первом автоматическом развёртывании задайте путь к программе cage",
			67: "На этом сервере выполняется развёртывание Cage; подключитесь позже",
			68: "Для диска с каталогом конфигурации требуется не менее 7 GiB свободного места",
			69: "Проверка передачи пакета развёртывания не удалась; разверните заново",
			70: "Не удалось запустить отдельный движок контейнеров на сервере; проверьте журнал пользовательских служб и делегирование cgroup",
			71: "Сервер не может загрузить или проверить образ рабочей среды; проверьте место на диске",
			72: "Сервер не смог подготовить рабочую среду; посмотрите cloud-host/setup.log в каталоге конфигурации и повторите попытку",
			74: "Не удалось скачать движок контейнеров; проверьте сеть сервера и повторите попытку",
			75: "Сервер не может получить закреплённую версию базового образа Debian; проверьте сеть облака и повторите попытку",
			76: "Сервер не смог установить инструменты. Подробный журнал находится в cloud-host/build каталога конфигурации",
			73: "Не удалось запустить пользовательскую службу облачного Cage; проверьте журнал пользовательских служб сервера",
		}
		if message := messages[exit.ExitStatus()]; message != "" {
			return failure("cloud_setup_failed", message)
		}
	}
	return failure("server_entry_failed", "Облачный Cage не готов; проверьте программу Cage, путь конфигурации и пользовательские службы на сервере")
}

// SSH reads the archive as a stream. Report whole percentages without loading it into memory.
type uploadProgress struct {
	size, sent int64
	last       int
	phase      func(string)
}

func (p *uploadProgress) Write(data []byte) (int, error) {
	p.sent += int64(len(data))
	percent := int(p.sent * 100 / p.size)
	if percent != p.last {
		p.last = percent
		if percent == 100 {
			p.phase("cloud_install")
		} else {
			p.phase("cloud_upload_" + strconv.Itoa(percent))
		}
	}
	return len(data), nil
}

func cloudEntry(ctx context.Context, client *ssh.Client, p HostProfile, deploy bool, phase func(string)) ([]byte, error) {
	command, err := ServerEntryCommand(p)
	if err != nil {
		return nil, err
	}
	if out, err := runSSH(client, command, nil); err == nil {
		return out, nil
	}
	phase("cloud_detect")
	out, err := runSSH(client, lifecycleCommand(p, "probe"), nil)
	if err != nil {
		return nil, deploymentError(err)
	}
	switch string(out) {
	case "missing":
		if !deploy {
			return nil, failure("deployment_required", "На этом хосте Cage ещё не развёрнут. При развёртывании Cage и отдельная контейнерная среда будут установлены в каталог пользователя SSH.")
		}
		binary, err := os.Executable()
		if err != nil {
			return nil, err
		}
		payload := filepath.Join(filepath.Dir(binary), "cloud-linux-amd64.tar")
		sum, err := os.ReadFile(payload + ".sha256")
		digest := strings.TrimSpace(string(sum))
		if err != nil || !regexp.MustCompile("^[a-f0-9]{64}$").MatchString(digest) {
			return nil, failure("payload_missing", "В этом клиенте отсутствует пакет облачного развёртывания; установите Cage с пакетом развёртывания")
		}
		file, err := os.Open(payload)
		if err != nil {
			return nil, failure("payload_missing", "Не удалось прочитать пакет облачного развёртывания; проверьте установку Cage")
		}
		defer file.Close()
		info, err := file.Stat()
		if err != nil || !info.Mode().IsRegular() || info.Size() == 0 {
			return nil, failure("payload_missing", "Недопустимый пакет облачного развёртывания; проверьте установку Cage")
		}
		input := io.TeeReader(file, &uploadProgress{size: info.Size(), phase: phase})
		phase("cloud_upload_0")
		if _, err = runSSH(client, lifecycleCommand(p, "install", digest), input); err != nil {
			return nil, deploymentError(err)
		}
	case "manual", "managed":
		if out, err := runSSH(client, lifecycleCommand(p, "entry"), nil); err == nil {
			return out, nil
		}
		phase("cloud_start")
		if _, err := runSSH(client, lifecycleCommand(p, "start"), nil); err != nil {
			return nil, deploymentError(err)
		}
	default:
		return out, nil
	}
	phase("server_handshake")
	for i := 0; i < 40; i++ {
		if out, err := runSSH(client, lifecycleCommand(p, "entry"), nil); err == nil {
			return out, nil
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(500 * time.Millisecond):
		}
	}
	return nil, failure("server_start_timeout", "Облачная служба запросила запуск, но точка входа ещё не готова; проверьте журнал пользовательских служб и подключитесь заново")
}
