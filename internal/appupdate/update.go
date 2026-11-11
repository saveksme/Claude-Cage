// Package appupdate downloads Cage releases through the selected managed egress.
// Signature verification and application replacement belong to the native app.
package appupdate

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"

	"github.com/sylvinus/agent-vm/internal/cage"
	"github.com/sylvinus/agent-vm/internal/diagnostics"
	"github.com/sylvinus/agent-vm/internal/host"
	"github.com/sylvinus/agent-vm/internal/managedproxy"
	"github.com/sylvinus/agent-vm/internal/usererror"
	"github.com/sylvinus/agent-vm/internal/version"
	"golang.org/x/mod/semver"
)

const repository = "Lee-xeo/Claude-Cage"
const releasesURL = "https://api.github.com/repos/" + repository + "/releases?per_page=100"
const maxArchive = 512 << 20
const maxMetadata = 4 << 20

type asset struct {
	Name   string `json:"name"`
	URL    string `json:"browser_download_url"`
	Size   int64  `json:"size"`
	Digest string `json:"digest"`
	State  string `json:"state"`
}
type release struct {
	Tag        string  `json:"tag_name"`
	Draft      bool    `json:"draft"`
	Prerelease bool    `json:"prerelease"`
	Assets     []asset `json:"assets"`
}
type candidate struct {
	Version   string `json:"version"`
	Archive   asset  `json:"archive"`
	Checksums asset  `json:"checksums"`
}

// State is one line of the native launcher's private update process protocol.
// ArchivePath is returned only to the native launcher, never as a download URL.
type State struct {
	Phase          string `json:"phase"`
	CurrentVersion string `json:"currentVersion"`
	LatestVersion  string `json:"latestVersion,omitempty"`
	ReceivedBytes  int64  `json:"receivedBytes,omitempty"`
	TotalBytes     int64  `json:"totalBytes,omitempty"`
	Message        string `json:"message,omitempty"`
	Retryable      bool   `json:"retryable,omitempty"`
	RetryAt        string `json:"retryAt"`
	ArchivePath    string `json:"archivePath,omitempty"`
	SHA256         string `json:"sha256,omitempty"`
}

type proxyUnavailableError struct{ message string }

func (e *proxyUnavailableError) Error() string { return e.message }

// Run only accepts fixed operations. URLs and destinations come from the
// verified repository response and the current private profile.
func Run(configPath string, args []string, output io.Writer) int {
	enc := json.NewEncoder(output)
	state := State{CurrentVersion: version.Version}
	emit := func() { _ = enc.Encode(state) }
	fail := func(err error) int {
		var unavailable *proxyUnavailableError
		if len(args) == 1 && args[0] == "check" && errors.As(err, &unavailable) {
			state.Phase, state.Message, state.Retryable = "waiting", err.Error(), true
			emit()
			return 0
		}
		_ = diagnostics.New(filepath.Dir(configPath)).Record("warn", "app-update", fmt.Sprintf("%v; cause=%v", err, errors.Unwrap(err)))
		state.fail(err)
		emit()
		return 1
	}
	if len(args) != 1 || (args[0] != "check" && args[0] != "download") {
		return fail(errors.New("Недопустимая операция обновления"))
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	client, err := managedClient(ctx, configPath)
	if err != nil {
		return fail(err)
	}
	defer client.CloseIdleConnections()
	state.Phase, state.Message = "checking", "Проверка обновлений"
	emit()
	c, err := findRelease(ctx, client, version.Version)
	if err != nil {
		return fail(err)
	}
	if c == nil {
		state.Phase, state.Message = "current", "Уже установлена последняя версия в текущем канале обновлений"
		emit()
		return 0
	}
	state.LatestVersion = c.Version
	if args[0] == "check" {
		state.Phase, state.Message = "available", "Доступна новая версия, можно скачать обновление"
		emit()
		return 0
	}
	digest, err := releaseDigest(ctx, client, *c)
	if err != nil {
		return fail(err)
	}
	directory := filepath.Join(filepath.Dir(configPath), "updates")
	if err = host.EnsurePrivateDir(directory); err != nil {
		return fail(errors.New("Не удалось создать закрытый каталог обновлений"))
	}
	if st, e := os.Lstat(directory); e != nil || !st.IsDir() || st.Mode()&os.ModeSymlink != 0 {
		return fail(errors.New("Каталог обновлений должен быть закрытым обычным каталогом"))
	}

	job, err := os.MkdirTemp(directory, "download-")
	if err != nil {
		return fail(errors.New("Не удалось создать задачу загрузки обновления"))
	}
	keep := false
	defer func() {
		if !keep {
			_ = os.RemoveAll(job)
		}
	}()
	if err = host.EnsurePrivateDir(job); err != nil {
		return fail(err)
	}
	localName := "Cage.dmg"
	if runtime.GOOS == "windows" {
		localName = "Cage-setup.exe"
	}
	archive := filepath.Join(job, localName)
	state.Phase, state.Message, state.TotalBytes = "downloading", "Загрузка обновления", c.Archive.Size
	emit()
	err = download(ctx, client, c.Archive, digest, archive, func(n int64) {
		state.ReceivedBytes = n
		emit()
	})
	if err != nil {
		return fail(err)
	}
	keep = true
	state.Phase, state.Message, state.ArchivePath, state.SHA256 = "downloaded", "Контрольная сумма загрузки проверена, выполняется проверка приложения", archive, digest
	emit()
	return 0
}

func managedClient(ctx context.Context, configPath string) (*http.Client, error) {
	cfg, err := cage.Load(configPath)
	if err != nil {
		return nil, errors.New("Сначала настройте и запустите выбранный прокси Cage, затем проверьте обновления")
	}
	profile := filepath.Dir(configPath)
	p, err := managedproxy.Applied(profile, cfg.ProxyURL, cfg.ProxyRevision)
	if err != nil {
		return nil, &proxyUnavailableError{"Выбранный прокси ещё не применён; проверка обновлений повторится, когда прокси будет готов"}
	}
	if !managedproxy.Running(ctx, profile, p) {
		return nil, &proxyUnavailableError{"Выбранный прокси не запущен; проверка обновлений повторится, когда прокси будет готов. Обновление не переключится на прямое подключение через хост"}
	}
	egress, err := cage.NewEgress(cfg)
	if err != nil {
		return nil, errors.New("Недопустимая конфигурация прокси обновлений")
	}
	return &http.Client{
		Transport: &http.Transport{Proxy: nil, DialContext: egress.DialContext, ForceAttemptHTTP2: true, TLSHandshakeTimeout: 15 * time.Second, ResponseHeaderTimeout: 30 * time.Second, IdleConnTimeout: 10 * time.Second},
		Timeout:   20 * time.Minute,
		CheckRedirect: func(r *http.Request, via []*http.Request) error {
			if len(via) >= 5 || !allowedURL(r.URL, true) {
				return errors.New("Перенаправление загрузки обновления отклонено")
			}
			return nil
		},
	}, nil
}

func allowedURL(u *url.URL, redirect bool) bool {
	if u == nil || u.Scheme != "https" || u.User != nil || u.Fragment != "" || (u.Port() != "" && u.Port() != "443") {
		return false
	}
	switch u.Hostname() {
	case "api.github.com":
		return u.Path == "/repos/"+repository+"/releases"
	case "github.com":
		return strings.HasPrefix(u.Path, "/"+repository+"/releases/download/") && !strings.Contains(u.Path, "/../")
	case "release-assets.githubusercontent.com", "objects.githubusercontent.com":
		return redirect
	}
	return false
}

func request(ctx context.Context, client *http.Client, raw string) (*http.Response, error) {
	u, err := url.Parse(raw)
	if err != nil || !allowedURL(u, false) {
		return nil, errors.New("Адрес обновления не относится к доверенным источникам выпусков Cage")
	}
	req, err := http.NewRequestWithContext(ctx, "GET", raw, nil)
	if err != nil {
		return nil, errors.New("Недопустимый запрос обновления")
	}
	req.Header.Set("User-Agent", "Cage-Updater/"+version.Version)
	req.Header.Set("Accept", "application/vnd.github+json")
	if u.Hostname() == "api.github.com" {
		req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	}
	resp, err := client.Do(req)
	if err != nil {
		if errors.Is(ctx.Err(), context.Canceled) {
			return nil, errors.New("Загрузка обновления отменена")
		}
		return nil, usererror.Wrap("Подключение к источнику обновлений приложения", errors.Join(ctx.Err(), err), "В настройках сети и прокси убедитесь, что выбранный узел может подключиться к GitHub, затем проверьте обновления.")
	}
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		switch resp.StatusCode {
		case 404:
			return nil, errors.New("Источник обновлений не находит запрошенную версию или установочный пакет (HTTP 404). Проверьте обновления позже; для ручной установки сверьте файл для нужной платформы на странице выпусков Cage.")
		case 403, 429:
			return nil, updateSourceError(resp, time.Now())
		default:
			return nil, fmt.Errorf("Источник обновлений вернул HTTP %d; повторите попытку позже", resp.StatusCode)
		}
	}
	return resp, nil
}

func limitedBody(resp *http.Response, limit int64) ([]byte, error) {
	defer resp.Body.Close()
	if resp.ContentLength > limit {
		return nil, errors.New("Сведения об обновлении превышают допустимый размер")
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil || int64(len(b)) > limit {
		return nil, errors.New("Загрузка сведений об обновлении прервана или превышает допустимый размер")
	}
	return b, nil
}

func findRelease(ctx context.Context, client *http.Client, current string) (*candidate, error) {
	resp, err := request(ctx, client, releasesURL)
	if err != nil {
		return nil, err
	}
	b, err := limitedBody(resp, maxMetadata)
	if err != nil {
		return nil, err
	}
	var releases []release
	if json.Unmarshal(b, &releases) != nil {
		return nil, errors.New("Источник обновлений вернул недопустимые сведения о версии")
	}
	return selectRelease(releases, current)
}

func selectRelease(releases []release, current string) (*candidate, error) {
	return selectPlatformRelease(releases, current, runtime.GOOS, runtime.GOARCH)
}

func archiveName(version, goos, goarch string) (string, error) {
	switch {
	case goos == "darwin" && goarch == "arm64":
		return "Cage-" + version + "-macos-arm64.dmg", nil
	case goos == "windows" && goarch == "amd64":
		return "Cage-" + version + "-windows-amd64-setup.exe", nil
	default:
		return "", errors.New("Для этой платформы пока нет пакета обновления Cage внутри приложения")
	}
}

func selectPlatformRelease(releases []release, current, goos, goarch string) (*candidate, error) {
	if _, err := archiveName(current, goos, goarch); err != nil {
		return nil, err
	}
	currentTag := "v" + current
	if !semver.IsValid(currentTag) || semver.Canonical(currentTag) != currentTag {
		return nil, errors.New("Текущая версия приложения недопустима, безопасное сравнение обновлений невозможно")
	}
	var best *candidate
	for _, r := range releases {
		if r.Draft || !strings.HasPrefix(r.Tag, "v") || !semver.IsValid(r.Tag) || semver.Canonical(r.Tag) != r.Tag || semver.Compare(r.Tag, currentTag) <= 0 {
			continue
		}
		pre := r.Prerelease || semver.Prerelease(r.Tag) != ""
		if semver.Prerelease(currentTag) == "" && pre {
			continue
		}
		v := strings.TrimPrefix(r.Tag, "v")
		if best != nil && semver.Compare(r.Tag, "v"+best.Version) <= 0 {
			continue
		}
		c := candidate{Version: v}
		name, _ := archiveName(v, goos, goarch)
		for _, a := range r.Assets {
			if a.State != "uploaded" {
				continue
			}
			if a.Name == name && a.Size > 0 && a.Size <= maxArchive {
				c.Archive = a
			}
			if a.Name == "SHA256SUMS" && a.Size > 0 && a.Size <= 64<<10 {
				c.Checksums = a
			}
		}
		if c.Archive.URL == "" {
			continue
		}
		u, err := url.Parse(c.Archive.URL)
		if err != nil || !allowedURL(u, false) || u.Hostname() != "github.com" || !strings.HasPrefix(u.Path, "/"+repository+"/releases/download/"+r.Tag+"/") {
			continue
		}
		if c.Archive.Digest == "" && c.Checksums.URL == "" {
			continue
		}
		best = &c
	}
	return best, nil
}

func digestValue(raw string) (string, error) {
	if !strings.HasPrefix(raw, "sha256:") {
		return "", errors.New("В пакете выпуска отсутствует действительная контрольная сумма SHA-256")
	}
	h := strings.TrimPrefix(raw, "sha256:")
	b, err := hex.DecodeString(h)
	if err != nil || len(b) != sha256.Size {
		return "", errors.New("Недопустимая контрольная сумма SHA-256 пакета выпуска")
	}
	return strings.ToLower(h), nil
}

func releaseDigest(ctx context.Context, client *http.Client, c candidate) (string, error) {
	var hash string
	if c.Archive.Digest != "" {
		var err error
		hash, err = digestValue(c.Archive.Digest)
		if err != nil {
			return "", err
		}
	}
	if c.Checksums.URL == "" {
		return hash, nil
	}
	u, err := url.Parse(c.Checksums.URL)
	if err != nil || u.Hostname() != "github.com" || !strings.HasPrefix(u.Path, "/"+repository+"/releases/download/v"+c.Version+"/") {
		return "", errors.New("Список контрольных сумм относится к другой версии выпуска")
	}
	resp, err := request(ctx, client, c.Checksums.URL)
	if err != nil {
		return "", err
	}
	b, err := limitedBody(resp, 64<<10)
	if err != nil {
		return "", err
	}
	found := ""
	for _, line := range strings.Split(string(b), "\n") {
		fields := strings.Fields(line)
		if len(fields) != 2 || strings.TrimPrefix(fields[1], "*") != c.Archive.Name {
			continue
		}
		h, err := digestValue("sha256:" + fields[0])
		if err != nil || found != "" {
			return "", errors.New("Список контрольных сумм пакета выпуска недопустим или содержит повторы")
		}
		found = h
	}
	if found == "" || (hash != "" && hash != found) {
		return "", errors.New("SHA-256 пакета выпуска не совпадает со списком контрольных сумм")
	}
	return found, nil
}

func download(ctx context.Context, client *http.Client, a asset, digest, path string, progress func(int64)) error {
	if a.Size <= 0 || a.Size > maxArchive {
		return errors.New("Недопустимый размер пакета выпуска или превышение 512 MiB")
	}
	if _, err := digestValue("sha256:" + digest); err != nil {
		return err
	}
	resp, err := request(ctx, client, a.URL)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.ContentLength > 0 && resp.ContentLength != a.Size {
		return errors.New("Размер пакета выпуска не совпадает со сведениями о выпуске")
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return errors.New("Не удалось создать закрытый файл обновления")
	}
	keep := false
	defer func() {
		f.Close()
		if !keep {
			os.Remove(path)
		}
	}()
	if err := host.ProtectFile(path); err != nil {
		return errors.New("Не удалось защитить файл обновления")
	}
	hash := sha256.New()
	w := &progressWriter{writer: io.MultiWriter(f, hash), notify: progress}
	n, err := io.Copy(w, io.LimitReader(resp.Body, a.Size+1))
	if err != nil || n != a.Size {
		return errors.New("Загрузка пакета выпуска прервана или фактический размер не совпадает")
	}
	if hex.EncodeToString(hash.Sum(nil)) != digest {
		return errors.New("Проверка SHA-256 пакета выпуска не удалась, скачайте заново")
	}
	if err = f.Sync(); err != nil {
		return errors.New("Не удалось сохранить файл обновления")
	}
	if err = f.Close(); err != nil {
		return errors.New("Не удалось сохранить файл обновления")
	}
	keep = true
	progress(n)
	return nil
}

type progressWriter struct {
	writer io.Writer
	notify func(int64)
	total  int64
	last   time.Time
}

func (w *progressWriter) Write(p []byte) (int, error) {
	n, err := w.writer.Write(p)
	w.total += int64(n)
	if time.Since(w.last) >= 250*time.Millisecond {
		w.last = time.Now()
		w.notify(w.total)
	}
	return n, err
}
