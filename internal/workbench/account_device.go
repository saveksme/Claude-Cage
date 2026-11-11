package workbench

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"maps"
)

type accountDevice struct {
	ID        string `json:"id"`
	Nonce     []byte `json:"nonce"`
	SealedKey []byte `json:"sealed_key"`
}
type deviceCredential struct {
	ID     string `json:"id"`
	Secret string `json:"secret"`
}

func validDeviceKind(kind string) bool { return kind == "automatic" || kind == "biometric" }
func fmtAccountBinding(path string) string {
	sum := sha256.Sum256([]byte(path))
	return hex.EncodeToString(sum[:])
}
func deviceAEAD(secret []byte) (cipher.AEAD, error) {
	block, err := aes.NewCipher(secret)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}
func (a *localAccount) enrollDevice(kind string) (deviceCredential, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if !validDeviceKind(kind) || len(a.key) != 32 {
		return deviceCredential{}, errors.New("Сначала разблокируйте Cage, затем настройте быстрый вход")
	}
	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		return deviceCredential{}, err
	}
	defer clear(secret)
	id := make([]byte, 16)
	if _, err := rand.Read(id); err != nil {
		return deviceCredential{}, err
	}
	device := accountDevice{ID: hex.EncodeToString(id), Nonce: make([]byte, 12)}
	if _, err := rand.Read(device.Nonce); err != nil {
		return deviceCredential{}, err
	}
	aead, _ := deviceAEAD(secret)
	device.SealedKey = aead.Seal(nil, device.Nonce, a.key, []byte(kind+":"+device.ID))
	record := *a.record
	record.Devices = maps.Clone(record.Devices)
	if record.Devices == nil {
		record.Devices = map[string]accountDevice{}
	}
	record.Devices[kind] = device
	if err := writePrivate(a.path, record); err != nil {
		return deviceCredential{}, errors.New("Не удалось сохранить быстрый вход; повторите попытку")
	}
	a.record = &record
	return deviceCredential{ID: device.ID, Secret: base64.RawStdEncoding.EncodeToString(secret)}, nil
}
func (a *localAccount) revokeDevice(kind string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if !validDeviceKind(kind) || len(a.key) != 32 {
		return errors.New("Сначала разблокируйте Cage")
	}
	record := *a.record
	record.Devices = maps.Clone(record.Devices)
	delete(record.Devices, kind)
	if err := writePrivate(a.path, record); err != nil {
		return errors.New("Не удалось отключить быстрый вход; повторите попытку")
	}
	a.record = &record
	return nil
}

// Called with a.mu held. The disk flag prevents reopening the app or restarting
// the controller from turning an explicit lock into automatic login.
func (a *localAccount) clearAuthenticationRequirement() error {
	if !a.record.RequireAuthentication {
		return nil
	}
	record := *a.record
	record.RequireAuthentication = false
	if err := writePrivate(a.path, record); err != nil {
		return errors.New("Не удалось сохранить состояние разблокировки; повторите попытку")
	}
	a.record = &record
	return nil
}
func (a *localAccount) unlockDevice(kind string, credential deviceCredential) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.record == nil || !validDeviceKind(kind) {
		return errors.New("Быстрый вход недоступен; используйте пароль")
	}
	if kind == "automatic" && a.record.RequireAuthentication {
		return errors.New("Cage заблокирован вручную; используйте отпечаток пальца или пароль")
	}
	device, ok := a.record.Devices[kind]
	if !ok || device.ID != credential.ID {
		return errors.New("Авторизация быстрого входа истекла; используйте пароль")
	}
	secret, err := base64.RawStdEncoding.DecodeString(credential.Secret)
	if err != nil || len(secret) != 32 {
		return errors.New("Недействительные учётные данные быстрого входа")
	}
	defer clear(secret)
	aead, _ := deviceAEAD(secret)
	key, err := aead.Open(nil, device.Nonce, device.SealedKey, []byte(kind+":"+device.ID))
	if err != nil {
		return errors.New("Недействительные учётные данные быстрого входа")
	}
	if err = a.clearAuthenticationRequirement(); err != nil {
		clear(key)
		return err
	}
	a.setKey(key)
	return nil
}
func (a *localAccount) lockAccess(logout bool) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.record == nil {
		return nil
	}
	record := *a.record
	record.RequireAuthentication = true
	if logout {
		record.Devices = nil
		record.TrustedUnlock = nil
	}
	if err := writePrivate(a.path, record); err != nil {
		return errors.New("Не удалось сохранить состояние блокировки аккаунта; повторите попытку")
	}
	a.record = &record
	if a.cancel != nil {
		a.cancel()
		a.cancel = nil
	}
	clear(a.key)
	a.key = nil
	return nil
}
