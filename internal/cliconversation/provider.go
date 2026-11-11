// Package cliconversation runs a structured Claude Code turn inside an environment
// chosen by the caller. It does not select a host, grant a project, or own sessions.
package cliconversation

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os/exec"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode/utf8"
)

type Runner struct {
	// Command must bind the supplied context to the guest process and select the
	// authorized project and CLI profile. Args never contain the user's prompt.
	Command func(context.Context, string, []string) (*exec.Cmd, error)
	// Approve returns a decision for this specific call. It must return when
	// its context is cancelled. Nil selects unattended permission denial.
	Approve func(context.Context, PermissionRequest) bool
	// A guest supervisor reads a JSON string on the first line, forwards the
	// decoded prompt to Claude's stdin, then monitors this pipe for disconnect.
	SupervisedStdin bool
	OnTools         func([]ToolActivity)
}

type Turn struct {
	Workspace string
	SessionID string
	Prompt    string
	Resume    bool
}

type Result struct {
	Started     bool
	SingleTurn  bool
	Text        string
	DeniedTools []string
}

var (
	sessionIDPattern = regexp.MustCompile("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
	toolNamePattern  = regexp.MustCompile("^[a-zA-Z0-9_.:-]{1,128}$")
)

const (
	maxPromptBytes = 64 << 10
	maxEventBytes  = 8 << 20
	maxTextBytes   = 1 << 20
)

// Run emits assistant text deltas in order. Only a successful CLI result and
// process exit complete a turn. A caller must not retry an ambiguous failure
// automatically: the CLI can persist the user's message before emitting its result.
func (r Runner) Run(ctx context.Context, turn Turn, onText func(string)) (Result, error) {
	if r.Command == nil {
		return Result{}, errors.New("Команда Claude Code для гостевой системы Cage не настроена")
	}
	if turn.Workspace == "" || !sessionIDPattern.MatchString(turn.SessionID) {
		return Result{}, errors.New("Недопустимый проект или идентификатор сеанса Claude Code")
	}
	if len(turn.Prompt) > maxPromptBytes || !utf8.ValidString(turn.Prompt) || strings.TrimSpace(turn.Prompt) == "" {
		return Result{}, errors.New("Сообщение пустое, имеет недопустимую кодировку или превышает 64 KiB")
	}
	if err := ctx.Err(); err != nil {
		return Result{}, err
	}
	// Keep the selected guest account's authentication and explicit user rules.
	// A checked-out project must not add an allow rule or a startup hook simply
	// because a paired phone starts a non-interactive turn in that directory.
	args := []string{"--print", "--output-format", "stream-json", "--verbose",
		"--include-partial-messages", "--safe-mode", "--setting-sources", "user",
		"--disable-slash-commands"}
	if r.Approve != nil {
		args = append(args, "--input-format", "stream-json", "--permission-mode", "manual",
			"--permission-prompts", "host", "--permission-prompt-tool", "stdio")
	} else {
		args = append(args, "--input-format", "text", "--permission-mode", "dontAsk")
	}
	if turn.Resume {
		args = append(args, "--resume", turn.SessionID)
	} else {
		args = append(args, "--session-id", turn.SessionID)
	}

	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	cmd, err := r.Command(runCtx, turn.Workspace, args)
	if err != nil {
		return Result{}, err
	}
	if cmd == nil {
		return Result{}, errors.New("Не удалось подготовить команду Claude Code для гостевой системы")
	}
	var input io.WriteCloser
	if r.SupervisedStdin || r.Approve != nil {
		input, err = cmd.StdinPipe()
		if err != nil {
			return Result{}, errors.New("Не удалось подготовить ввод Claude Code для гостевой системы")
		}
		defer input.Close()
	} else {
		cmd.Stdin = strings.NewReader(turn.Prompt)
	}
	reader, writer := io.Pipe()
	cmd.Stdout = writer
	// Raw stderr and system/tool events can contain account details, environment
	// paths and tool arguments. Only selected display fields enter the mobile protocol.
	cmd.Stderr = io.Discard
	cmd.WaitDelay = 2 * time.Second
	if err := cmd.Start(); err != nil {
		_ = reader.Close()
		_ = writer.Close()
		if err := ctx.Err(); err != nil {
			return Result{}, err
		}
		return Result{}, errors.New("Не удалось запустить соединение с Claude Code в гостевой системе")
	}
	if input != nil {
		stop := context.AfterFunc(runCtx, func() { _ = input.Close() })
		defer stop()
	}
	done := make(chan error, 1)
	go func() {
		err := cmd.Wait()
		_ = writer.Close()
		done <- err
	}()
	var approvals *approvalStream
	if r.Approve != nil {
		approvals = &approvalStream{ctx: runCtx, cancel: cancel, input: input, supervised: r.SupervisedStdin,
			turn: turn, approve: r.Approve, pending: make(map[string]context.CancelFunc), seen: make(map[string]bool)}
		startup := time.AfterFunc(time.Minute, approvals.expireInitialization)
		defer startup.Stop()
		err = approvals.begin()
	} else if input != nil {
		// Send concurrently with reading: either side can fill its OS pipe
		// during startup. The supervisor keeps this stream open until exit.
		sent := make(chan struct{})
		go func() {
			defer close(sent)
			if err := json.NewEncoder(input).Encode(turn.Prompt); err != nil {
				cancel()
			}
		}()
		defer func() { _ = input.Close(); <-sent }()
	}
	var result Result
	if err == nil {
		result, err = readResult(reader, turn.SessionID, onText, approvals, r.OnTools)
	}
	if err != nil {
		cancel()
	}
	_ = reader.Close()
	processErr := <-done
	// There may still be a pending phone decision when the child exits or
	// closes its output unexpectedly. Stop it before returning the turn.
	cancel()
	if approvals != nil {
		approvals.workers.Wait()
	}
	if err := ctx.Err(); err != nil {
		return result, err
	}
	if approvals != nil {
		if transportErr := approvals.failure(); transportErr != nil {
			return result, transportErr
		}
	}
	if err != nil {
		return result, err
	}
	if processErr != nil {
		return result, errors.New("Процесс Claude Code завершился аварийно; проверьте соединение с гостевой системой, версию CLI и состояние входа")
	}
	return result, nil
}

type cliEvent struct {
	Type            string  `json:"type"`
	Subtype         string  `json:"subtype"`
	SessionID       string  `json:"session_id"`
	ParentToolUseID *string `json:"parent_tool_use_id"`
}

type resultEvent struct {
	IsError           bool   `json:"is_error"`
	Result            string `json:"result"`
	PermissionDenials []struct {
		ToolName string `json:"tool_name"`
	} `json:"permission_denials"`
}

type streamEvent struct {
	Event struct {
		Type  string `json:"type"`
		Delta struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"delta"`
	} `json:"event"`
}

func readResult(reader io.Reader, sessionID string, onText func(string), approvals *approvalStream, onTools func([]ToolActivity)) (Result, error) {
	var result Result
	var finished bool
	var emitted int
	var tools []ToolActivity
	scan := bufio.NewScanner(reader)
	scan.Buffer(make([]byte, 32<<10), maxEventBytes)
	for scan.Scan() {
		line := bytes.TrimSpace(scan.Bytes())
		if len(line) == 0 {
			continue
		}
		var e cliEvent
		if err := json.Unmarshal(line, &e); err != nil || e.Type == "" {
			if approvals != nil && !approvals.ready {
				return result, errors.New("Claude Code в гостевой системе не вернул сообщение инициализации пошагового подтверждения; проверьте версию CLI")
			}
			return result, errors.New("Claude Code вернул сообщение недопустимого формата")
		}
		if e.Type == "control_request" || e.Type == "control_cancel_request" || e.Type == "control_response" {
			if approvals == nil {
				return result, errors.New("Claude Code требует интерактивного подтверждения, которое не настроено")
			}
			if e.SessionID != "" && !strings.EqualFold(e.SessionID, sessionID) {
				return result, errors.New("Сеанс подтверждения Claude Code не совпадает")
			}
			if err := approvals.control(e.Type, line); err != nil {
				return result, err
			}
			continue
		}
		if e.ParentToolUseID != nil {
			continue
		}
		if e.Type == "system" && e.Subtype == "cage_identity_changed" {
			return result, errors.New("Аккаунт, учётные данные или вышестоящий сервис, использованные сеансом, изменились; восстановите прежнюю конфигурацию или создайте новый сеанс")
		}
		if e.Type == "system" && e.Subtype == "cage_identity_single_turn" {
			result.SingleTurn = true
			continue
		}
		if e.Type == "system" && e.Subtype == "cage_identity_unverified" {
			return result, errors.New("Не удалось проверить вышестоящий сервис, который использовал этот сеанс; проверьте конфигурацию хоста или создайте новый сеанс")
		}
		if e.Type == "system" && e.Subtype == "cage_identity_unverified_start" {
			return result, errors.New("Не удалось проверить текущий аккаунт Claude или конфигурацию вышестоящего сервиса; проверьте аккаунт и настройки среды в Cage на компьютере")
		}
		if e.Type == "system" && e.Subtype == "init" {
			if !strings.EqualFold(e.SessionID, sessionID) || finished {
				return result, errors.New("Claude Code инициализировал другой сеанс")
			}
			result.Started = true
			continue
		}
		if (e.Type == "assistant" || e.Type == "user") && onTools != nil && !finished && strings.EqualFold(e.SessionID, sessionID) {
			var changed bool
			tools, changed = updateTools(tools, e.Type, line)
			if changed {
				onTools(slices.Clone(tools))
			}
		}
		if e.Type != "stream_event" && e.Type != "result" {
			continue
		}
		if !strings.EqualFold(e.SessionID, sessionID) || finished {
			return result, errors.New("Идентификатор сеанса Claude Code или порядок результатов не совпадает")
		}
		if e.Type == "stream_event" {
			var stream streamEvent
			if err := json.Unmarshal(line, &stream); err != nil {
				return result, errors.New("Недопустимое текстовое событие Claude Code")
			}
			if stream.Event.Type == "content_block_delta" && stream.Event.Delta.Type == "text_delta" {
				text := stream.Event.Delta.Text
				emitted += len(text)
				if emitted > maxTextBytes {
					return result, errors.New("Ответ Claude Code превышает 1 MiB")
				}
				if onText != nil && text != "" {
					onText(text)
				}
			}
			continue
		}
		finished = true
		if approvals != nil {
			if err := approvals.finish(); err != nil {
				return result, err
			}
		}
		var final resultEvent
		if err := json.Unmarshal(line, &final); err != nil {
			return result, errors.New("Claude Code вернул недопустимый итоговый результат")
		}
		for _, denial := range final.PermissionDenials {
			name := denial.ToolName
			if !toolNamePattern.MatchString(name) {
				name = "Неизвестный инструмент"
			}
			if !slices.Contains(result.DeniedTools, name) {
				result.DeniedTools = append(result.DeniedTools, name)
			}
			if len(result.DeniedTools) == 64 {
				break
			}
		}
		if final.IsError || e.Subtype != "success" {
			return result, errors.New("Claude Code не завершил текущий цикл; проверьте вход в гостевой системе, сеть и разрешения инструментов")
		}
		if !result.Started {
			return result, errors.New("Claude Code не подтвердил сеанс перед возвратом результата")
		}
		if len(final.Result) > maxTextBytes {
			return result, errors.New("Ответ Claude Code превышает 1 MiB")
		}
		result.Text = final.Result
	}
	if scan.Err() != nil {
		return result, errors.New("Поток сообщений Claude Code прерван или отдельное событие слишком велико")
	}
	if !finished {
		if approvals != nil && !approvals.ready {
			return result, errors.New("Claude Code в гостевой системе не подтвердил протокол пошагового подтверждения; проверьте версию CLI")
		}
		return result, errors.New("Claude Code не вернул результат текущего цикла; проверьте соединение с гостевой системой, версию CLI и состояние входа")
	}
	return result, nil
}
