package workbench

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"
)

func (s *Server) macOSAudioStatus(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	cmd := s.sshCommand(ctx, "-T", s.sshTarget(), "--", macOSWindowSocketCommand)
	cmd.Stdin = strings.NewReader("{\"action\":\"audio-status\"}\n")
	cmd.Stderr = io.Discard
	var data bytes.Buffer
	cmd.Stdout = &boundedWindowsStatusWriter{buffer: &data, remaining: 4096}
	var status struct {
		Supported bool   `json:"supported"`
		Available bool   `json:"available"`
		Reason    string `json:"reason"`
		Error     string `json:"error"`
	}
	if cmd.Run() != nil || json.Unmarshal(data.Bytes(), &status) != nil {
		http.Error(w, "Звуковой компонент виртуального Mac не подключён; сначала обновите компоненты гостевой системы", http.StatusBadGateway)
		return
	}
	if status.Reason == "" {
		status.Reason = status.Error
	}
	if !status.Supported && status.Reason != "requires_gui_login" && status.Reason != "screen_recording_permission" {
		http.Error(w, "Звуковой компонент виртуального Mac не подключён; сначала обновите компоненты гостевой системы", http.StatusBadGateway)
		return
	}
	if !status.Available {
		message := "Сначала войдите и разблокируйте обычный аккаунт виртуального Mac"
		if status.Reason == "screen_recording_permission" {
			message = "Разрешите Cage Guest Window запись экрана и системного звука в настройках виртуального Mac"
		}
		http.Error(w, message, http.StatusConflict)
		return
	}
	jsonReply(w, audioFormat)
}

func (s *Server) macOSAudioCapture(w http.ResponseWriter, r *http.Request, ctx context.Context, cancel context.CancelFunc) {
	cmd := s.sshCommand(ctx, "-T", s.sshTarget(), "--", macOSWindowSocketCommand)
	cmd.Stderr = io.Discard
	input, err := cmd.StdinPipe()
	if err != nil {
		http.Error(w, "Не удалось установить звуковое подключение", http.StatusBadGateway)
		return
	}
	pipe, err := cmd.StdoutPipe()
	if err != nil {
		input.Close()
		http.Error(w, "Не удалось установить звуковое подключение", http.StatusBadGateway)
		return
	}
	if err = cmd.Start(); err != nil {
		input.Close()
		pipe.Close()
		http.Error(w, "Не удалось установить звуковое подключение", http.StatusBadGateway)
		return
	}
	defer func() { cancel(); input.Close(); pipe.Close(); _ = cmd.Wait() }()
	// Keep the request side open until cancellation so the guest can distinguish
	// a live, output-only subscriber from a disconnected SSH client.
	if _, err = io.WriteString(input, "{\"action\":\"audio-capture\"}\n"); err != nil {
		http.Error(w, "Не удалось установить звуковое подключение", http.StatusBadGateway)
		return
	}
	deadlineDone := make(chan struct{})
	deadline := time.AfterFunc(15*time.Second, func() { defer close(deadlineDone); cancel(); pipe.Close() })
	reader := bufio.NewReaderSize(pipe, 4096)
	err = readAudioReady(reader)
	stopped := cancelWindowsAdmissionDeadline(deadline, deadlineDone)
	if err != nil || !stopped {
		http.Error(w, "Не удалось запустить звук виртуального Mac; убедитесь, что гостевая система разблокирована и Cage Guest Window разрешена запись экрана и системного звука", http.StatusBadGateway)
		return
	}
	s.streamAudio(w, r.WithContext(ctx), bufferedAudio{Reader: reader, Closer: pipe})
}
