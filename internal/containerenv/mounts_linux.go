//go:build linux

package containerenv

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// Read procfs from the host, not through a guest command or a guest-supplied
// path. Correlate the global PID with the exact engine container scope first.
func (r *Runtime) inspectMounts(container *engineContainer) (MountPropagation, error) {
	if !container.State.Running || container.State.Pid < 2 {
		return MountPropagation{}, nil
	}
	process := filepath.Join("/proc", strconv.Itoa(container.State.Pid))
	cgroups, err := os.ReadFile(filepath.Join(process, "cgroup"))
	if err != nil {
		return MountPropagation{}, err
	}
	prefix := "docker-"
	if r.config.Engine == "podman" {
		prefix = "libpod-"
	}
	scope := "/" + prefix + container.ID + ".scope"
	owned := false
	for _, line := range strings.Split(string(cgroups), "\n") {
		parts := strings.SplitN(line, ":", 3)
		if len(parts) == 3 && (strings.HasSuffix(parts[2], scope) || strings.Contains(parts[2], scope+"/")) {
			owned = true
		}
	}
	if !owned {
		return MountPropagation{}, errors.New("Не удалось сопоставить глобальную идентичность процесса контейнера; монтирования других процессов не читались")
	}
	for _, namespace := range []string{"mnt", "user"} {
		host, err := os.Readlink(filepath.Join("/proc/self/ns", namespace))
		if err != nil {
			return MountPropagation{}, err
		}
		guest, err := os.Readlink(filepath.Join(process, "ns", namespace))
		if err != nil {
			return MountPropagation{}, err
		}
		if host == guest {
			return MountPropagation{}, errors.New("Контейнер должен использовать отдельные пространства имён пользователей и монтирования")
		}
	}
	mounts, err := os.ReadFile(filepath.Join(process, "mountinfo"))
	if err != nil {
		return MountPropagation{}, err
	}
	hostMounts, err := os.ReadFile("/proc/self/mountinfo")
	if err != nil {
		return MountPropagation{}, err
	}
	result, err := rootMountPropagation(string(mounts), string(hostMounts))
	if err != nil {
		return MountPropagation{}, err
	}
	result.PrivateNamespace = true
	return result, nil
}

// Called only after this Start booted a stopped container, before any project
// share or Cage application is started. Detach inherited propagation first,
// then establish a new group entirely inside the private container namespace.
func (r *Runtime) initializeMounts(ctx context.Context, containerID string) error {
	container, err := r.inspectContainer(ctx)
	if err != nil {
		return err
	}
	if container == nil || container.ID != containerID || !container.State.Running {
		return errors.New("Идентичность запуска контейнера изменилась")
	}
	if _, err := r.inspectMounts(container); err != nil {
		return err
	}
	if _, err := r.output(ctx, "exec", "--user", "0", containerID, "/bin/sh", "-c", "set -eu; mount --make-rprivate /; mount --make-rshared /"); err != nil {
		return err
	}
	state, err := r.inspectMounts(container)
	if err != nil {
		return err
	}
	if !state.Ready() {
		return errors.New("Не удалось инициализировать распространение монтирования проекта в контейнере")
	}
	return nil
}
