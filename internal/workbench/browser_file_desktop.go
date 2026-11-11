package workbench

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"time"

	"github.com/sylvinus/agent-vm/internal/host"
)

type SavedDownload struct {
	InstanceID string    `json:"instance_id,omitempty"`
	ID         string    `json:"id"`
	Name       string    `json:"name"`
	Path       string    `json:"path"`
	SavedAt    time.Time `json:"saved_at"`
}

func savedDownloadPath(profile, id string) string {
	return filepath.Join(profile, "browser-downloads", id+".json")
}
func readSavedDownload(profile, id string) (SavedDownload, error) {
	var saved SavedDownload
	if !browserFileID.MatchString(id) {
		return saved, errors.New("Неверный идентификатор загрузки")
	}
	path := savedDownloadPath(profile, id)
	if err := host.CheckPrivateFile(path); err != nil {
		return saved, err
	}
	f, err := os.Open(path)
	if err != nil {
		return saved, err
	}
	defer f.Close()
	if err = json.NewDecoder(io.LimitReader(f, 16384)).Decode(&saved); err != nil {
		return saved, err
	}
	if saved.ID != id || !filepath.IsAbs(saved.Path) || !browserDownloadName(saved.Name) {
		return saved, errors.New("Неверная запись расположения загрузки")
	}
	return saved, nil
}
func rememberDownload(profile string, saved SavedDownload, firstOnly bool) error {
	if !browserFileID.MatchString(saved.ID) {
		return errors.New("Неверный идентификатор загрузки")
	}
	directory := filepath.Join(profile, "browser-downloads")
	if err := host.EnsurePrivateDir(directory); err != nil {
		return err
	}
	lock, err := os.OpenFile(filepath.Join(directory, ".lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	defer lock.Close()
	for attempts := 0; ; attempts++ {
		if err = lockController(lock); err == nil {
			break
		}
		if attempts >= 40 {
			return errors.New("Расположение загрузки обновляется; повторите попытку")
		}
		time.Sleep(25 * time.Millisecond)
	}
	defer unlockController(lock)
	if firstOnly {
		if _, err = readSavedDownload(profile, saved.ID); err == nil {
			return nil
		}
	}
	saved.SavedAt = time.Now().UTC()
	return writePrivate(savedDownloadPath(profile, saved.ID), saved)
}
func (s *Server) savedBrowserDownloads(w http.ResponseWriter, r *http.Request) {
	serveSavedDownloads(w, s.profile)
}

func serveSavedDownloads(w http.ResponseWriter, profile string) {
	entries, err := os.ReadDir(filepath.Join(profile, "browser-downloads"))
	if err != nil && !os.IsNotExist(err) {
		http.Error(w, "Не удалось прочитать сохранённое расположение", 500)
		return
	}
	records := []SavedDownload{}
	for _, entry := range entries {
		name := entry.Name()
		if len(name) != 41 {
			continue
		}
		if saved, err := readSavedDownload(profile, name[:36]); err == nil {
			records = append(records, saved)
		}
	}
	sort.Slice(records, func(i, j int) bool { return records[i].SavedAt.After(records[j].SavedAt) })
	if len(records) > 100 {
		records = records[:100]
	}
	jsonReply(w, records)
}

// BrowserFile is called by native dialogs, which supply the chosen path. HTTP
// clients can stream known downloads but cannot supply an arbitrary host path.
func BrowserFile(configPath, action, id, destination string) (SavedDownload, error) {
	return BrowserFileForConnection(configPath, "", action, id, destination)
}

func BrowserFileForConnection(configPath, connectionID, action, id, destination string) (SavedDownload, error) {
	var result SavedDownload
	if !browserFileID.MatchString(id) || (action != "save" && action != "open" && action != "reveal") {
		return result, errors.New("Неверная операция загрузки")
	}
	client, err := connectController(filepath.Dir(configPath))
	if err != nil {
		return result, err
	}
	defer client.close()
	client.client.Timeout = 30 * time.Minute
	entry, _ := url.Parse(client.launch.URL)
	status, err := client.call("POST", "/api/session", map[string]string{"token": entry.Fragment}, nil)
	if err != nil || status != 200 {
		return result, errors.New("Не удалось подключиться к сеансу загрузки")
	}
	connection, err := client.bindConnection(connectionID)
	if err != nil {
		return result, err
	}
	profile := filepath.Dir(configPath)
	if connection.DesktopGateway && connection.Mode == "local" {
		profile = filepath.Dir(profile)
	}
	saveProfile, err := clientDownloadProfile(profile, connection)
	if err != nil {
		return result, err
	}
	var item browserDownloadInfo
	if connection.Mode == "remote" && action != "save" {
		saved, readErr := readSavedDownload(saveProfile, id)
		if readErr != nil || saved.InstanceID != connection.InstanceID {
			return result, errors.New("Сначала сохраните файл на этот компьютер, затем откройте его или покажите расположение")
		}
		result = saved
	} else {
		status, err = client.call("GET", "/api/browser/files/downloads/"+id, nil, &item)
		if err != nil || status != 200 {
			return result, errors.New("Загруженный файл недоступен; убедитесь, что Cage разблокирован и загрузка завершена")
		}
		result = SavedDownload{ID: id, Name: item.Name, Path: item.Path}
		if connection.Mode == "remote" {
			result.Path = ""
			result.InstanceID = connection.InstanceID
		}
	}
	if action == "save" {
		if !filepath.IsAbs(destination) || filepath.Base(destination) == "." {
			return result, errors.New("Неверное расположение сохранения")
		}
		parent, resolveErr := filepath.EvalSymlinks(filepath.Dir(destination))
		if resolveErr != nil {
			return result, errors.New("Выбранная папка для сохранения больше недоступна")
		}
		destination = filepath.Join(parent, filepath.Base(destination))
		request, _ := http.NewRequest("GET", client.origin+"/api/browser/files/downloads/"+id+"/content", nil)
		request.Header.Set("Origin", client.origin)
		client.client.Timeout = 30 * time.Minute
		response, err := client.client.Do(request)
		if err != nil {
			return result, errors.New("Не удалось прочитать загруженный файл; повторите попытку")
		}
		defer response.Body.Close()
		if response.StatusCode != 200 {
			return result, errors.New("Исходный файл загрузки недоступен; загрузите его заново с исходной страницы")
		}
		if err = saveDownloadedStream(destination, response.Body, response.ContentLength); err != nil {
			return result, err
		}
		result.Path = destination
		result.Name = filepath.Base(destination)
		if err = rememberDownload(saveProfile, result, false); err != nil {
			return result, err
		}
	} else {
		file, err := openDownloadedFile(result.Path)
		if err != nil {
			return result, errors.New("Файл перемещён, удалён или недоступен")
		}
		file.Close()
		if err = openHostFile(result.Path, action); err != nil {
			return result, err
		}
	}
	return result, nil
}

func saveDownloadedStream(destination string, source io.Reader, size int64) error {
	if existing, err := os.Lstat(destination); err == nil && !existing.Mode().IsRegular() {
		return errors.New("Выберите обычное расположение для сохранения файла")
	}
	temporary, err := os.CreateTemp(filepath.Dir(destination), ".cage-download-*.part")
	if err != nil {
		return errors.New("Не удалось записать в выбранную папку")
	}
	defer os.Remove(temporary.Name())
	count, err := io.Copy(temporary, source)
	if err == nil && size >= 0 && count != size {
		err = io.ErrUnexpectedEOF
	}
	if err == nil {
		err = temporary.Sync()
	}
	closeErr := temporary.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return errors.New("Сохранение не завершено, исходный файл не перезаписан; проверьте место или подключение и повторите")
	}
	if err = os.Rename(temporary.Name(), destination); err != nil {
		return errors.New("Не удалось сохранить в выбранное расположение, исходный файл не перезаписан")
	}
	return nil
}
