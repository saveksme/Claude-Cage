package workbench

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"time"

	"github.com/sylvinus/agent-vm/internal/containerenv"
	"github.com/sylvinus/agent-vm/internal/managedproxy"
	"github.com/sylvinus/agent-vm/internal/remotehost"
)

type desktopLocal struct {
	config, profile, executable string
	mu                          sync.Mutex
	ownedLaunch                 string
}

func NewDesktopLocalController(configPath, fullExecutable string) DesktopLocalController {
	return &desktopLocal{config: configPath, profile: filepath.Dir(configPath), executable: fullExecutable}
}

func (d *desktopLocal) available() bool {
	info, err := os.Stat(d.executable)
	return filepath.IsAbs(d.executable) && err == nil && info.Mode().IsRegular() && (runtime.GOOS == "windows" || info.Mode()&0111 != 0)
}

func (c *controllerClient) localControl(ctx context.Context, action string, input desktopLocalRequest) (desktopLocalReply, error) {
	var reply desktopLocalReply
	input.Token = c.record.Token
	status, err := c.callContext(ctx, http.MethodPost, "/api/desktop-local/"+action, input, &reply)
	if err != nil {
		return reply, err
	}
	switch status {
	case http.StatusOK:
		if action == "status" && (reply.OwnerID != localControllerID(c.record.Token) || reply.Identity.PID != c.record.PID || reply.Identity.Protocol != controlProtocol || !reply.Identity.matches(c.record.Controller) || !remoteInstanceID.MatchString(reply.InstanceID)) {
			return reply, errors.New("Не удалось подтвердить идентичность локальной службы управления")
		}
		return reply, nil
	case http.StatusLocked:
		return reply, errDesktopLocalLocked
	case http.StatusNotFound:
		return reply, errors.New("Текущая версия локальной фоновой службы не поддерживает переключение среды; сначала сохраните задачи в исходной рабочей среде и завершите обновление фоновой службы")
	case http.StatusConflict:
		return reply, errors.New("На этом компьютере ещё выполняется действие или состояние изменилось; подтвердите заново")
	default:
		return reply, errors.New("Локальная служба управления не приняла это действие")
	}
}

// offlineStatus uses only existing private records. A live lock, orphan VM,
// or proxy without a reachable controller is unknown, never a released state.
func (d *desktopLocal) offlineStatus(ctx context.Context, available bool) DesktopLocalStatus {
	st := DesktopLocalStatus{Available: available, Message: "Состояние этого компьютера требует подтверждения; вернитесь на этот компьютер и проверьте существующую фоновую службу"}
	free, err := controllerLockStatus(d.profile)
	if err != nil {
		st.Message = "Не удалось проверить локальную блокировку управления или исправить права старой версии; проверьте доступ к каталогу конфигурации: " + err.Error()
		return st
	}
	if !free {
		st.ServiceRunning = true
		return st
	}
	// A container host requires an explicit engine probe. Listing the desktop
	// selector must not contact or start a container engine.
	if containerenv.Configured(d.profile) {
		return st
	}
	running, err := controllerVMState(d.profile)
	if err != nil || running {
		st.Running = running
		return st
	}
	if managedproxy.ConfirmStopped(ctx, d.profile) != nil {
		return st
	}
	st.Known, st.Message = true, ""
	return st
}

func (d *desktopLocal) Status(ctx context.Context) (DesktopLocalStatus, error) {
	available := d.available()
	free, lockErr := controllerLockStatus(d.profile)
	if free || lockErr != nil {
		return d.offlineStatus(ctx, available), nil
	}
	c, err := openController(d.profile)
	if errors.Is(err, errControllerUnavailable) {
		return d.offlineStatus(ctx, available), nil
	}
	if err != nil {
		return DesktopLocalStatus{Available: available, Message: "Неверная запись локальной фоновой службы; проверьте конфигурацию этого компьютера"}, nil
	}
	defer c.close()
	view, err := c.localControl(ctx, "status", desktopLocalRequest{})
	if err != nil {
		if !processExists(c.record.PID) {
			return d.offlineStatus(ctx, available), nil
		}
		return DesktopLocalStatus{Available: available, ServiceRunning: true, Message: "Не удалось определить состояние или версию существующей локальной фоновой службы"}, nil
	}
	view.Available = available
	return view.DesktopLocalStatus, nil
}

func (d *desktopLocal) Connect(ctx context.Context) (_ *remotehost.Session, returned error) {
	st, err := d.Status(ctx)
	if err != nil {
		return nil, err
	}
	if !st.Available {
		return nil, errors.New("В этой установке отсутствует локальный компонент выполнения")
	}
	if !st.Known && st.ServiceRunning && st.ControllerID == "" {
		wait, cancel := context.WithTimeout(ctx, 12*time.Second)
		c, waitErr := waitControllerReady(wait, d.profile)
		cancel()
		if c != nil {
			c.close()
		}
		if waitErr != nil && !errors.Is(waitErr, errControllerUnavailable) {
			return nil, waitErr
		}
		st, err = d.Status(ctx)
		if err != nil {
			return nil, err
		}
	}
	if !st.Known && st.ServiceRunning && st.ControllerID == "" {
		handed, err := d.handoffOldLocal(ctx)
		if err != nil {
			return nil, err
		}
		if handed {
			st, err = d.Status(ctx)
			if err != nil || !st.Known || st.ServiceRunning {
				return nil, errors.New("Существующая локальная служба ещё не завершилась; обновите состояние и повторите")
			}
		}
	}
	// Explicit local selection may reattach an orphan workload to its owner.
	// A live or inaccessible lock with no reachable service cannot be taken over.
	if !st.Known && !st.ServiceRunning && !controllerLockFree(d.profile) {
		return nil, errors.New(st.Message)
	}
	if err = ctx.Err(); err != nil {
		return nil, err
	}
	var launchID string
	if !st.ServiceRunning {
		launchID = randomToken()
		if err = startControllerExecutable(d.config, d.executable, "CAGE_DESKTOP_START_ID="+launchID); err != nil {
			return nil, err
		}
		defer func() {
			if returned != nil {
				d.releaseFailedLaunch(launchID)
			}
		}()
	}
	bootstrap, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()
	for {
		c, err := openController(d.profile)
		if err == nil {
			view, probeErr := c.localControl(bootstrap, "status", desktopLocalRequest{})
			if probeErr == nil {
				defer c.close()
				if st.ControllerID != "" && view.ControllerID != st.ControllerID {
					return nil, errors.New("Локальная фоновая служба изменилась; выберите заново")
				}
				life := ctx
				if launchID != "" && view.LaunchID == launchID {
					life = context.WithValue(ctx, localLaunchKey{}, launchID)
				}
				session, err := d.localSession(life, bootstrap, c, view)
				if err == nil && launchID != "" && view.LaunchID == launchID {
					d.mu.Lock()
					d.ownedLaunch = launchID
					d.mu.Unlock()
				}
				return session, err
			}
			c.close()
			if launchID == "" {
				return nil, probeErr
			}
		} else if launchID == "" && !errors.Is(err, errControllerUnavailable) {
			return nil, err
		}
		select {
		case <-bootstrap.Done():
			return nil, errors.New("Не удалось подключиться к локальной службе управления; проверьте состояние этого компьютера")
		case <-time.After(100 * time.Millisecond):
		}
	}
}

type localLaunchKey struct{}

// Automatic release is limited to a controller started by this gateway.
// A standalone cage serve may be idle between requests and still have other callers.
func (d *desktopLocal) ReleaseOwnedIdle(ctx context.Context, expected DesktopLocalStatus) (bool, error) {
	d.mu.Lock()
	id := d.ownedLaunch
	d.mu.Unlock()
	if id == "" {
		return false, nil
	}
	c, err := openController(d.profile)
	if err != nil {
		return false, err
	}
	defer c.close()
	view, err := c.localControl(ctx, "status", desktopLocalRequest{})
	if err != nil {
		return false, err
	}
	if view.LaunchID != id {
		return false, nil
	}
	if !expected.Known || !view.Known || view.ControllerID != expected.ControllerID || view.Busy || view.Running || view.LiveTerminals > 0 {
		return false, errors.New("Состояние локальной фоновой службы или задачи изменилось; подтвердите заново")
	}
	if err := d.Release(ctx, expected, false); err != nil {
		return false, err
	}
	return true, nil
}

// ReleaseUnused handles a prepared local view that the user never entered.
// A previous controller, including an idle one, belongs to its original owner.
func (d *desktopLocal) ReleaseUnused(ctx context.Context, session *remotehost.Session) error {
	if session == nil || session.Context == nil {
		return nil
	}
	id, _ := session.Context.Value(localLaunchKey{}).(string)
	if id == "" {
		return nil
	}
	c, err := openController(d.profile)
	if errors.Is(err, errControllerUnavailable) {
		return nil
	}
	if err != nil {
		return err
	}
	defer c.close()
	view, err := c.localControl(ctx, "status", desktopLocalRequest{})
	if err != nil {
		return err
	}
	if view.LaunchID != id || !view.Known || view.Busy || view.Running || view.LiveTerminals > 0 {
		return nil
	}
	return d.Release(ctx, view.DesktopLocalStatus, false)
}

// The process started for a cancelled handshake may publish its record after
// cancellation. Only hand off a controller bearing this launcher's own nonce.
func (d *desktopLocal) releaseFailedLaunch(id string) {
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()
	for ctx.Err() == nil {
		c, err := openController(d.profile)
		if err == nil {
			view, err := c.localControl(ctx, "status", desktopLocalRequest{})
			c.close()
			if err == nil {
				if view.LaunchID == id && view.Known && !view.Busy && !view.Running && view.LiveTerminals == 0 {
					_ = d.Release(ctx, view.DesktopLocalStatus, false)
				}
				return
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(150 * time.Millisecond):
		}
	}
}

func (d *desktopLocal) localSession(life, bootstrap context.Context, c *controllerClient, view desktopLocalReply) (*remotehost.Session, error) {
	var launch launchResponse
	status, err := c.callContext(bootstrap, "POST", "/api/launch", map[string]string{"token": c.record.Token}, &launch)
	if err != nil || status != http.StatusOK || launch.Controller != view.Identity {
		return nil, errors.New("Идентичность локальной фоновой службы изменилась; выберите заново")
	}
	u, err := url.Parse(launch.URL)
	if err != nil || u.Scheme+"://"+u.Host != c.origin || u.User != nil || u.Fragment == "" {
		return nil, errors.New("Неверная точка входа локального подключения")
	}
	status, err = c.callContext(bootstrap, "POST", "/api/session", map[string]string{"token": u.Fragment}, nil)
	if err != nil || status != http.StatusOK {
		return nil, errors.New("Не удалось проверить подлинность локального сеанса")
	}
	var m RemoteEntry
	status, err = c.callContext(bootstrap, "GET", "/api/remote/manifest", nil, &m)
	if err != nil || status != http.StatusOK || m.InstanceID != view.InstanceID || m.APIProtocol != remoteAPIProtocol || m.Origin != c.origin || m.Platform != runtime.GOOS {
		return nil, errors.New("Версия локальной рабочей среды или идентичность среды не совпадают")
	}
	manifest := remotehost.PublicManifest{APIProtocol: m.APIProtocol, InstanceID: m.InstanceID, Version: m.Version, Platform: m.Platform, Runtime: m.Runtime, Capabilities: m.Capabilities}
	c.client.Jar.SetCookies(u, []*http.Cookie{{
		Name:  cookieName + "_" + u.Port() + "-desktop",
		Value: trustedViewProof(c.record.Token), Path: "/", HttpOnly: true, SameSite: http.SameSiteStrictMode,
	}})
	return remotehost.LocalSession(life, c.origin, manifest, c.client.Jar)
}

func (d *desktopLocal) Release(ctx context.Context, expected DesktopLocalStatus, stop bool) error {
	if !expected.Known || !expected.ServiceRunning || expected.ControllerID == "" {
		return errors.New("Сначала подтвердите идентичность локальной службы управления")
	}
	c, err := openController(d.profile)
	if err != nil {
		return errors.New("Локальная служба управления изменилась; обновите и повторите")
	}
	defer c.close()
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	request := desktopLocalRequest{ControllerID: expected.ControllerID, Stop: stop, Running: expected.Running, Terminals: expected.LiveTerminals}
	reply, err := c.localControl(ctx, "release", request)
	if err != nil {
		return err
	}
	if reply.JobRunning {
		jobID := reply.JobID
		if jobID == "" || !stop {
			return errors.New("Неверная идентичность локальной задачи остановки")
		}
		for {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(150 * time.Millisecond):
			}
			view, err := c.localControl(ctx, "status", desktopLocalRequest{})
			if err != nil {
				return err
			}
			if view.JobID != jobID || view.JobFailed {
				return errors.New("Локальная задача остановки изменилась или завершилась ошибкой; вернитесь на этот компьютер и проверьте состояние")
			}
			if view.JobRunning {
				continue
			}
			if !view.Known || view.Busy || view.Running || view.LiveTerminals != 0 {
				return errors.New("Работа на этом компьютере ещё не полностью остановлена")
			}
			_, err = c.localControl(ctx, "release", desktopLocalRequest{ControllerID: view.ControllerID, JobID: jobID})
			if err != nil {
				return err
			}
			break
		}
	}
	if err = c.waitForExit(); err != nil {
		return err
	}
	for processExists(c.record.PID) {
		select {
		case <-ctx.Done():
			return errors.New("Процесс локального управления всё ещё работает")
		case <-time.After(75 * time.Millisecond):
		}
	}
	// Unlike a cold selector probe, this explicit release may query an existing
	// local container engine to verify that its workload actually stopped.
	if _, err := os.Lstat(filepath.Join(d.profile, "control.json")); !os.IsNotExist(err) || !controllerLockFree(d.profile) {
		return errors.New("Состояние локальной службы управления изменилось; подтвердите заново")
	}
	if running, err := controllerVMState(d.profile); err != nil || running || managedproxy.ConfirmStopped(ctx, d.profile) != nil {
		return errors.New("Состояние локальных ресурсов требует подтверждения")
	}
	return nil
}
