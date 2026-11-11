package workbench

import (
	"path"

	"al.essio.dev/pkg/shellescape"
)

const macCLIInstall = "/usr/local/libexec/cage-cli"

const macOSLegacyWorkspaceNotice = "Этот исторический сеанс по-прежнему использует исходный каталог гостевой системы, файлы остаются внутри виртуального Mac. Чтобы использовать рабочее пространство по умолчанию, общее с хостом, создайте новый сеанс из рабочего пространства по умолчанию."

// Only a persisted terminal already bound to the old default workspace keeps
// that directory. New sessions and other host projects use approved mounts.
func (s *Server) macOSLegacyWorkspace(record *mobileRecord) string {
	if s.macosGuest == nil || record == nil || !record.Terminal || record.Workspace != s.environmentDir() {
		return ""
	}
	root := path.Join("/Users", s.macosGuest.User, ".local/share/cage/workspace")
	if record.GuestWorkspace != path.Clean(record.GuestWorkspace) || !cliWorkspaceWithin(record.GuestWorkspace, root, false) {
		return ""
	}
	return root
}

func (s *Server) cliWorkspace(workspace string) string {
	if s.macosGuest == nil {
		return guestPath(workspace)
	}
	return macOSProjectPath(s.macosGuest.User, workspace)
}

func (s *Server) cliHelperCommand(mode, argument string) string {
	if s.macosGuest == nil {
		return cliChannelCommand(mode, argument)
	}
	return shellescape.QuoteCommand([]string{macCLIInstall + "/bin/python3", "-I", macCLIInstall + "/macos-cli.py", mode, argument})
}

func (s *Server) macOSClaudeLaunch(workspace, payload string) string {
	// The signed project helper rechecks the exact mount and its GUI user's
	// approval before granting the CLI a controlling terminal and that cwd.
	return "exec " + shellescape.QuoteCommand([]string{"/usr/local/libexec/cage-macos-terminal", "--claude", s.cliWorkspace(workspace), payload})
}
