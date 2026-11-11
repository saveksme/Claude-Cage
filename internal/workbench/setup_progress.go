package workbench

import (
	"strconv"
	"strings"
	"time"
)

type SetupProgress struct {
	Phase          string  `json:"phase"`
	Label          string  `json:"label"`
	Received       *int64  `json:"received,omitempty"`
	Total          int64   `json:"total,omitempty"`
	System         string  `json:"system,omitempty"`
	Operation      string  `json:"operation,omitempty"`
	BytesPerSecond float64 `json:"bytes_per_second,omitempty"`
}

// Only fixed component names from the installer are displayed. Other output
// continues through the existing redacted operation log.
func parseSetupProgress(line string) *SetupProgress {
	line = strings.TrimSpace(line)
	if strings.HasPrefix(line, "CAGE_HOST_RETRY ") {
		fields := strings.Fields(line)
		if len(fields) != 3 || (fields[2] != "2" && fields[2] != "3") {
			return nil
		}
		label := macOSDownloadLabel(fields[1])
		if label == "" {
			return nil
		}
		return &SetupProgress{Phase: "image", Label: label + " (подготовка, попытка " + fields[2] + "/3)", System: "macos", Operation: "download"}
	}
	if strings.HasPrefix(line, "CAGE_HOST_BYTES ") {
		fields := strings.Fields(line)
		if len(fields) != 4 {
			return nil
		}
		label := macOSDownloadLabel(fields[1])
		received, err := strconv.ParseInt(fields[2], 10, 64)
		total, te := strconv.ParseInt(fields[3], 10, 64)
		if label == "" || err != nil || te != nil || received < 0 || total < 0 || total > 0 && received > total {
			return nil
		}
		return &SetupProgress{Phase: "image", Label: label, System: "macos", Operation: "download", Received: &received, Total: total}
	}
	if strings.HasPrefix(line, "下载 ") {
		if label := macOSDownloadLabel(strings.TrimPrefix(line, "下载 ")); label != "" {
			return &SetupProgress{Phase: "image", Label: label, System: "macos"}
		}
	}
	if strings.HasPrefix(line, "CAGE_GUEST_BYTES ") {
		fields := strings.Fields(line)
		if len(fields) != 5 {
			return nil
		}
		name := guestProgressName(fields[1])
		received, err := strconv.ParseInt(fields[3], 10, 64)
		total, te := strconv.ParseInt(fields[4], 10, 64)
		if name == "" || err != nil || te != nil || received < 0 || total < 0 || (total > 0 && received > total) {
			return nil
		}
		label := "Загружается " + name + " (системный образ)"
		switch fields[2] {
		case "download":
		case "verify":
			label = "Проверяется " + name + " (системный образ)"
		default:
			return nil
		}
		return &SetupProgress{Phase: "image", Label: label, Received: &received, Total: total, System: fields[1], Operation: fields[2]}
	}
	if strings.HasPrefix(line, "CAGE_GUEST_STAGE ") {
		fields := strings.Fields(line)
		if len(fields) != 3 || guestProgressName(fields[1]) == "" {
			return nil
		}
		p := &SetupProgress{System: fields[1]}
		if fields[1] == "windows-11" {
			p.Operation = fields[2]
		}
		switch fields[2] {
		case "restore":
			p.Phase, p.Label = "packages", "Устанавливается система "+guestProgressName(fields[1])
		case "account", "oobe", "credentials":
			if fields[1] != "windows-11" {
				return nil
			}
			p.Phase = "packages"
			p.Label = map[string]string{
				"account":     "Задайте локального администратора гостевой системы в окне установки",
				"oobe":        "Завершите первичную настройку Windows в окне подключения виртуальной машины",
				"credentials": "Введите учётную запись администратора гостевой системы в окне установки",
			}[fields[2]]
		case "media":
			p.Phase, p.Label = "image", "Идёт загрузка и проверка компонентов разработки гостевой системы"
		case "tools":
			p.Phase, p.Label = "tools", "Идёт установка приложений и инструментов разработки гостевой системы"
		case "services":
			p.Phase, p.Label = "services", "Идёт завершение настройки гостевой системы"
		default:
			return nil
		}
		return p
	}
	if strings.HasPrefix(line, "CAGE_IMAGE_BYTES ") {
		fields := strings.Fields(line)
		if len(fields) != 3 {
			return nil
		}
		received, err := strconv.ParseInt(fields[1], 10, 64)
		total, te := strconv.ParseInt(fields[2], 10, 64)
		if err != nil || te != nil || received < 0 || total < -1 || (total > 0 && received > total) {
			return nil
		}
		return &SetupProgress{Phase: "image", Label: "Идёт загрузка образа Debian 13", Received: &received, Total: max(total, 0)}
	}
	if strings.HasPrefix(line, "CAGE_TOOL_BYTES ") {
		fields := strings.Fields(line)
		if len(fields) != 3 && len(fields) != 4 {
			return nil
		}
		received, err := strconv.ParseInt(fields[2], 10, 64)
		if err != nil || received < 0 {
			return nil
		}
		p := &SetupProgress{Phase: "tools", Received: &received}
		if len(fields) == 4 {
			total, err := strconv.ParseInt(fields[3], 10, 64)
			if err != nil || total <= 0 || received > total {
				return nil
			}
			p.Total = total
		}
		switch fields[1] {
		case "mise.tar.gz":
			p.Phase, p.Label = "packages", "Идёт загрузка mise"
		case "code-server.deb":
			p.Label = "Идёт загрузка веб-редактора code-server"
		case "chromium.deb":
			p.Phase, p.Label = "packages", "Идёт загрузка браузера Chromium"
		case "chromium-common.deb":
			p.Phase, p.Label = "packages", "Идёт загрузка общих ресурсов Chromium"
		case "claude-code-linux-x64.tgz", "claude-code-linux-arm64.tgz":
			p.Label = "Идёт загрузка Claude Code"
		default:
			return nil
		}
		return p
	}
	switch line {
	case "CAGE_IMAGE_READY":
		return &SetupProgress{Phase: "image", Label: "Идёт запуск базовой среды Linux"}
	case "CAGE_IMAGE_VERIFY":
		return &SetupProgress{Phase: "image", Label: "Идёт проверка образа Debian"}
	case "Installing packages inside VM...", "Installing base packages...":
		return &SetupProgress{Phase: "packages", Label: "Идёт установка базовых пакетов Linux"}
	case "Installing Python 3...":
		return &SetupProgress{Phase: "packages", Label: "Идёт установка Python"}
	case "Installing Chromium...":
		return &SetupProgress{Phase: "packages", Label: "Идёт установка браузера Chromium"}
	case "Installing Node.js 24...":
		return &SetupProgress{Phase: "packages", Label: "Идёт установка Node.js 24"}
	case "Installing mise...":
		return &SetupProgress{Phase: "packages", Label: "Идёт установка mise"}
	case "Installing Claude Code...":
		return &SetupProgress{Phase: "tools", Label: "Идёт установка Claude Code"}
	case "Installing code-server...":
		return &SetupProgress{Phase: "tools", Label: "Идёт установка веб-редактора code-server"}
	}
	if strings.HasPrefix(line, "Running custom setup from ") {
		return &SetupProgress{Phase: "services", Label: "Идёт настройка служб рабочего стола"}
	}
	return nil
}

func macOSDownloadLabel(name string) string {
	component := map[string]string{
		"editor.tgz": "веб-редактор macOS", "playwright.tgz": "компонент управления браузером", "node.tgz": "Node.js",
		"macfuse.dmg": "компонент общих файлов macFUSE", "claude.dmg": "Claude Desktop", "chrome.dmg": "браузер Chrome",
		"macos-cli-claude": "Claude Code", "macos-cli-uv.tar.gz": "инструмент разработки uv",
		"macos-cli-python.tar.gz": "Python", "macos-cli-git.tar.gz": "Git", "macos-cli-gh.zip": "GitHub CLI",
	}[name]
	if component == "" {
		return ""
	}
	return "Загружается " + component
}

func guestProgressName(system string) string {
	return map[string]string{"macos": "macOS", "windows-11": "Windows 11", "debian-12": "Debian 12", "debian-13": "Debian 13", "ubuntu-22.04": "Ubuntu 22.04", "ubuntu-24.04": "Ubuntu 24.04"}[system]
}

func (e *jobExecution) setSetupProgress(p *SetupProgress) {
	e.owner.mu.Lock()
	defer e.owner.mu.Unlock()
	if e.id != "" && e.id == e.owner.state.ID && e.owner.state.Running {
		e.owner.state.SetupProgress = p
		e.progressUpdated = time.Now()
	}
}
