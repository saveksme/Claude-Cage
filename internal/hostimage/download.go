package hostimage

import (
	"context"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/hex"
	"errors"
	"fmt"
	"hash"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func digestHash(digest string) (hash.Hash, error) {
	kind, value, ok := strings.Cut(digest, ":")
	decoded, err := hex.DecodeString(value)
	if !ok || err != nil {
		return nil, errors.New("Недопустимая контрольная сумма системного образа")
	}
	switch {
	case kind == "sha256" && len(decoded) == sha256.Size:
		return sha256.New(), nil
	case kind == "sha512" && len(decoded) == sha512.Size:
		return sha512.New(), nil
	default:
		return nil, errors.New("Недопустимый алгоритм контрольной суммы системного образа")
	}
}

type progressReader struct {
	ctx      context.Context
	reader   io.Reader
	out      io.Writer
	received int64
	total    int64
	activity string
	system   string
	last     time.Time
}

func (r *progressReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	n, err := r.reader.Read(p)
	r.received += int64(n)
	if time.Since(r.last) > 3*time.Second || err == io.EOF || (r.total > 0 && r.received >= r.total) {
		operation := "download"
		if r.activity == "Проверка системных материалов" {
			operation = "verify"
		}
		fmt.Fprintf(r.out, "CAGE_GUEST_BYTES %s %s %d %d\n", r.system, operation, r.received, r.total)
		if r.total > 0 {
			fmt.Fprintf(r.out, "%s %.1f / %.1f MiB (%.0f%%)\n", r.activity, float64(r.received)/(1<<20), float64(r.total)/(1<<20), 100*float64(r.received)/float64(r.total))
		} else {
			fmt.Fprintf(r.out, "%s %.1f MiB\n", r.activity, float64(r.received)/(1<<20))
		}
		r.last = time.Now()
	}
	return n, err
}

func verify(ctx context.Context, path string, plan Plan, output io.Writer) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	before, err := file.Stat()
	if err != nil {
		return "", err
	}
	if !before.Mode().IsRegular() || (plan.Bytes > 0 && before.Size() != plan.Bytes) ||
		(plan.Modified != 0 && before.ModTime().UnixNano() != plan.Modified) {
		return "", errors.New("Локальный образ изменился после выбора; проверьте заново")
	}
	digest := plan.Digest
	if digest == "" {
		digest = "sha256:" + strings.Repeat("0", 64)
	}
	hasher, err := digestHash(digest)
	if err != nil {
		return "", err
	}
	if _, err = io.Copy(hasher, &progressReader{ctx: ctx, reader: file, out: output, total: before.Size(), activity: "Проверка системных материалов", system: plan.Host.System}); err != nil {
		return "", err
	}
	after, err := file.Stat()
	current, pathErr := os.Stat(path)
	if err != nil || pathErr != nil || !os.SameFile(before, current) || after.Size() != before.Size() || after.ModTime() != before.ModTime() {
		return "", errors.New("Во время проверки системный образ изменился; проверьте заново")
	}
	actual := strings.SplitN(digest, ":", 2)[0] + ":" + hex.EncodeToString(hasher.Sum(nil))
	if plan.Digest != "" && actual != plan.Digest {
		return "", errors.New("Контрольная сумма системного образа не совпадает; выберите или скачайте образ заново")
	}
	if plan.Format == "ipsw" {
		version, build, err := macImageIdentity(path)
		if err != nil || version != plan.Version || build != plan.Build {
			return "", errors.New("Содержимое образа восстановления не соответствует выбранной версии macOS")
		}
	}
	return actual, nil
}

// Prepare verifies existing media or resumes the exact pinned download. Only a
// verified complete archive is published. Interruptions retain the partial file.
func Prepare(ctx context.Context, cache string, plan Plan, output io.Writer, transport http.RoundTripper) (Plan, error) {
	if err := plan.Validate(); err != nil {
		return Plan{}, err
	}
	if output == nil {
		output = io.Discard
	}
	if plan.Path != "" {
		fmt.Fprintln(output, "Проверка системного образа…")
		digest, err := verify(ctx, plan.Path, plan, output)
		if err != nil {
			return Plan{}, err
		}
		plan.Digest = digest
		info, err := os.Stat(plan.Path)
		if err != nil {
			return Plan{}, err
		}
		plan.Bytes, plan.Modified = info.Size(), info.ModTime().UnixNano()
		return plan, Save(cache, plan)
	}
	if err := os.MkdirAll(cache, 0700); err != nil {
		return Plan{}, err
	}
	root, err := os.OpenRoot(cache)
	if err != nil {
		return Plan{}, err
	}
	defer root.Close()
	final := filepath.Base(plan.CachedPath(cache))
	if info, err := root.Lstat(final + ".lock"); err == nil && !info.Mode().IsRegular() {
		return Plan{}, errors.New("Недопустимый путь блокировки загрузки системы")
	}
	lock, err := root.OpenFile(final+".lock", os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return Plan{}, err
	}
	defer lock.Close()
	if err := lockDownload(lock); err != nil {
		return Plan{}, fmt.Errorf("Другая установка готовит этот системный образ; дождитесь её завершения и продолжите: %w", err)
	}
	if info, err := root.Lstat(final); err == nil {
		if !info.Mode().IsRegular() {
			return Plan{}, errors.New("Недопустимый путь кеша системных материалов")
		}
		plan.Path, plan.Modified = filepath.Join(cache, final), info.ModTime().UnixNano()
		return Prepare(ctx, cache, plan, output, transport)
	} else if !errors.Is(err, os.ErrNotExist) {
		return Plan{}, err
	}
	partial := final + ".partial"
	if info, err := root.Lstat(partial); err == nil && !info.Mode().IsRegular() {
		return Plan{}, errors.New("Недопустимый путь незавершённой загрузки системы")
	}
	file, err := root.OpenFile(partial, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return Plan{}, err
	}
	defer func() { _ = file.Close() }()
	info, err := file.Stat()
	if err != nil {
		return Plan{}, err
	}
	offset := info.Size()
	if plan.Bytes > 0 && offset > plan.Bytes {
		if err = file.Close(); err != nil {
			return Plan{}, err
		}
		if err = root.Rename(partial, partial+".invalid-"+time.Now().UTC().Format("20060102T150405.000000000")); err != nil {
			return Plan{}, err
		}
		file, err = root.OpenFile(partial, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
		if err != nil {
			return Plan{}, err
		}
		offset = 0
		fmt.Fprintln(output, "Незавершённый файл недопустимого размера сохранён; повторная загрузка выбранных системных материалов…")
	}
	if offset != plan.Bytes || plan.Bytes == 0 {
		fmt.Fprintf(output, "Загрузка системных материалов %s %s, сохранено %.1f MiB…\n", plan.Host.System, plan.Version, float64(offset)/(1<<20))
		err = download(ctx, plan, file, offset, output, transport)
		if err != nil {
			return Plan{}, fmt.Errorf("Загрузка системы прервана; прогресс сохранён, установку можно продолжить: %w", err)
		}
	}
	if err = file.Sync(); err != nil {
		return Plan{}, err
	}
	if err = file.Close(); err != nil {
		return Plan{}, err
	}
	if _, err = verify(ctx, filepath.Join(cache, partial), plan, output); err != nil {
		// Preserve the failed download for diagnosis. A new attempt can resume
		// into a new partial file, without reusing corrupt bytes.
		if ctx.Err() == nil {
			_ = root.Rename(partial, partial+".invalid-"+time.Now().UTC().Format("20060102T150405.000000000"))
		}
		return Plan{}, err
	}
	if err = root.Rename(partial, final); err != nil {
		return Plan{}, err
	}
	info, err = root.Stat(final)
	if err != nil {
		return Plan{}, err
	}
	plan.Path, plan.Modified, plan.Bytes = filepath.Join(cache, final), info.ModTime().UnixNano(), info.Size()
	return plan, Save(cache, plan)
}

func download(ctx context.Context, plan Plan, file *os.File, offset int64, output io.Writer, transport http.RoundTripper) error {
	client := &http.Client{Transport: transport, Timeout: 2 * time.Hour, CheckRedirect: func(request *http.Request, previous []*http.Request) error {
		if len(previous) >= 5 {
			return errors.New("Слишком много перенаправлений загрузки системы")
		}
		return trustedURL(request.URL.String(), plan.Host.System)
	}}
	defer client.CloseIdleConnections()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, plan.URL, nil)
	if err != nil {
		return err
	}
	request.Header.Set("Accept-Encoding", "identity")
	request.Header.Set("User-Agent", "Mozilla/5.0 (compatible; Cage-SystemInstaller/1.0)")
	if offset > 0 {
		request.Header.Set("Range", fmt.Sprintf("bytes=%d-", offset))
	}
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	switch response.StatusCode {
	case http.StatusOK:
		offset = 0
		if err = file.Truncate(0); err != nil {
			return err
		}
	case http.StatusPartialContent:
		var start, end, total int64
		if _, err = fmt.Sscanf(response.Header.Get("Content-Range"), "bytes %d-%d/%d", &start, &end, &total); err != nil ||
			start != offset || end < start || (plan.Bytes > 0 && total != plan.Bytes) {
			return errors.New("Сервер вернул диапазон продолжения, не совпадающий с исходным образом")
		}
	default:
		return fmt.Errorf("Загрузка системы вернула HTTP %d", response.StatusCode)
	}
	if _, err = file.Seek(offset, io.SeekStart); err != nil {
		return err
	}
	limit := int64(64 << 30)
	if plan.Bytes > 0 {
		limit = plan.Bytes
	}
	count, err := io.Copy(file, &progressReader{ctx: ctx, reader: io.LimitReader(response.Body, limit-offset+1), out: output, received: offset, total: plan.Bytes, activity: "Загрузка системных материалов", system: plan.Host.System})
	if err != nil {
		return err
	}
	if offset+count > limit || (plan.Bytes > 0 && offset+count != plan.Bytes) {
		return errors.New("Размер загруженных системных материалов не совпадает")
	}
	return nil
}
