package workbench

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/sylvinus/agent-vm/internal/host"
)

const vaultDomain = "Cage password vault v1"
const vaultLimit = 4 << 20

type vaultEntry struct {
	ID       string `json:"id"`
	Origin   string `json:"origin"`
	Username string `json:"username"`
	Password string `json:"password,omitempty"`
	Updated  string `json:"updated"`
}
type vaultData struct {
	Entries        []vaultEntry      `json:"entries"`
	Blocked        []string          `json:"blocked"`
	GuestPasswords map[string]string `json:"guest_passwords,omitempty"`
}
type vaultEnvelope struct {
	Version int    `json:"version"`
	Nonce   []byte `json:"nonce"`
	Data    []byte `json:"data"`
}

func vaultOrigin(raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || strings.ContainsAny(raw, "\x00\r\n") || len(raw) > 4096 {
		return "", errors.New("Хранилище паролей поддерживает только адреса сайтов HTTPS")
	}
	host := strings.ToLower(u.Host)
	if u.Port() == "443" {
		host = strings.TrimSuffix(host, ":443")
	}
	return "https://" + host, nil
}

// The account mutex serializes vault transactions with lock/password changes.
// No decrypted database or derived key is retained between requests.
func (a *localAccount) withVault(ctx context.Context, mutate bool, fn func(*vaultData) error) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if len(a.key) != 32 || ctx.Err() != nil {
		return errors.New("Сначала разблокируйте Cage")
	}
	mac := hmac.New(sha256.New, a.key)
	mac.Write([]byte(vaultDomain))
	key := mac.Sum(nil)
	defer clear(key)
	block, err := aes.NewCipher(key)
	if err != nil {
		return err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return err
	}
	path := filepath.Join(filepath.Dir(a.path), "password-vault.json")
	db := vaultData{Entries: []vaultEntry{}, Blocked: []string{}}
	raw, err := os.ReadFile(path)
	if err != nil && !os.IsNotExist(err) {
		return errors.New("Не удалось прочитать хранилище паролей")
	}
	if err == nil {
		if host.CheckPrivateFile(path) != nil {
			return errors.New("Права на файл хранилища паролей небезопасны")
		}
		var sealed vaultEnvelope
		if len(raw) > vaultLimit*2 || json.Unmarshal(raw, &sealed) != nil || sealed.Version != 1 || len(sealed.Nonce) != aead.NonceSize() {
			return errors.New("Хранилище паролей повреждено; восстановите его из резервной копии, существующие файлы не изменены")
		}
		plain, err := aead.Open(nil, sealed.Nonce, sealed.Data, []byte(vaultDomain))
		if err != nil {
			return errors.New("Не удалось расшифровать хранилище паролей; существующие файлы не изменены")
		}
		defer clear(plain)
		if len(plain) > vaultLimit || json.Unmarshal(plain, &db) != nil {
			return errors.New("Содержимое хранилища паролей недействительно; существующие файлы не изменены")
		}
	}
	if err = fn(&db); err != nil {
		return err
	}
	if !mutate {
		return nil
	}
	if ctx.Err() != nil {
		return errors.New("Действие отменено")
	}
	plain, err := json.Marshal(db)
	if err != nil {
		return err
	}
	defer clear(plain)
	if len(plain) > vaultLimit {
		return errors.New("Хранилище паролей заполнено; удалите неиспользуемые записи")
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err = rand.Read(nonce); err != nil {
		return err
	}
	if err = writePrivate(path, vaultEnvelope{1, nonce, aead.Seal(nil, nonce, plain, []byte(vaultDomain))}); err != nil {
		return errors.New("Не удалось сохранить хранилище паролей; проверьте место на диске и права")
	}
	return nil
}

func (db *vaultData) save(entry vaultEntry) error {
	origin, err := vaultOrigin(entry.Origin)
	if err != nil {
		return err
	}
	entry.Origin = origin
	if len(entry.Username) > 1024 || len(entry.Password) > 8192 || strings.ContainsAny(entry.Username, "\x00\r\n") {
		return errors.New("Аккаунт или пароль слишком длинные или недействительны")
	}
	index := -1
	for i, old := range db.Entries {
		if old.ID == entry.ID && entry.ID != "" {
			index = i
		}
		if old.Origin == origin && old.Username == entry.Username && old.ID != entry.ID {
			return errors.New("На этом сайте уже есть аккаунт с таким именем; отредактируйте существующую запись")
		}
	}
	if entry.ID != "" && index < 0 {
		return errors.New("Запись пароля не существует; обновите и повторите")
	}
	if index >= 0 && entry.Password == "" {
		entry.Password = db.Entries[index].Password
	}
	if entry.Password == "" {
		return errors.New("Введите пароль")
	}
	entry.Updated = time.Now().UTC().Format(time.RFC3339)
	if index >= 0 {
		db.Entries[index] = entry
	} else {
		entry.ID = randomToken()
		db.Entries = append(db.Entries, entry)
	}
	db.Blocked = slices.DeleteFunc(db.Blocked, func(s string) bool { return s == origin })
	return nil
}

// Reauthentication does not rotate the access epoch or enable automatic login.
func (a *localAccount) verifyVaultPassword(password string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.record != nil && a.record.TrustedDevice != "" {
		return errors.New("Чтобы просмотреть или скопировать пароль, задайте пароль на этом компьютере в разделе «Настройки → Аккаунт»")
	}
	if len(a.key) != 32 {
		return errors.New("Сначала разблокируйте Cage")
	}
	if time.Now().Before(a.nextAttempt) {
		return errors.New("Повторите позже")
	}
	key, err := openAccountKey(a.record, password)
	defer clear(key)
	if err != nil {
		a.nextAttempt = time.Now().Add(time.Second)
		return err
	}
	a.nextAttempt = time.Time{}
	return nil
}
