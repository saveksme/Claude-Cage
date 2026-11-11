package workbench

import (
	"context"
	_ "embed"
	"errors"
	"strings"
	"time"
)

//go:embed macos_extension_probe.pl
var macOSProbeFSKit string

func (s *Server) checkMacOSSetupProjects(parent context.Context) error {
	ctx, cancel := context.WithTimeout(parent, 15*time.Second)
	defer cancel()
	cmd := s.macOSSSHCommand(ctx, "-T", s.sshTarget(), "--", "exec /usr/bin/perl -")
	cmd.Stdin = strings.NewReader(macOSProbeFSKit)
	err := cmd.Run()
	s.mu.Lock()
	if err != nil {
		s.macSetupProjectsChecked = time.Time{}
	} else {
		s.macSetupProjectsChecked = time.Now()
	}
	s.mu.Unlock()
	if err != nil {
		return errors.New("Права общего доступа к файлам ещё не предоставлены. Нажмите «Расширение файловой системы», снова откройте панель авторизации и убедитесь, что включены оба переключателя macFUSE и macFUSE (local); Cage проверит автоматически")
	}
	return nil
}
