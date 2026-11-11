package containerenv

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

type State struct {
	Exists            bool   `json:"exists"`
	Running           bool   `json:"running"`
	Ready             bool   `json:"ready"`
	ContainerID       string `json:"container_id,omitempty"`
	PID               int    `json:"pid,omitempty"`
	MemoryBytes       int64  `json:"memory_bytes"`
	CPUs              int    `json:"cpus"`
	BrowserAddress    string `json:"browser_address,omitempty"`
	VNCAddress        string `json:"vnc_address,omitempty"`
	StoragePath       string `json:"storage_path,omitempty"`
	ResourcesVerified bool   `json:"resources_verified"`
	ResourceError     string `json:"resource_error,omitempty"`
	PIDs              int64  `json:"pids"`
	MountsReady       bool   `json:"mounts_ready"`
	MountError        string `json:"mount_error,omitempty"`
}

type Inspection struct {
	State              State            `json:"state"`
	Rootless           bool             `json:"rootless"`
	NetworkConfined    bool             `json:"network_confined"`
	FilesystemConfined bool             `json:"filesystem_confined"`
	Evidence           string           `json:"evidence"`
	MountPropagation   MountPropagation `json:"mount_propagation"`
}

type engineContainer struct {
	ID    string `json:"Id"`
	Image string `json:"Image"`
	State struct {
		Running bool
		Pid     int
	}
	Config struct {
		Labels map[string]string
		Image  string
	}
	HostConfig struct {
		Privileged   bool
		NetworkMode  string
		PidMode      string
		IpcMode      string
		CgroupnsMode string
		CgroupParent string
		UsernsMode   string
		Binds        []string
		ExtraHosts   []string
		CapAdd       []string
		Memory       int64
		NanoCpus     int64
		Devices      []struct {
			PathOnHost      string
			PathInContainer string
		}
	}
	Mounts []struct {
		Type        string
		Source      string
		Destination string
	}
}

func (r *Runtime) command(ctx context.Context, args ...string) *exec.Cmd {
	if r.config.Engine == "docker" {
		// Docker's normal client config can inject the user's proxy URLs and
		// credentials into new containers. Use a profile-private empty config.
		args = append([]string{"--config", filepath.Join(r.InstanceDir(), "client-config"), "--host", r.config.Socket}, args...)
	}
	command := exec.CommandContext(ctx, r.config.Executable, args...)
	for _, entry := range os.Environ() {
		name, _, _ := strings.Cut(entry, "=")
		switch name {
		case "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "CONTAINER_HOST", "CONTAINER_CONNECTION":
			continue
		}
		command.Env = append(command.Env, entry)
	}
	return command
}

func (r *Runtime) output(ctx context.Context, args ...string) ([]byte, error) {
	command := r.command(ctx, args...)
	var output, diagnostic bytes.Buffer
	command.Stdout = &limitedWriter{writer: &output, left: 1 << 20}
	command.Stderr = &limitedWriter{writer: &diagnostic, left: 4096}
	if err := command.Run(); err != nil {
		return nil, fmt.Errorf("Операция движка контейнеров не удалась: %w: %s", err, strings.TrimSpace(diagnostic.String()))
	}
	return output.Bytes(), nil
}

type limitedWriter struct {
	writer *bytes.Buffer
	left   int
}

func (w *limitedWriter) Write(data []byte) (int, error) {
	if len(data) > w.left {
		return 0, errors.New("container engine output limit exceeded")
	}
	n, err := w.writer.Write(data)
	w.left -= n
	return n, err
}

func (r *Runtime) inspectContainer(ctx context.Context) (*engineContainer, error) {
	// Query only this exact managed name. An empty result is absence, while
	// engine/permission failures remain errors rather than triggering creation.
	data, err := r.output(ctx, "container", "ls", "--all", "--filter", "label="+profileLabel+"="+r.identity, "--format", "{{.ID}}")
	if err != nil {
		return nil, err
	}
	id := strings.TrimSpace(string(data))
	if id == "" {
		return nil, nil
	}
	if strings.ContainsAny(id, " \r\n\t") {
		return nil, errors.New("Идентификатор контейнера неоднозначен")
	}
	data, err = r.output(ctx, "container", "inspect", id)
	if err != nil {
		return nil, err
	}
	var found []engineContainer
	if json.Unmarshal(data, &found) != nil || len(found) != 1 || found[0].Config.Labels[profileLabel] != r.identity {
		return nil, errors.New("Идентичность контейнера не соответствует текущей конфигурации Cage")
	}
	return &found[0], nil
}

func (r *Runtime) State(ctx context.Context) (State, error) {
	container, err := r.inspectContainer(ctx)
	if err != nil {
		return State{}, err
	}
	if container == nil {
		storage, err := r.StoragePath(ctx)
		return State{CPUs: r.config.CPUs, MemoryBytes: r.config.MemoryBytes, StoragePath: storage}, err
	}
	state := State{Exists: true, Running: container.State.Running, ContainerID: container.ID, PID: container.State.Pid, MemoryBytes: container.HostConfig.Memory, CPUs: int(container.HostConfig.NanoCpus / 1e9)}
	state.StoragePath, err = r.StoragePath(ctx)
	if err != nil {
		return State{}, err
	}
	if state.Running {
		mounts, mountErr := r.inspectMounts(container)
		if mountErr != nil {
			state.MountError = mountErr.Error()
		} else {
			state.MountsReady = mounts.Ready()
		}
		resources, resourceErr := r.verifyResources(ctx, container.ID)
		if resourceErr != nil {
			state.MemoryBytes = 0
			state.CPUs = 0
			state.ResourceError = resourceErr.Error()
		} else {
			state.MemoryBytes = resources.MemoryBytes
			state.CPUs = resources.CPUs
			state.PIDs = resources.PIDs
			state.ResourcesVerified = true
		}
		if record, err := r.networkState(ctx, container.ID); err == nil {
			state.Ready = state.ResourcesVerified && state.MountsReady
			state.BrowserAddress = record.BrowserAddress
			state.VNCAddress = record.VNCAddress
		}
	}
	return state, nil
}

// StoragePath reports the engine's actual persistent storage location. An
// explicitly supplied rootless engine may already store data outside the
// profile; this path is never treated as disposable or removed by Cage.
func (r *Runtime) StoragePath(ctx context.Context) (string, error) {
	format := "{{.DockerRootDir}}"
	if r.config.Engine == "podman" {
		format = "{{.Store.GraphRoot}}"
	}
	data, err := r.output(ctx, "info", "--format", format)
	if err != nil {
		return "", err
	}
	path := strings.TrimSpace(string(data))
	if !filepath.IsAbs(path) || strings.ContainsAny(path, "\x00\r\n") {
		return "", errors.New("Недопустимое расположение постоянного хранилища контейнера")
	}
	return path, nil
}

func (r *Runtime) rootlessEngine(ctx context.Context) (bool, error) {
	rootless, limited, err := r.engineSecurity(ctx)
	if err != nil {
		return false, err
	}
	if !limited {
		return false, errors.New("Движок контейнеров должен использовать systemd и cgroup v2 для применения лимитов CPU, памяти и числа процессов")
	}
	return rootless, nil
}

// Shutdown still works if an engine loses its resource-controller support.
// Starting and inspecting enforce the stronger rootlessEngine precondition.
func (r *Runtime) engineSecurity(ctx context.Context) (rootless, limited bool, err error) {
	if r.config.Engine == "docker" {
		data, err := r.output(ctx, "info", "--format", "{{json .SecurityOptions}}\n{{.CgroupDriver}}\n{{.CgroupVersion}}")
		if err != nil {
			return false, false, err
		}
		var options []string
		lines := strings.Split(strings.TrimSpace(string(data)), "\n")
		if len(lines) != 3 || json.Unmarshal([]byte(lines[0]), &options) != nil {
			return false, false, errors.New("Не удалось подтвердить конфигурацию безопасности Docker")
		}
		limited = lines[1] == "systemd" && lines[2] == "2"
		for _, option := range options {
			if option == "name=rootless" || strings.HasPrefix(option, "name=rootless,") {
				return true, limited, nil
			}
		}
		return false, limited, nil
	}
	data, err := r.output(ctx, "info", "--format", "{{.Host.Security.Rootless}}\n{{.Host.CgroupManager}}\n{{.Host.CgroupVersion}}")
	if err != nil {
		return false, false, err
	}
	lines := strings.Split(strings.TrimSpace(string(data)), "\n")
	if len(lines) != 3 {
		return false, false, errors.New("Не удалось подтвердить конфигурацию безопасности Podman")
	}
	return lines[0] == "true", lines[1] == "systemd" && (lines[2] == "v2" || lines[2] == "2"), nil
}

func checkContainerConfiguration(container *engineContainer) error {
	config := container.HostConfig
	if config.Privileged || config.NetworkMode != "none" || (config.PidMode != "" && config.PidMode != "private") || config.IpcMode != "private" || config.CgroupnsMode != "private" {
		return errors.New("Контейнер должен использовать отдельные пространства имён и отключённую сеть по умолчанию; привилегированный режим недопустим")
	}
	if len(config.Binds) > 0 {
		return errors.New("Контейнер не может напрямую монтировать каталоги хоста")
	}
	for _, entry := range config.ExtraHosts {
		if entry != "cage:127.0.1.1" {
			return errors.New("Контейнеру разрешён только фиксированный адрес обратной петли для имени хоста Cage")
		}
	}
	for _, mount := range container.Mounts {
		if mount.Type == "bind" || mount.Type == "volume" {
			return errors.New("В контейнере есть монтирование без разрешения на общий доступ к файлам Cage")
		}
	}
	for _, device := range config.Devices {
		if (device.PathOnHost != "/dev/fuse" && device.PathOnHost != "/dev/net/tun") || device.PathOnHost != device.PathInContainer {
			return errors.New("В контейнере присутствуют лишние устройства хоста")
		}
	}
	for _, capability := range config.CapAdd {
		capability = strings.TrimPrefix(capability, "CAP_")
		if capability != "NET_ADMIN" && capability != "SYS_ADMIN" {
			return errors.New("В контейнере присутствуют лишние системные привилегии")
		}
	}
	return nil
}

func (r *Runtime) Inspect(ctx context.Context) (Inspection, error) {
	rootless, err := r.rootlessEngine(ctx)
	if err != nil {
		return Inspection{}, err
	}
	if !rootless {
		return Inspection{}, errors.New("Контейнер Cage должен работать на отдельном rootless-движке")
	}
	container, err := r.inspectContainer(ctx)
	if err != nil {
		return Inspection{}, err
	}
	if container == nil {
		return Inspection{Rootless: true}, nil
	}
	if err := checkContainerConfiguration(container); err != nil {
		return Inspection{}, err
	}
	if container.HostConfig.CgroupParent != r.resourceSlice() {
		return Inspection{}, errors.New("У существующего контейнера отсутствует граница ресурсов хоста из текущей конфигурации; исходные данные сохранены, запуск без ограничений отклонён")
	}
	state := State{Exists: true, Running: container.State.Running, ContainerID: container.ID, PID: container.State.Pid, MemoryBytes: container.HostConfig.Memory, CPUs: int(container.HostConfig.NanoCpus / 1e9)}
	state.StoragePath, err = r.StoragePath(ctx)
	if err != nil {
		return Inspection{}, err
	}
	result := Inspection{State: state, Rootless: true, Evidence: "rootless-движок; сеть по умолчанию и монтирование каталогов хоста отсутствуют; ожидается проверка сети и общего доступа к файлам"}
	if state.Running {
		mounts, err := r.inspectMounts(container)
		if err != nil {
			return Inspection{}, err
		}
		result.MountPropagation = mounts
		result.State.MountsReady = mounts.Ready()
		resources, err := r.verifyResources(ctx, container.ID)
		if err != nil {
			return Inspection{}, err
		}
		result.State.MemoryBytes = resources.MemoryBytes
		result.State.CPUs = resources.CPUs
		result.State.PIDs = resources.PIDs
		result.State.ResourcesVerified = true
		if record, err := r.networkState(ctx, container.ID); err == nil {
			result.State.Ready = mounts.Ready()
			result.State.BrowserAddress = record.BrowserAddress
			result.State.VNCAddress = record.VNCAddress
			result.NetworkConfined = true
			result.FilesystemConfined = mounts.Ready()
			result.Evidence = "Работающий rootless-контейнер не имеет сети по умолчанию и монтирования каталогов хоста; идентичность внешнего сетевого шлюза проверена, единственный канал TAP принимается хостом; проект по умолчанию опубликован через ограниченный SFTP, чтение и запись с обеих сторон проверены"
		}
	}
	return result, nil
}
