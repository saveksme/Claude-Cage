package workbench

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/sylvinus/agent-vm/internal/usererror"
)

const browserFileLimit int64 = 2 << 30

var browserFileID = regexp.MustCompile(`^[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$`)

func browserFileName(name string) bool {
	return len(name) <= 255 && browserDownloadName(name)
}
func browserDownloadName(name string) bool {
	return name != "" && len(name) <= 1024 && name != "." && name != ".." && !strings.ContainsAny(name, "/\\\x00\r\n")
}

func (s *Server) browserUpload(w http.ResponseWriter, r *http.Request) {
	id, name := r.PathValue("id"), r.URL.Query().Get("name")
	if !browserFileID.MatchString(id) || !browserFileName(name) {
		http.Error(w, "Неверное имя файла или окно загрузки", 400)
		return
	}
	if r.ContentLength > browserFileLimit {
		http.Error(w, "Каждый файл не должен превышать 2 ГБ", 413)
		return
	}
	s.mu.Lock()
	ready, token := s.ready, s.credentials.Token
	s.mu.Unlock()
	if !ready {
		http.Error(w, "Среда ещё не готова", 409)
		return
	}
	// Never accept a file without a live chooser owned by the remote browser.
	snapshot, err := s.guestAPI(r.Context(), token, "GET", "/tabs", nil)
	var state struct {
		Uploads []struct {
			ID string `json:"id"`
		} `json:"uploads"`
	}
	if err != nil || json.Unmarshal(snapshot, &state) != nil {
		http.Error(w, "Не удалось подключиться к окну загрузки", 502)
		return
	}
	found := false
	for _, upload := range state.Uploads {
		if upload.ID == id {
			found = true
		}
	}
	if !found {
		http.Error(w, "Окно загрузки закрыто; снова нажмите кнопку загрузки на веб-странице", 409)
		return
	}
	query := url.Values{"id": {id}, "name": {name}}
	r.Body = http.MaxBytesReader(w, r.Body, browserFileLimit)
	s.proxyBrowserFile(w, r, token, "POST", "/upload-file?"+query.Encode(), r.Body)
}

func (s *Server) proxyBrowserFile(w http.ResponseWriter, r *http.Request, token, method, path string, body io.Reader) {
	if s.macosGuest != nil || s.windowsGuest != nil {
		s.nativeBrowserFile(w, r, method, path, body)
		return
	}
	response, err := s.browserClient().file(r.Context(), token, method, path, body, r.ContentLength)
	if err != nil {
		http.Error(w, usererror.Wrap("действие «передача файла из браузера»", err, "Восстановите подключение к среде, проверьте, получен ли файл, и снова выберите файл.").Error(), 502)
		return
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		http.Error(w, serviceHTTPFailure("передача файла из браузера", response.StatusCode).Error(), 502)
		return
	}
	if method == "POST" {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.Copy(w, io.LimitReader(response.Body, 4096))
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	if length := response.Header.Get("Content-Length"); length != "" {
		w.Header().Set("Content-Length", length)
	}
	_, _ = io.Copy(w, response.Body)
}

type browserDownloadInfo struct {
	Target    string `json:"target,omitempty"`
	ID        string `json:"id"`
	Name      string `json:"name"`
	State     string `json:"state"`
	Path      string `json:"path,omitempty"`
	Retryable bool   `json:"retryable,omitempty"`
	Error     string `json:"error,omitempty"`
}

func (s *Server) downloadInfo(ctx context.Context, id string) (browserDownloadInfo, error) {
	if !browserFileID.MatchString(id) {
		return browserDownloadInfo{}, errors.New("Неверный идентификатор загрузки")
	}
	if saved, err := readSavedDownload(s.profile, id); err == nil {
		return browserDownloadInfo{ID: id, Name: saved.Name, Path: saved.Path, State: "saved"}, nil
	}
	s.mu.Lock()
	ready, token := s.ready, s.credentials.Token
	s.mu.Unlock()
	if !ready {
		return browserDownloadInfo{}, errors.New("Сначала запустите среду или откройте файл из сохранённого расположения")
	}
	item, err := s.guestDownloadInfo(ctx, token, id)
	if err != nil {
		return browserDownloadInfo{}, err
	}
	if s.macosGuest != nil || s.windowsGuest != nil {
		if item.State != "saved" && !(item.State == "failed" && item.Retryable) {
			item.Path = ""
			return item, nil
		}
		transfer, err := s.startNativeDownload(item)
		if err != nil {
			return browserDownloadInfo{}, err
		}
		select {
		case <-ctx.Done():
			return browserDownloadInfo{}, ctx.Err()
		case <-transfer.done:
		}
		if transfer.err != nil {
			return browserDownloadInfo{}, transfer.err
		}
		saved, err := readSavedDownload(s.profile, id)
		return browserDownloadInfo{ID: id, Target: item.Target, Name: saved.Name, Path: saved.Path, State: "saved"}, err
	}
	if item.State == "saved" {
		root := s.environmentDir()
		expected := strings.TrimRight(guestPath(root), "/") + "/Downloads/" + item.Name
		if item.Path != expected {
			return browserDownloadInfo{}, errors.New("Неверное расположение сохранения загрузки")
		}
		item.Path = filepath.Join(root, "Downloads", item.Name)
		if err = rememberDownload(s.profile, SavedDownload{ID: id, Name: item.Name, Path: item.Path}, true); err != nil {
			return browserDownloadInfo{}, err
		}
	} else {
		item.Path = ""
	}
	return item, nil
}

// The native bridge carries only a download ID. Resolve it from the producing
// service even after a controller restart or before the first UI poll.
func (s *Server) guestDownloadInfo(ctx context.Context, token, id string) (browserDownloadInfo, error) {
	var failures []error
	for _, target := range []string{"browser", "desktop"} {
		var data []byte
		var err error
		if target == "browser" {
			data, err = s.guestAPI(ctx, token, "GET", "/tabs", nil)
		} else {
			var result map[string]any
			result, err = s.guestFiles(ctx, "desktop", "GET", "/requests", nil, "")
			if err == nil {
				data, err = json.Marshal(result)
			}
		}
		if err != nil {
			failures = append(failures, err)
			continue
		}
		var state struct {
			Downloads []browserDownloadInfo `json:"downloads"`
		}
		if json.Unmarshal(data, &state) != nil {
			failures = append(failures, errors.New("Неверный список загрузок"))
			continue
		}
		for _, item := range state.Downloads {
			if item.ID == id {
				if !browserDownloadName(item.Name) {
					return browserDownloadInfo{}, errors.New("Неверная запись загруженного файла")
				}
				item.Target = target
				return item, nil
			}
		}
	}
	if len(failures) != 0 {
		return browserDownloadInfo{}, errors.Join(failures...)
	}
	return browserDownloadInfo{}, errors.New("Запись загрузки больше не существует; загрузите файл заново из исходного приложения")
}

// The native guest owns the source file. Only a completed, recorded host copy
// may appear as saved in the common workbench or be opened by a native shell.
type nativeDownload struct {
	item browserDownloadInfo
	done chan struct{}
	err  error
}

func (s *Server) startNativeDownload(item browserDownloadInfo) (*nativeDownload, error) {
	if !browserFileID.MatchString(item.ID) || !browserDownloadName(item.Name) {
		return nil, errors.New("Неверная запись загруженного файла")
	}
	s.mu.Lock()
	current := s.nativeDownloads[item.ID]
	s.mu.Unlock()
	if current != nil {
		return current, nil
	}
	s.op.Lock()
	defer s.op.Unlock()
	s.mu.Lock()
	ready := s.ready && !s.closing
	s.mu.Unlock()
	if !ready {
		return nil, errBrowserNotReady
	}
	var client *windowsBrowserClient
	if item.Target != "desktop" {
		client = s.nativeBrowserClient()
	}
	epoch, unlocked := s.account.access()
	if !unlocked {
		return nil, errors.New("Cage заблокирован; разблокируйте его, чтобы сохранить загрузку")
	}
	ctx, finish, err := s.beginActivity(epoch)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	if current = s.nativeDownloads[item.ID]; current != nil {
		s.mu.Unlock()
		finish()
		return current, nil
	}
	if s.nativeDownloads == nil {
		s.nativeDownloads = make(map[string]*nativeDownload)
		s.nativeDownloadSlots = make(chan struct{}, 2)
	}
	current = &nativeDownload{item: item, done: make(chan struct{})}
	s.nativeDownloads[item.ID] = current
	s.nativeDownloadRevision++
	slots := s.nativeDownloadSlots
	s.mu.Unlock()
	go func() {
		defer finish()
		defer func() {
			close(current.done)
			s.mu.Lock()
			s.nativeDownloadRevision++
			if current.err == nil && s.nativeDownloads[item.ID] == current {
				delete(s.nativeDownloads, item.ID)
			}
			s.mu.Unlock()
		}()
		ctx, cancel := context.WithTimeout(ctx, 30*time.Minute)
		defer cancel()
		select {
		case <-ctx.Done():
			current.err = ctx.Err()
			return
		case slots <- struct{}{}:
		}
		defer func() { <-slots }()
		current.err = s.saveNativeDownload(ctx, item, client)
	}()
	return current, nil
}

func (s *Server) retryNativeDownload(id string) (bool, error) {
	s.mu.Lock()
	transfer := s.nativeDownloads[id]
	if transfer == nil {
		s.mu.Unlock()
		return false, nil
	}
	select {
	case <-transfer.done:
		delete(s.nativeDownloads, id)
	default:
		s.mu.Unlock()
		return true, nil
	}
	s.mu.Unlock()
	_, err := s.startNativeDownload(transfer.item)
	return true, err
}

func (s *Server) discardMissingNativeDownloads(target string, visible map[string]bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for id, transfer := range s.nativeDownloads {
		if (transfer.item.Target == "desktop") != (target == "desktop") || visible[id] {
			continue
		}
		select {
		case <-transfer.done:
			delete(s.nativeDownloads, id)
		default:
		}
	}
}

func (s *Server) nativeDownloadForHost(item browserDownloadInfo) browserDownloadInfo {
	item.Path = ""
	if saved, err := readSavedDownload(s.profile, item.ID); err == nil {
		item.Name, item.Path, item.State, item.Retryable = saved.Name, saved.Path, "saved", false
		item.Error = ""
		return item
	}
	if item.State != "saved" && !(item.State == "failed" && item.Retryable) {
		return item
	}
	transfer, err := s.startNativeDownload(item)
	if err == nil {
		select {
		case <-transfer.done:
			err = transfer.err
			if err == nil {
				saved, readErr := readSavedDownload(s.profile, item.ID)
				if readErr == nil {
					item.Name, item.Path, item.State, item.Retryable = saved.Name, saved.Path, "saved", false
					item.Error = ""
					return item
				}
				err = readErr
			}
		default:
			item.State, item.Retryable = "saving", false
			item.Error = ""
			return item
		}
	}
	item.State, item.Retryable = "failed", true
	item.Error = usererror.Display("сохранение загрузки на этот компьютер", err, "Восстановите подключение к среде или проверьте место в рабочем пространстве по умолчанию и нажмите «Повторить».").Error()
	return item
}

func (s *Server) saveNativeDownload(ctx context.Context, item browserDownloadInfo, client *windowsBrowserClient) error {
	if _, err := readSavedDownload(s.profile, item.ID); err == nil {
		return nil
	}
	var source io.ReadCloser
	var size int64
	var name string
	var err error
	if item.Target == "desktop" {
		source, size, name, err = s.openNativeDesktopDownload(ctx, item.ID)
	} else {
		source, size, name, err = client.download(ctx, item.ID)
	}
	if err != nil {
		return err
	}
	defer source.Close()
	if name != item.Name {
		return errors.New("Запись загруженного файла изменилась; обновите список загрузок")
	}
	workspace, err := validateWorkspace(s.environmentDir(), s.profile)
	if err != nil {
		return err
	}
	root, err := os.OpenRoot(workspace)
	if err != nil {
		return err
	}
	defer root.Close()
	if err := root.Mkdir("Downloads", 0700); err != nil && !os.IsExist(err) {
		return err
	}
	directory, err := root.Lstat("Downloads")
	if err != nil || !directory.IsDir() {
		return errors.New("Неверный каталог загрузок по умолчанию; выберите обычную папку в рабочем пространстве по умолчанию")
	}
	downloads, err := root.OpenRoot("Downloads")
	if err != nil {
		return err
	}
	defer downloads.Close()
	temporary := ".cage-download-" + uuid.NewString() + ".part"
	file, err := downloads.OpenFile(temporary, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	defer downloads.Remove(temporary)
	count, err := io.Copy(file, source)
	if err == nil && count != size {
		err = io.ErrUnexpectedEOF
	}
	if err == nil {
		err = ctx.Err()
	}
	if err == nil {
		err = file.Sync()
	}
	written, statErr := file.Stat()
	err = errors.Join(err, statErr)
	err = errors.Join(err, file.Close())
	if err != nil {
		return err
	}
	for attempt := 0; attempt < 1000; attempt++ {
		candidate := name
		if attempt != 0 {
			extension := filepath.Ext(name)
			candidate = fmt.Sprintf("%s (%d)%s", strings.TrimSuffix(name, extension), attempt, extension)
		}
		// Match the Linux save-download helper's exclusive publication. A
		// simultaneous download or an existing filename wins without replacement.
		if err = downloads.Link(temporary, candidate); os.IsExist(err) {
			continue
		}
		if err != nil {
			return err
		}
		saved := SavedDownload{ID: item.ID, Name: candidate, Path: filepath.Join(workspace, "Downloads", candidate)}
		removePublished := func() {
			if current, err := downloads.Lstat(candidate); err == nil && os.SameFile(written, current) {
				_ = downloads.Remove(candidate)
			}
		}
		published, openErr := openDownloadedFile(saved.Path)
		if openErr != nil {
			removePublished()
			return openErr
		}
		current, statErr := published.Stat()
		published.Close()
		if statErr != nil || !os.SameFile(written, current) {
			removePublished()
			return errors.New("Расположение сохранения загрузки изменилось; сохраните заново")
		}
		if err = rememberDownload(s.profile, saved, true); err != nil {
			removePublished()
			return err
		}
		return nil
	}
	return errors.New("В каталоге загрузок по умолчанию слишком много файлов с одинаковым именем; наведите порядок и повторите")
}

func (s *Server) browserDownload(w http.ResponseWriter, r *http.Request) {
	if action := r.PathValue("action"); action != "" && action != "content" {
		http.NotFound(w, r)
		return
	}
	item, err := s.downloadInfo(r.Context(), r.PathValue("id"))
	if err != nil {
		http.Error(w, err.Error(), 409)
		return
	}
	if r.PathValue("action") != "content" {
		jsonReply(w, item)
		return
	}
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": item.Name}))
	if item.Path != "" {
		file, err := openDownloadedFile(item.Path)
		if err != nil {
			http.Error(w, "Файл перемещён, удалён или временно недоступен для чтения", 404)
			return
		}
		defer file.Close()
		info, _ := file.Stat()
		http.ServeContent(w, r, item.Name, info.ModTime(), cancelableDownload{ReadSeeker: file, ctx: r.Context()})
		return
	}
	if item.State != "failed" || !item.Retryable {
		http.Error(w, "Файл ещё не загружен полностью или больше недоступен", 409)
		return
	}
	s.mu.Lock()
	token := s.credentials.Token
	s.mu.Unlock()
	s.proxyBrowserFile(w, r, token, "GET", "/download-file?id="+url.QueryEscape(item.ID), nil)
}

type cancelableDownload struct {
	io.ReadSeeker
	ctx context.Context
}

func (reader cancelableDownload) Read(buffer []byte) (int, error) {
	if err := reader.ctx.Err(); err != nil {
		return 0, err
	}
	return reader.ReadSeeker.Read(buffer)
}

// A file replaced by a symlink must not turn a download action into an arbitrary
// host read. The selected file is checked again after opening it.
func openDownloadedFile(path string) (*os.File, error) {
	before, err := os.Lstat(path)
	if err != nil || !before.Mode().IsRegular() {
		return nil, errors.New("Загруженный файл недоступен")
	}
	parent, err := filepath.EvalSymlinks(filepath.Dir(path))
	if err != nil {
		return nil, err
	}
	if filepath.Clean(parent) != filepath.Clean(filepath.Dir(path)) {
		return nil, errors.New("Каталог загрузок был заменён")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	after, err := file.Stat()
	if err != nil || !os.SameFile(before, after) {
		file.Close()
		return nil, errors.New("Загруженный файл изменился")
	}
	return file, nil
}
