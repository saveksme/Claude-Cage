package workbench

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"

	"github.com/sylvinus/agent-vm/internal/paths"
)

const mobileMediaLimit = 48 << 20
const mobileMediaChunk = 512 << 10

type mediaChunkRequest struct {
	Reference string `json:"reference"`
	Offset    int64  `json:"offset"`
	Version   string `json:"version"`
}

func mediaFileName(workspace, cwd, reference string) (string, error) {
	value, err := url.PathUnescape(reference)
	if err != nil || len(value) > 4096 || value == "" || strings.ContainsRune(value, 0) || strings.HasPrefix(value, "//") {
		return "", fs.ErrInvalid
	}
	root := guestPath(workspace)
	if filepath.IsAbs(value) {
		value = guestPath(value)
	}
	if cwd == "" {
		cwd = root
	}
	if !path.IsAbs(value) {
		value = path.Join(cwd, value)
	}
	name, ok := paths.CutPrefix(path.Clean(value), strings.TrimSuffix(root, "/")+"/")
	if !ok || !fs.ValidPath(name) || strings.ContainsAny(name, ":\\") {
		return "", fs.ErrPermission
	}
	return filepath.Localize(name)
}

// Require both the filename and the file signature to identify a passive media
// format. No HTML, SVG, arbitrary file downloads or URL fetches use this route.
func mediaFormat(name string, head []byte) string {
	kind := http.DetectContentType(head)
	ext := strings.ToLower(filepath.Ext(name))
	expected := map[string]string{
		".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
		".gif": "image/gif", ".webp": "image/webp", ".webm": "video/webm",
		".mp4": "video/mp4", ".m4v": "video/mp4",
	}
	if kind == expected[ext] {
		return kind
	}
	if ext == ".mov" && len(head) >= 12 && bytes.Equal(head[4:12], []byte("ftypqt  ")) {
		return "video/quicktime"
	}
	return ""
}

func (s *Server) mobileSessionMedia(w http.ResponseWriter, r *http.Request) {
	var in mediaChunkRequest
	if !readJSON(w, r, &in) {
		return
	}
	view, _, ok := s.authorizedMobileSessionRecord(w, r)
	if !ok {
		return
	}
	if view.Archived || isClientMountPath(view.Workspace) {
		http.Error(w, "В этом проекте сейчас нельзя просмотреть файлы.", 409)
		return
	}
	if in.Reference == "" || len(in.Reference) > 8192 || in.Offset < 0 || in.Offset >= mobileMediaLimit || (in.Offset != 0 && in.Version == "") {
		http.Error(w, "Неверный запрос предпросмотра.", 400)
		return
	}
	// Use the transcript snapshot already sent to this device. Asset chunks
	// must not trigger a new guest SSH scan of the entire conversation.
	found := false
	for _, turn := range view.Turns {
		if strings.Contains(turn.Text, in.Reference) || strings.Contains(turn.Prompt, in.Reference) {
			found = true
			break
		}
	}
	if !found {
		http.Error(w, "Этот файл не появлялся в сеансе.", 403)
		return
	}
	var name string
	var err error
	if s.windowsGuest != nil {
		project, lookup := s.windowsProjectForHost(view.Workspace)
		if lookup != nil {
			http.Error(w, "Подключение проекта Windows отозвано; переподключите проект.", http.StatusConflict)
			return
		}
		name, err = windowsMediaFileName(project.Path, view.mediaWorkingDir, in.Reference)
	} else {
		name, err = mediaFileName(s.cliWorkspace(view.Workspace), view.mediaWorkingDir, in.Reference)
	}
	if err != nil {
		http.Error(w, "Можно просматривать только медиафайлы текущего проекта.", 403)
		return
	}
	canonical, err := paths.Real(view.Workspace)
	if err != nil || !paths.Equal(canonical, paths.Host(view.Workspace)) {
		http.Error(w, "Каталог проекта изменился; снова откройте проект.", 409)
		return
	}
	root, err := os.OpenRoot(canonical)
	if err != nil {
		http.Error(w, "Каталог проекта временно недоступен.", 404)
		return
	}
	defer root.Close()
	info, err := root.Stat(name)
	if err != nil || !info.Mode().IsRegular() {
		http.Error(w, "Файл перемещён или недоступен для чтения.", 404)
		return
	}
	file, err := root.Open(name)
	if err != nil {
		http.Error(w, "Файл перемещён или недоступен для чтения.", 404)
		return
	}
	defer file.Close()
	info, err = file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() <= 0 || info.Size() > mobileMediaLimit {
		http.Error(w, "Телефон поддерживает предпросмотр непустых медиафайлов размером до 48 MiB.", 413)
		return
	}
	version := fmt.Sprintf("%x-%x", info.Size(), info.ModTime().UnixNano())
	if in.Offset >= info.Size() || (in.Version != "" && in.Version != version) {
		http.Error(w, "Файл изменился; загрузите предпросмотр заново.", 409)
		return
	}
	var head [512]byte
	n, err := file.ReadAt(head[:], 0)
	if err != nil && !errors.Is(err, io.EOF) {
		http.Error(w, "Не удалось прочитать файл.", 409)
		return
	}
	kind := mediaFormat(name, head[:n])
	if kind == "" {
		http.Error(w, "Этот формат файла нельзя просмотреть на телефоне.", 415)
		return
	}
	chunk := make([]byte, min(int64(mobileMediaChunk), info.Size()-in.Offset))
	if _, err := file.ReadAt(chunk, in.Offset); err != nil {
		http.Error(w, "Файл изменился; загрузите предпросмотр заново.", 409)
		return
	}
	end, err := file.Stat()
	if err != nil || end.Size() != info.Size() || !end.ModTime().Equal(info.ModTime()) {
		http.Error(w, "Файл изменился; загрузите предпросмотр заново.", 409)
		return
	}
	jsonReply(w, map[string]any{"mime": kind, "size": info.Size(), "version": version, "data": chunk})
}
