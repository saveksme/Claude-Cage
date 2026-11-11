package workbench

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"path"
	"strings"
	"time"
)

func macOSFileFailure(reason string) error {
	if err := desktopDownloadFailure(reason); err != nil {
		return err
	}
	switch reason {
	case "requires_gui_login":
		return errors.New("Сначала войдите и разблокируйте обычный аккаунт виртуального Mac")
	case "accessibility_permission":
		return errors.New("Разрешите Cage Guest Window универсальный доступ в виртуальном Mac и передайте файлы заново")
	case "window_changed", "file_dialog_changed", "gui_session_changed", "attachment_cancelled":
		return errors.New("Окно Claude, принимающее файл, изменилось; вернитесь в исходное окно и выберите файл заново")
	case "file_dialog_navigation_failed", "file_dialog_still_open", "file_dialog_selection_mismatch":
		return errors.New("Диалог выбора файлов гостевой системы ещё не принял файл; проверьте его и повторите")
	case "attachment_incomplete":
		return errors.New("Вложение передано не полностью; выберите файл заново")
	case "attachment_limit":
		return errors.New("За один раз можно передать не более 100 вложений; выбирайте файлы частями")
	default:
		return errors.New("Виртуальный Mac не принял вложение; убедитесь, что Claude Desktop открыт, а компоненты гостевой системы обновлены")
	}
}

func (s *Server) macOSDesktopFileCall(ctx context.Context, input macOSWindowRequest) (map[string]any, error) {
	if input.Action == "files-start" && (input.Window == 0 || input.PID <= 0) {
		return nil, macOSFileFailure("window_changed")
	}
	data, err := s.macOSWindowCall(ctx, input)
	if err != nil {
		return nil, err
	}
	var result map[string]any
	if json.Unmarshal(data, &result) != nil {
		return nil, errors.New("Неверный ответ о вложении виртуального Mac")
	}
	if reason, _ := result["error"].(string); reason != "" {
		return nil, macOSFileFailure(reason)
	}
	return result, nil
}

func validMacOSClipboardAttachment(value, name string) bool {
	if path.Clean(value) != value || strings.ContainsAny(value, "\\\x00\r\n") || path.Base(value) != name {
		return false
	}
	if !(strings.HasPrefix(value, "/var/folders/") || strings.HasPrefix(value, "/private/var/folders/") || strings.HasPrefix(value, "/tmp/") || strings.HasPrefix(value, "/private/tmp/")) {
		return false
	}
	directory := path.Base(path.Dir(value))
	suffix, ok := strings.CutPrefix(directory, "cage-clipboard-")
	return ok && suffix != "" && strings.Trim(suffix, "0123456789") == ""
}

func (s *Server) macOSUploadDesktopAttachment(ctx context.Context, name, id string, body io.Reader) (map[string]any, error) {
	if _, err := s.macOSDesktopFileCall(ctx, macOSWindowRequest{Action: "files-validate", ID: id}); err != nil {
		return nil, err
	}
	cmd, _, err := s.clipboardCommand(ctx, "upload", clipboardFileSelection{})
	if err != nil {
		return nil, err
	}
	input, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	output, err := cmd.StdoutPipe()
	if err != nil {
		input.Close()
		return nil, err
	}
	cmd.Stderr = io.Discard
	if err = cmd.Start(); err != nil {
		input.Close()
		output.Close()
		return nil, err
	}
	finished := false
	defer func() {
		input.Close()
		output.Close()
		if !finished {
			_ = cmd.Process.Kill()
			_ = cmd.Wait()
		}
	}()
	if err = json.NewEncoder(input).Encode(map[string]string{"name": name}); err == nil {
		err = writeWindowsAttachmentFrames(input, body)
	}
	if err != nil {
		return nil, err
	}
	input.Close()
	var reply struct {
		Paths []string `json:"paths"`
	}
	reader := bufio.NewScanner(output)
	reader.Buffer(make([]byte, 4096), 65536)
	if !reader.Scan() || json.Unmarshal(reader.Bytes(), &reply) != nil || len(reply.Paths) != 1 || !validMacOSClipboardAttachment(reply.Paths[0], name) {
		return nil, errors.New("Вложение виртуального Mac сохранено не полностью; передайте заново")
	}
	err = cmd.Wait()
	finished = true
	if err != nil {
		return nil, errors.New("Передача вложения виртуального Mac прервалась; выберите файл заново")
	}
	if _, err = s.macOSDesktopFileCall(ctx, macOSWindowRequest{Action: "files-add", ID: id, Files: reply.Paths}); err != nil {
		// An upload may finish after its window or batch was canceled. Remove
		// only the private file just returned by this successful upload.
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
		defer cancel()
		request, _ := json.Marshal(map[string]any{"operation": "discard", "files": reply.Paths})
		command := s.sshCommand(cleanup, "-T", s.sshTarget(), "--", "exec '/Applications/Cage Guest Clipboard.app/Contents/MacOS/CageGuestClipboard' --client request")
		command.Stdin = bytes.NewReader(append(request, '\n'))
		command.Stdout, command.Stderr = io.Discard, io.Discard
		_ = command.Run()
		return nil, err
	}
	return map[string]any{"ok": true, "id": id, "name": name}, nil
}

func (s *Server) macOSPasteDesktopImage(ctx context.Context, data []byte, window macOSWindowRequest) (map[string]any, error) {
	if len(data) == 0 || len(data) > maxImageBytes {
		return nil, errors.New("Неверный размер изображения")
	}
	if window.Window == 0 || window.PID <= 0 {
		return nil, macOSFileFailure("window_changed")
	}
	header, _ := json.Marshal(map[string]any{"action": "paste-image", "length": len(data), "pid": window.PID, "window": window.Window})
	cmd := s.sshCommand(ctx, "-T", s.sshTarget(), "--", macOSWindowSocketCommand)
	cmd.Stdin = io.MultiReader(bytes.NewReader(append(header, '\n')), bytes.NewReader(data))
	cmd.Stderr = io.Discard
	var reply bytes.Buffer
	cmd.Stdout = &boundedWindowsStatusWriter{buffer: &reply, remaining: 65536}
	if cmd.Run() != nil {
		return nil, errors.New("Изображение не удалось передать в виртуальный Mac; убедитесь, что Claude Desktop открыт")
	}
	var result map[string]any
	if json.Unmarshal(reply.Bytes(), &result) != nil {
		return nil, errors.New("Неверный ответ на изображение виртуального Mac")
	}
	if reason, _ := result["error"].(string); reason != "" {
		return nil, macOSFileFailure(reason)
	}
	if result["ok"] != true {
		return nil, errors.New("Виртуальный Mac не подтвердил вставку изображения")
	}
	return result, nil
}
