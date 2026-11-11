package cage

import (
	"errors"

	"golang.org/x/sys/unix"
)

func localStorageVolume(path string) error {
	var info unix.Statfs_t
	if err := unix.Statfs(path, &info); err != nil {
		return err
	}
	if info.Flags&unix.MNT_LOCAL == 0 {
		return errors.New("Для хранилища среды нужен локальный диск")
	}
	if unix.ByteSliceToString(info.Fstypename[:]) != "apfs" {
		return errors.New("Выберите локальный том APFS: среде нужны частные права доступа к файлам и поддержка разрежённых дисков")
	}
	if info.Flags&unix.MNT_IGNORE_OWNERSHIP != 0 {
		return errors.New("В окне Finder «Свойства» диска снимите флажок «Игнорировать владельцев этого тома» или выберите другой диск APFS")
	}
	return nil
}
