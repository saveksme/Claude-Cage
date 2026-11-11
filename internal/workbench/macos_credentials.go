package workbench

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/sylvinus/agent-vm/internal/guestos"
)

// This credential is encrypted with the account key, with a separate domain.
// Saving it in the account record makes password changes and the guest retry
// record one atomic write. Website vault APIs never see this data.
type macAccountEnvelope struct{ Nonce, Data []byte }
type macGuestCredential struct{ Username, Password string }
type macAccountData struct {
	Password string
	Guests   map[string]macGuestCredential
}

const macAccountDomain = "Cage shared macOS account v1"

func validMacAccount(name, password string) error {
	if !guestos.ValidMacOSAccountName(name) {
		return errors.New("Общее имя пользователя macOS должно начинаться со строчной латинской буквы и содержать от 1 до 31 строчной буквы, цифры или подчёркивания; системные зарезервированные имена использовать нельзя")
	}
	if !guestos.ValidMacOSInstallPassword(password) {
		return errors.New("Общий пароль macOS должен содержать от 8 до 256 символов, доступных на английской клавиатуре: букв, цифр, пробелов или знаков")
	}
	return nil
}
func sealMacAccount(record *accountRecord, key []byte, login macAccountData) error {
	block, err := aes.NewCipher(key)
	if err != nil {
		return err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return err
	}
	plain, err := json.Marshal(login)
	if err != nil {
		return err
	}
	defer clear(plain)
	sealed := &macAccountEnvelope{Nonce: make([]byte, aead.NonceSize())}
	if _, err = rand.Read(sealed.Nonce); err != nil {
		return err
	}
	sealed.Data = aead.Seal(nil, sealed.Nonce, plain, []byte(macAccountDomain))
	record.MacLogin = sealed
	return nil
}

// Caller holds a.mu.
func (a *localAccount) openMacAccount() (macAccountData, error) {
	var login macAccountData
	if len(a.key) != 32 || a.record == nil {
		return login, errors.New("Сначала разблокируйте Cage")
	}
	if a.record.MacLogin == nil {
		return login, errors.New("Сначала подтвердите имя пользователя и пароль Cage, затем устанавливайте гостевую систему macOS")
	}
	block, _ := aes.NewCipher(a.key)
	aead, _ := cipher.NewGCM(block)
	sealed := a.record.MacLogin
	if len(sealed.Nonce) != aead.NonceSize() {
		return login, errors.New("Общие учётные данные гостевой системы повреждены; восстановите резервную копию аккаунта")
	}
	plain, err := aead.Open(nil, sealed.Nonce, sealed.Data, []byte(macAccountDomain))
	if err != nil {
		return login, errors.New("Не удалось расшифровать общие учётные данные гостевой системы; восстановите резервную копию аккаунта")
	}
	defer clear(plain)
	if json.Unmarshal(plain, &login) != nil || validMacAccount(a.record.Username, login.Password) != nil {
		return login, errors.New("Общие учётные данные гостевой системы недействительны; восстановите резервную копию аккаунта")
	}
	return login, nil
}

// Existing password accounts prove their password; older trusted local accounts
// set their first password without replacing the account key or personal data.
func (a *localAccount) prepareMacAccount(name, password string, guests map[string]macGuestCredential) error {
	name = strings.TrimSpace(name)
	if err := validMacAccount(name, password); err != nil {
		return err
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if len(a.key) != 32 || a.record == nil {
		return errors.New("Сначала разблокируйте Cage")
	}
	if a.record.MacLogin != nil {
		return errors.New("Общие учётные данные уже заданы; измените пароль в настройках аккаунта")
	}
	if a.record.TrustedDevice == "" {
		if time.Now().Before(a.nextAttempt) {
			return errors.New("Повторите позже")
		}
		key, err := openAccountKey(a.record, password)
		if err != nil {
			a.nextAttempt = time.Now().Add(time.Second)
			return err
		}
		clear(key)
		a.nextAttempt = time.Time{}
	}
	record := *a.record
	record.Username, record.TrustedDevice = name, ""
	if err := sealAccountKey(&record, password, a.key); err != nil {
		return err
	}
	if err := sealMacAccount(&record, a.key, macAccountData{Password: password, Guests: guests}); err != nil {
		return err
	}
	if err := writePrivate(a.path, &record); err != nil {
		return errors.New("Не удалось сохранить общие учётные данные; исходный аккаунт и файлы сохранены")
	}
	a.record, a.trustedSession = &record, false
	return nil
}

func (a *localAccount) macGuestCredentials(ctx context.Context, id uuid.UUID) (macGuestCredential, error) {
	if ctx.Err() != nil {
		return macGuestCredential{}, ctx.Err()
	}
	if id == uuid.Nil {
		return macGuestCredential{}, errors.New("Отсутствует идентичность установки гостевой системы")
	}
	a.mu.Lock()
	if a.record != nil && a.record.MacLogin != nil {
		login, err := a.openMacAccount()
		a.mu.Unlock()
		if err != nil {
			return macGuestCredential{}, err
		}
		if guest, ok := login.Guests[id.String()]; ok {
			return guest, nil
		}
	} else {
		a.mu.Unlock()
	}
	// Old installations retain their existing account and password.
	legacy, err := a.legacyMacGuestPassword(ctx, id)
	if err != nil {
		return macGuestCredential{}, err
	}
	if legacy != "" {
		return macGuestCredential{Username: "cage", Password: legacy}, nil
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if ctx.Err() != nil {
		return macGuestCredential{}, ctx.Err()
	}
	login, err := a.openMacAccount()
	if err != nil {
		return macGuestCredential{}, err
	}
	if guest, ok := login.Guests[id.String()]; ok {
		return guest, nil
	}
	guest := macGuestCredential{Username: a.record.Username, Password: login.Password}
	if login.Guests == nil {
		login.Guests = map[string]macGuestCredential{}
	}
	login.Guests[id.String()] = guest
	record := *a.record
	if err = sealMacAccount(&record, a.key, login); err != nil {
		return macGuestCredential{}, err
	}
	if err = writePrivate(a.path, &record); err != nil {
		return macGuestCredential{}, errors.New("Не удалось сохранить учётные данные гостевой системы; проверьте место на диске и права на каталог")
	}
	a.record = &record
	return guest, nil
}
func (a *localAccount) savedMacGuestPassword(ctx context.Context, id uuid.UUID) (string, error) {
	a.mu.Lock()
	if len(a.key) != 32 || ctx.Err() != nil {
		a.mu.Unlock()
		return "", errors.New("Сначала разблокируйте Cage")
	}
	if a.record.MacLogin != nil {
		login, err := a.openMacAccount()
		a.mu.Unlock()
		if err != nil {
			return "", err
		}
		if guest, ok := login.Guests[id.String()]; ok {
			return guest.Password, nil
		}
	} else {
		a.mu.Unlock()
	}
	return a.legacyMacGuestPassword(ctx, id)
}
func (a *localAccount) legacyMacGuestPassword(ctx context.Context, id uuid.UUID) (string, error) {
	var password string
	err := a.withVault(ctx, false, func(db *vaultData) error { password = db.GuestPasswords[id.String()]; return nil })
	return password, err
}

// syncMacPassword retries with both the last confirmed and the target password.
// The guest operation must be idempotent after any individual system write.
func (a *localAccount) syncMacPassword(ctx context.Context, id uuid.UUID, user string, apply func(context.Context, string, string) error) error {
	a.macSync.Lock()
	defer a.macSync.Unlock()
	a.mu.Lock()
	if a.record == nil || a.record.MacLogin == nil || len(a.key) != 32 {
		a.mu.Unlock()
		return nil
	}
	login, err := a.openMacAccount()
	if err != nil {
		a.mu.Unlock()
		return err
	}
	guest, ok := login.Guests[id.String()]
	if !ok || guest.Password == login.Password {
		a.mu.Unlock()
		return nil
	}
	if guest.Username != user {
		a.mu.Unlock()
		return errors.New("Синхронизированный аккаунт гостевой системы не совпадает с записью установки; исходный аккаунт сохранён")
	}
	target := login.Password
	a.mu.Unlock()
	if err = apply(ctx, guest.Password, target); err != nil {
		return errors.New("Пароль Cage сохранён; пароль гостевой системы ещё не синхронизирован. Запустите гостевую систему и повторите; до этого ей может понадобиться старый пароль")
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	login, err = a.openMacAccount()
	if err != nil {
		return err
	}
	current, ok := login.Guests[id.String()]
	if !ok || current != guest || login.Password != target {
		return errors.New("Запись синхронизации пароля гостевой системы изменилась; повторите")
	}
	current.Password = target
	login.Guests[id.String()] = current
	record := *a.record
	if err = sealMacAccount(&record, a.key, login); err != nil {
		return err
	}
	if err = writePrivate(a.path, &record); err != nil {
		return errors.New("Пароль гостевой системы обновлён, запись подтверждения ещё не сохранена; при следующем запуске подтверждение будет повторено")
	}
	a.record = &record
	return nil
}
