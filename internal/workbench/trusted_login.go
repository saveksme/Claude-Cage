package workbench

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"maps"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"time"

	"github.com/sylvinus/agent-vm/internal/host"
)

// Only the local launcher possesses the controller token. Its independent
// cookie jar carries this proof; the browser and SSH tickets never receive it.
func trustedViewProof(token string) string {
	digest := sha256.Sum256([]byte("trusted desktop view\x00" + token))
	return hex.EncodeToString(digest[:])
}
func (s *Server) hasTrustedView(r *http.Request) bool {
	c, err := r.Cookie(s.cookieName() + "-desktop")
	return err == nil && equalSecret(c.Value, trustedViewProof(s.token))
}

func validTrustedID(id string) bool {
	if id == "" {
		return true
	}
	_, err := hex.DecodeString(id)
	return len(id) == 64 && err == nil
}

type trustedLoginRequest struct {
	Action       string `json:"action"`
	ConnectionID string `json:"connection_id,omitempty"`
	Token        string `json:"token,omitempty"`
	InstanceID   string `json:"instance_id,omitempty"`
	Password     string `json:"password,omitempty"`
}

// Domain errors travel as data through the authenticated launcher client, which
// deliberately discards HTTP error bodies. Neither credential reaches the web UI.
type trustedLoginReply struct {
	Error string `json:"error,omitempty"`
}

func (d *desktopGateway) trustedLogin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Требуется POST-запрос", 405)
		return
	}
	var in trustedLoginRequest
	if !readJSON(w, r, &in) {
		return
	}
	d.change.Lock()
	defer d.change.Unlock()
	session, remote, err := d.acquire(in.ConnectionID)
	local, ok := d.local.(*desktopLocal)
	if err != nil || remote || !ok {
		http.Error(w, "Вернитесь в текущую рабочую среду на этом компьютере", 409)
		return
	}
	c, err := openController(local.profile)
	if err != nil {
		http.Error(w, "Не удалось подключиться к фоновой службе этого компьютера", 503)
		return
	}
	defer c.close()
	if c.origin != session.Origin {
		http.Error(w, "Фоновая служба этого компьютера переключилась", 409)
		return
	}
	in.Token, in.InstanceID = c.record.Token, session.Manifest.InstanceID
	var reply trustedLoginReply
	status, err := c.callContext(r.Context(), "POST", "/api/desktop-local/trusted-login", in, &reply)
	if err != nil || status != http.StatusOK {
		http.Error(w, "Фоновая служба этого компьютера не приняла запрос входа; убедитесь, что Cage обновлён", 409)
		return
	}
	if reply.Error != "" {
		http.Error(w, reply.Error, 409)
		return
	}
	jsonReply(w, map[string]bool{"ok": true})
}

func (s *Server) localTrustedLogin(w http.ResponseWriter, r *http.Request) {
	var in trustedLoginRequest
	if !readJSON(w, r, &in) {
		return
	}
	if s.account == nil || !equalSecret(in.Token, s.token) || in.InstanceID != s.instanceID {
		http.Error(w, "Launcher refused", http.StatusUnauthorized)
		return
	}
	_, finish, err := s.beginActivity(r.Context())
	if err != nil {
		http.Error(w, "Фоновая служба обновляется", 503)
		return
	}
	defer finish()
	if in.Action == "create" {
		jsonReply(w, trustedLoginReply{Error: "Сначала зарегистрируйте имя пользователя и пароль Cage, затем начинайте установку"})
		return
	}
	base, err := os.UserConfigDir()
	if runtime.GOOS == "windows" {
		base = os.Getenv("LOCALAPPDATA")
	}
	if !filepath.IsAbs(base) {
		err = errors.New("Не удалось определить каталог конфигурации системного пользователя этого компьютера")
	}
	if err == nil {
		err = s.account.trustedLogin(in.Action, in.Password, filepath.Join(base, "Cage", "trusted-local"))
	}
	reply := trustedLoginReply{}
	if err != nil {
		reply.Error = err.Error()
	}
	jsonReply(w, reply)
}

func (a *localAccount) trustedLogin(action, password, devices string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	switch action {
	case "create":
		if a.record != nil {
			return errors.New("Аккаунт уже существует; используйте прежний способ входа")
		}
		record := &accountRecord{Version: 1, Username: "Пользователь этого компьютера", TrustedDevice: randomToken()}
		secret := randomToken()
		key := make([]byte, 32)
		if _, err := rand.Read(key); err != nil {
			return err
		}
		defer clear(key)
		if err := sealAccountKey(record, secret, key); err != nil {
			return err
		}
		path := filepath.Join(devices, record.TrustedDevice+".json")
		// Store the wrapping credential first. A crash cannot publish a record
		// whose credential has not been persisted.
		if err := writePrivate(path, secret); err != nil {
			return errors.New("Не удалось сохранить учётные данные доверия текущего системного пользователя")
		}
		if err := writePrivate(a.path, record); err != nil {
			_ = os.Remove(path)
			return errors.New("Не удалось сохранить локальное рабочее пространство")
		}
		a.record = record
		a.setKey(append([]byte(nil), key...))
		a.trustedSession = true
	case "enable":
		if a.record == nil || a.record.TrustedDevice != "" || len(a.key) != 32 {
			return errors.New("Сначала войдите с локальным аккаунтом")
		}
		if time.Now().Before(a.nextAttempt) {
			return errors.New("Повторите позже")
		}
		key, err := openAccountKey(a.record, password)
		if err != nil {
			a.nextAttempt = time.Now().Add(time.Second)
			return err
		}
		defer clear(key)
		a.nextAttempt = time.Time{}
		secret := randomToken()
		raw, err := hex.DecodeString(secret)
		if err != nil {
			return err
		}
		defer clear(raw)
		aead, err := deviceAEAD(raw)
		if err != nil {
			return err
		}
		device := accountDevice{ID: randomToken(), Nonce: make([]byte, aead.NonceSize())}
		if _, err = rand.Read(device.Nonce); err != nil {
			return err
		}
		device.SealedKey = aead.Seal(nil, device.Nonce, key, []byte("trusted:"+device.ID))
		record := *a.record
		record.TrustedUnlock = &device
		// The shared desktop grant replaces the older macOS automatic grant.
		// Keep biometric unlock independent, and revoke both automatic paths
		// when the user turns off Remember me.
		record.Devices = maps.Clone(record.Devices)
		delete(record.Devices, "automatic")
		path := filepath.Join(devices, device.ID+".json")
		if err = writePrivate(path, secret); err != nil {
			return errors.New("Не удалось сохранить учётные данные доверия этого компьютера")
		}
		if err = writePrivate(a.path, &record); err != nil {
			_ = os.Remove(path)
			return errors.New("Не удалось сохранить доверие этого компьютера")
		}
		previous := a.record.TrustedUnlock
		a.record = &record
		if previous != nil {
			_ = os.Remove(filepath.Join(devices, previous.ID+".json"))
		}
	case "disable":
		if a.record == nil || len(a.key) != 32 {
			return errors.New("Сначала разблокируйте Cage")
		}
		if a.record.TrustedUnlock == nil && a.record.Devices["automatic"].ID == "" {
			return nil
		}
		record := *a.record
		record.TrustedUnlock = nil
		record.Devices = maps.Clone(record.Devices)
		delete(record.Devices, "automatic")
		if err := writePrivate(a.path, &record); err != nil {
			return errors.New("Не удалось отключить доверие этого компьютера")
		}
		a.record = &record
	case "resume":
		if a.record == nil || (a.record.TrustedDevice == "" && a.record.TrustedUnlock == nil) || a.record.RequireAuthentication {
			return errors.New("Используйте прежний способ проверки аккаунта")
		}
		if len(a.key) == 32 {
			return nil
		}
		id := a.record.TrustedDevice
		if a.record.TrustedUnlock != nil {
			id = a.record.TrustedUnlock.ID
		}
		path := filepath.Join(devices, id+".json")
		if err := host.CheckPrivateFile(path); err != nil {
			return errors.New("Не найдены приватные учётные данные доверия текущего системного пользователя; восстановите резервную копию")
		}
		data, err := os.ReadFile(path)
		var secret string
		if err != nil || len(data) > 128 || json.Unmarshal(data, &secret) != nil || len(secret) != 64 {
			return errors.New("Не удалось прочитать учётные данные доверия этого компьютера; восстановите резервную копию")
		}
		var key []byte
		if device := a.record.TrustedUnlock; device != nil {
			raw, decodeErr := hex.DecodeString(secret)
			if decodeErr != nil {
				return errors.New("Недействительные учётные данные доверия этого компьютера")
			}
			defer clear(raw)
			aead, cipherErr := deviceAEAD(raw)
			if cipherErr != nil {
				return cipherErr
			}
			key, err = aead.Open(nil, device.Nonce, device.SealedKey, []byte("trusted:"+device.ID))
		} else {
			key, err = openAccountKey(a.record, secret)
		}
		if err != nil {
			return errors.New("Учётные данные доверия не соответствуют рабочему пространству; восстановите резервную копию")
		}
		a.setKey(key)
		a.trustedSession = true
	case "protect":
		if a.record == nil || a.record.TrustedDevice == "" || len(a.key) != 32 {
			return errors.New("Сначала войдите в рабочее пространство на доверенном компьютере")
		}
		if err := validAccountPassword(password); err != nil {
			return err
		}
		record := *a.record
		record.TrustedDevice = ""
		if err := sealAccountKey(&record, password, a.key); err != nil {
			return err
		}
		if err := writePrivate(a.path, &record); err != nil {
			return errors.New("Пароль не сохранён; вход на этом компьютере по-прежнему доступен")
		}
		a.record = &record
	default:
		return errors.New("Неизвестная операция входа с доверием")
	}
	return nil
}
