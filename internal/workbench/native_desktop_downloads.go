package workbench

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
)

func nativeDesktopDownloadInput(method, path string, input any) (map[string]any, error) {
	if method != "POST" || (path != "/file-open" && path != "/file-read" && path != "/file-close") {
		return nil, errors.New("Неверная операция загрузки в гостевой системе")
	}
	data, err := json.Marshal(input)
	if err != nil {
		return nil, err
	}
	var request map[string]any
	if err = json.Unmarshal(data, &request); err != nil {
		return nil, err
	}
	request["action"] = "files-download-" + strings.TrimPrefix(path, "/file-")
	return request, nil
}

func (s *Server) nativeDesktopDownloadRequest(ctx context.Context, method, path string, input any) ([]byte, error) {
	request, err := nativeDesktopDownloadInput(method, path, input)
	if err != nil {
		return nil, err
	}
	if s.windowsGuest != nil {
		var reply map[string]any
		if err = s.windowsDesktopRequest(ctx, request["action"].(string), request, &reply); err != nil {
			return nil, windowsDesktopFileFailure(err)
		}
		return json.Marshal(reply)
	}
	data, err := json.Marshal(request)
	if err != nil {
		return nil, err
	}
	var mac macOSWindowRequest
	if err = json.Unmarshal(data, &mac); err != nil {
		return nil, err
	}
	reply, err := s.macOSDesktopFileCall(ctx, mac)
	if err != nil {
		return nil, err
	}
	return json.Marshal(reply)
}

type nativeDesktopDownload struct {
	io.ReadCloser
	connection *nativeWindowConnection
}

func (d *nativeDesktopDownload) Close() error {
	err := d.ReadCloser.Close()
	d.connection.Close()
	return err
}

// One download owns one ordered window channel. Chunk reads reuse its process
// and SSH or Hyper-V transport, while the producer retains the file identity.
func (s *Server) openNativeDesktopDownload(ctx context.Context, id string) (io.ReadCloser, int64, string, error) {
	var connection *nativeWindowConnection
	var err error
	if s.windowsGuest != nil {
		connection, err = s.windowsWindowConnection(ctx)
	} else {
		transport, cancel := context.WithCancel(ctx)
		cmd := s.sshCommand(transport, "-T", s.sshTarget(), "--", macOSWindowSocketCommand)
		connection, err = startWindowConnection(cmd, cancel)
	}
	if err != nil {
		return nil, 0, "", err
	}
	request := func(call context.Context, method, path string, input any) ([]byte, error) {
		if path == "/file-close" && ctx.Err() != nil {
			return s.nativeDesktopDownloadRequest(call, method, path, input)
		}
		if err := call.Err(); err != nil {
			return nil, err
		}
		payload, err := nativeDesktopDownloadInput(method, path, input)
		if err != nil {
			return nil, err
		}
		payload["keepAlive"] = true
		stop := context.AfterFunc(call, connection.Close)
		defer stop()
		var reply json.RawMessage
		if err = connection.request(payload, &reply); err != nil {
			var failure windowsWindowFailure
			if s.macosGuest != nil && errors.As(err, &failure) {
				return nil, macOSFileFailure(failure.code)
			}
			return nil, windowsDesktopFileFailure(err)
		}
		return reply, nil
	}
	reader, size, name, err := openNativeFileDownload(ctx, id, request)
	if err != nil {
		connection.Close()
		return nil, 0, "", err
	}
	return &nativeDesktopDownload{ReadCloser: reader, connection: connection}, size, name, nil
}

func desktopDownloadFailure(reason string) error {
	switch reason {
	case "desktop_download_incomplete":
		return errors.New("Claude Desktop ещё не сохранил файл полностью; вернитесь в приложение и загрузите заново")
	case "desktop_download_changed":
		return errors.New("Загружаемый файл Claude Desktop изменился во время передачи; загрузите заново")
	case "desktop_download_unavailable", "desktop_download_transfer_invalid":
		return errors.New("Загружаемый файл Claude Desktop больше недоступен; убедитесь, что гостевая система разблокирована, и загрузите заново")
	case "desktop_download_limit":
		return errors.New("Слишком много файлов Claude Desktop ожидают сохранения; завершите текущие загрузки и повторите")
	case "file_open_target_changed":
		return errors.New("Файл или окно Claude изменились; вернитесь в исходное окно и откройте файл заново")
	case "file_open_request_invalid", "file_open_request_unavailable":
		return errors.New("Запрос открытия файла устарел; убедитесь, что гостевая система разблокирована, и повторите")
	case "file_open_request_limit":
		return errors.New("Слишком много запросов открытия файлов в обработке; повторите позже")
	default:
		return nil
	}
}

func windowsDesktopFileFailure(err error) error {
	var failure windowsWindowFailure
	if errors.As(err, &failure) {
		if display := desktopDownloadFailure(failure.code); display != nil {
			return display
		}
	}
	return err
}
