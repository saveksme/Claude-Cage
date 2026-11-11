package containerenv

import (
	"errors"
	"strconv"
	"strings"
)

type MountPropagation struct {
	PrivateNamespace bool   `json:"private_namespace"`
	SharedGroup      uint64 `json:"shared_group,omitempty"`
	DetachedFromHost bool   `json:"detached_from_host"`
}

func (m MountPropagation) Ready() bool {
	return m.PrivateNamespace && m.DetachedFromHost && m.SharedGroup != 0
}

func rootMountPropagation(containerMounts, hostMounts string) (MountPropagation, error) {
	var root []string
	for _, line := range strings.Split(containerMounts, "\n") {
		fields := strings.Fields(line)
		if len(fields) > 6 && fields[4] == "/" {
			root = fields
			break
		}
	}
	if root == nil {
		return MountPropagation{}, errors.New("Не удалось проверить корневое монтирование контейнера")
	}
	result := MountPropagation{DetachedFromHost: true}
	for _, field := range root[6:] {
		if field == "-" {
			break
		}
		if strings.HasPrefix(field, "master:") || strings.HasPrefix(field, "propagate_from:") {
			return MountPropagation{}, errors.New("Корень контейнера всё ещё связан с внешним распространением монтирования")
		}
		if strings.HasPrefix(field, "shared:") {
			group, err := strconv.ParseUint(strings.TrimPrefix(field, "shared:"), 10, 64)
			if err != nil || group == 0 {
				return MountPropagation{}, errors.New("Недопустимая общая группа монтирования контейнера")
			}
			result.SharedGroup = group
		}
	}
	if result.SharedGroup != 0 {
		group := strconv.FormatUint(result.SharedGroup, 10)
		for _, line := range strings.Split(hostMounts, "\n") {
			fields := strings.Fields(line)
			if len(fields) < 7 {
				continue
			}
			for _, field := range fields[6:] {
				if field == "-" {
					break
				}
				if field == "shared:"+group || field == "master:"+group || field == "propagate_from:"+group {
					return MountPropagation{}, errors.New("Общая группа монтирования контейнера связана с хостом; подключение отклонено")
				}
			}
		}
	}
	return result, nil
}
