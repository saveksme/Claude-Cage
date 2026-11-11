package workbench

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	pathpkg "path"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/sylvinus/agent-vm/internal/host"
)

type desktopFileOpen struct {
	ID      string `json:"id,omitempty"`
	Path    string `json:"path,omitempty"`
	Action  string `json:"action,omitempty"`
	Handled bool   `json:"handled,omitempty"`
}

// Resolve a guest path against directory grants, never against the host root.
// Both lexical traversal and a host-side symlink out of the project are denied.
func resolveProjectFilePath(guest string, projects []string) (string, error) {
	if !pathpkg.IsAbs(guest) || pathpkg.Clean(guest) != guest || strings.ContainsAny(guest, "\x00\\") {
		return "", errors.New("Неверное расположение файла")
	}
	for _, project := range projects {
		if isClientMountPath(project) {
			continue
		}
		root := strings.TrimRight(guestPath(project), "/")
		if guest != root && !strings.HasPrefix(guest, root+"/") {
			continue
		}
		hostRoot, err := filepath.EvalSymlinks(project)
		if err != nil {
			continue
		}
		target, err := filepath.EvalSymlinks(filepath.Join(hostRoot, filepath.FromSlash(strings.TrimPrefix(guest, root))))
		if err != nil {
			return "", errors.New("Файл перемещён, удалён или недоступен")
		}
		relative, err := filepath.Rel(hostRoot, target)
		if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) || filepath.IsAbs(relative) {
			return "", errors.New("Файл указывает за пределы каталога проекта Cage и не может быть открыт")
		}
		info, err := os.Stat(target)
		if err != nil || (!info.Mode().IsRegular() && !info.IsDir()) {
			return "", errors.New("Выберите обычный файл или папку в проекте Cage")
		}
		return target, nil
	}
	return "", errors.New("Можно открывать только файлы и папки в каталогах проектов Cage")
}

func (s *Server) resolveDesktopProjectFile(guest string, projects []string) (string, error) {
	if s.macosGuest == nil && s.windowsGuest == nil {
		return resolveProjectFilePath(guest, projects)
	}
	if s.windowsGuest != nil {
		guest = strings.ReplaceAll(guest, "\\", "/")
		if !windowsCLIAbsolutePath(guest) || strings.Contains(guest[2:], ":") {
			return "", errors.New("Неверное расположение файла")
		}
	}
	if pathpkg.Clean(guest) != guest || strings.ContainsAny(guest, "\x00\\") {
		return "", errors.New("Неверное расположение файла")
	}
	for _, project := range projects {
		if isClientMountPath(project) {
			continue
		}
		var root string
		if s.macosGuest != nil {
			root = macOSProjectPath(s.macosGuest.User, project)
		} else {
			binding, err := s.windowsProjectForHost(project)
			if err != nil {
				continue
			}
			root = strings.ReplaceAll(binding.Path, "\\", "/")
		}
		root = strings.TrimRight(root, "/")
		if !cliWorkspaceWithin(guest, root, s.windowsGuest != nil) {
			continue
		}
		mapped := strings.TrimRight(guestPath(project), "/") + guest[len(root):]
		return resolveProjectFilePath(mapped, []string{project})
	}
	return "", errors.New("Можно открывать только файлы и папки в авторизованных проектах Cage")
}

func (s *Server) desktopFileOpenAction(w http.ResponseWriter, r *http.Request) {
	var input struct {
		ID    string `json:"id"`
		Stage string `json:"stage"`
		Error string `json:"error"`
	}
	if !readJSON(w, r, &input) {
		return
	}
	if !browserFileID.MatchString(input.ID) || (input.Stage != "claim" && input.Stage != "complete") {
		http.Error(w, "Неверный запрос открытия файла", 400)
		return
	}
	if !s.fileTargetReady("desktop", "") {
		http.Error(w, "Среда ещё не готова", 409)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Minute)
	defer cancel()
	body, _ := json.Marshal(input)
	result, err := s.guestFiles(ctx, "desktop", "POST", "/open-"+input.Stage, bytes.NewReader(body), "")
	if err != nil {
		requestError(w, err)
		return
	}
	if input.Stage == "complete" || result["handled"] == true {
		jsonReply(w, result)
		return
	}
	guest, _ := result["path"].(string)
	action, _ := result["action"].(string)
	var target string
	download, _ := result["download_id"].(string)
	if message, _ := result["error"].(string); message != "" {
		err = errors.New(message)
	} else if action != "open" && action != "reveal" {
		err = errors.New("Неверная операция открытия файла")
	} else if download != "" && (s.macosGuest != nil || s.windowsGuest != nil) {
		var saved browserDownloadInfo
		saved, err = s.downloadInfo(ctx, download)
		if err == nil && saved.State != "saved" {
			err = errors.New("Файл ещё не полностью сохранён на хосте; откройте его позже")
		}
		target = saved.Path
		if err == nil && result["directory"] == true {
			target = filepath.Dir(target)
		}
	} else {
		var projects []string
		projects, err = s.projectPaths()
		if err == nil {
			target, err = s.resolveDesktopProjectFile(guest, projects)
		}
	}
	if err != nil {
		body, _ = json.Marshal(map[string]string{"id": input.ID, "error": err.Error()})
		cleanup, cancelCleanup := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancelCleanup()
		_, _ = s.guestFiles(cleanup, "desktop", "POST", "/open-complete", bytes.NewReader(body), "")
		requestError(w, err)
		return
	}
	jsonReply(w, desktopFileOpen{ID: input.ID, Path: target, Action: action})
}

// DesktopFileForConnection consumes one pending app request. The web bridge
// supplies only an opaque ID; the authenticated local controller owns its path.
func DesktopFileForConnection(configPath, connectionID, id string) (map[string]any, error) {
	if !browserFileID.MatchString(id) {
		return nil, errors.New("Неверный идентификатор открытия файла")
	}
	client, err := connectController(filepath.Dir(configPath))
	if err != nil {
		return nil, err
	}
	defer client.close()
	entry, _ := url.Parse(client.launch.URL)
	status, err := client.call("POST", "/api/session", map[string]string{"token": entry.Fragment}, nil)
	if err != nil || status != 200 {
		return nil, errors.New("Не удалось подключиться к сеансу файловых операций")
	}
	connection, err := client.bindConnection(connectionID)
	if err != nil {
		return nil, err
	}
	var request desktopFileOpen
	err = desktopOpenCall(client, map[string]string{"id": id, "stage": "claim"}, &request)
	if err != nil {
		return nil, err
	}
	if request.Handled {
		return map[string]any{"handled": true}, nil
	}
	if connection.Mode == "remote" {
		err = errors.New("Этот файл находится в удалённой среде; сначала сохраните его на этот компьютер из списка загрузок")
	} else if request.ID != id || !filepath.IsAbs(request.Path) || (request.Action != "open" && request.Action != "reveal") {
		err = errors.New("Неверный ответ открытия файла")
	} else {
		err = openHostFile(request.Path, request.Action)
	}
	message := ""
	if err != nil {
		message = err.Error()
	}
	completeErr := desktopOpenCall(client, map[string]string{"id": id, "stage": "complete", "error": message}, nil)
	if err != nil {
		return nil, err
	}
	if completeErr != nil {
		return nil, completeErr
	}
	return map[string]any{"ok": true}, nil
}

func desktopOpenCall(client *controllerClient, input map[string]string, output any) error {
	body, _ := json.Marshal(input)
	request, _ := http.NewRequest("POST", client.origin+"/api/input/files/desktop/open", bytes.NewReader(body))
	request.Header.Set("Origin", client.origin)
	request.Header.Set("Content-Type", "application/json")
	response, err := client.client.Do(request)
	if err != nil {
		return errors.New("Подключение файловых операций прервалось; откройте заново")
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, 65537))
	if err != nil || len(data) > 65536 {
		return errors.New("Неверный ответ файловой операции")
	}
	if response.StatusCode != http.StatusOK {
		message := strings.TrimSpace(string(data))
		if message == "" {
			message = "Запрос открытия файла устарел; повторите действие"
		}
		return errors.New(message)
	}
	if output != nil && json.Unmarshal(data, output) != nil {
		return errors.New("Неверный ответ файловой операции")
	}
	return nil
}

func hostFileCommand(platform, path, action string, directory bool) *exec.Cmd {
	switch platform {
	case "darwin":
		if action == "reveal" {
			return exec.Command("/usr/bin/open", "-R", "--", path)
		}
		return exec.Command("/usr/bin/open", "--", path)
	case "windows":
		if action == "reveal" {
			return exec.Command("explorer.exe", "/select,"+path)
		}
		if directory {
			return exec.Command("explorer.exe", path)
		}
		return exec.Command("rundll32.exe", "url.dll,FileProtocolHandler", path)
	default:
		if action == "reveal" {
			uri := (&url.URL{Scheme: "file", Path: filepath.ToSlash(path)}).String()
			return exec.Command("gdbus", "call", "--session", "--dest", "org.freedesktop.FileManager1", "--object-path", "/org/freedesktop/FileManager1", "--method", "org.freedesktop.FileManager1.ShowItems", "[\""+uri+"\"]", "")
		}
		return exec.Command("gio", "open", path)
	}
}

func openHostFile(path, action string) error {
	info, err := os.Stat(path)
	if err != nil || (!info.Mode().IsRegular() && !info.IsDir()) {
		return errors.New("Файл перемещён, удалён или недоступен")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	command := hostFileCommand(runtime.GOOS, path, action, info.IsDir())
	cmd := exec.CommandContext(ctx, command.Path, command.Args[1:]...)
	host.HideCommandWindow(cmd)
	if err = cmd.Run(); err != nil {
		if runtime.GOOS != "linux" || action != "reveal" {
			return errors.New("Не удалось открыть локальный файл или файловый менеджер; проверьте приложение по умолчанию и права на файлы")
		}
		fallback := exec.CommandContext(ctx, "gio", "open", filepath.Dir(path))
		if fallback.Run() != nil {
			return errors.New("Не удалось открыть локальный файловый менеджер; проверьте среду рабочего стола и права на файлы")
		}
	}
	return nil
}
