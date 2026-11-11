package workbench

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"slices"
)

func (s *Server) removeProject(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Workspace string `json:"workspace"`
	}
	if !readJSON(w, r, &input) {
		return
	}
	if !s.op.TryLock() {
		http.Error(w, "Выполняется другое действие; подождите", http.StatusConflict)
		return
	}
	defer s.op.Unlock()
	s.mu.Lock()
	closing, ready, preferences := s.closing, s.ready, s.preferences
	s.mu.Unlock()
	if closing || s.busy() {
		http.Error(w, "Среда выполняет другое действие; повторите позже", http.StatusConflict)
		return
	}
	path := input.Workspace
	if path == "" || path == s.environmentDir() || isClientMountPath(path) {
		http.Error(w, "Выберите добавленный проект. Рабочее пространство по умолчанию сохраняется; для общего доступа клиента используйте остановку общего доступа.", http.StatusBadRequest)
		return
	}
	projects, err := s.projectPaths()
	if err != nil {
		requestError(w, err)
		return
	}
	if !slices.Contains(projects, path) {
		jsonReply(w, map[string]string{"workspace": s.workspace()})
		return
	}
	if !ready {
		running, err := controllerVMState(s.profile)
		if err != nil || running {
			http.Error(w, "Среда всё ещё работает или её состояние не удаётся подтвердить. Восстановите подключение либо сохраните работу и остановите среду, затем удаляйте проект.", http.StatusConflict)
			return
		}
	}
	for _, terminal := range s.terminals.snapshot() {
		if terminal["workspace"] == path && terminal["closed"] != true {
			http.Error(w, "Сначала закройте терминалы этого проекта, затем удаляйте проект. История сеансов сохранится.", http.StatusConflict)
			return
		}
	}
	if ready && sharedCLILauncher(claudeTerminalCommand(preferences)) {
		granted := make(map[string]bool, len(projects))
		for _, project := range projects {
			granted[project] = true
		}
		_, err = s.mobileCLI.summaries(s.profile, granted, false)
		if err == nil {
			err = s.discoverTerminalConversations(r.Context(), projects)
		}
		if err != nil {
			http.Error(w, "Пока не удалось проверить работающие сеансы. Восстановите подключение сеансов либо сохраните работу и остановите среду, затем удаляйте проект.", http.StatusConflict)
			return
		}
	}
	s.mobileCLI.mu.Lock()
	active := false
	for _, run := range s.mobileCLI.active {
		active = active || run.record.Workspace == path
	}
	for id, running := range s.mobileCLI.running {
		active = active || ready && running && s.mobileCLI.catalog[id].Workspace == path
	}
	s.mobileCLI.mu.Unlock()
	if active {
		http.Error(w, "Сначала завершите работающие сеансы этого проекта, затем удаляйте проект. История сеансов сохранится.", http.StatusConflict)
		return
	}
	if ready {
		body, err := s.browserAction(r.Context(), "tabs", nil)
		var browser struct {
			Tabs []struct {
				Kind      string `json:"kind"`
				Workspace string `json:"workspace"`
			} `json:"tabs"`
		}
		if err != nil || json.Unmarshal(body, &browser) != nil || browser.Tabs == nil {
			http.Error(w, "Пока не удалось проверить редактор файлов. Восстановите подключение браузера либо сохраните работу и остановите среду, затем удаляйте проект.", http.StatusConflict)
			return
		}
		for _, tab := range browser.Tabs {
			if tab.Kind == "editor" && tab.Workspace == path {
				http.Error(w, "Сначала сохраните файлы и закройте редактор этого проекта, затем удаляйте проект.", http.StatusConflict)
				return
			}
		}
	}
	var saved sharedProjects
	filename := filepath.Join(s.profile, "projects.json")
	data, err := os.ReadFile(filename)
	if err == nil {
		err = json.Unmarshal(data, &saved)
	}
	if err != nil && !os.IsNotExist(err) {
		requestError(w, err)
		return
	}
	if preferences.Workspace == path {
		// Preserve a legacy current grant before changing the selection. If a
		// later write fails, a retry can still find and remove this project.
		if !slices.Contains(saved.Paths, path) {
			saved.Paths = append(saved.Paths, path)
			if err = writePrivate(filename, saved); err != nil {
				requestError(w, err)
				return
			}
		}
		preferences.Workspace = s.environmentDir()
		if err = writePrivate(filepath.Join(s.profile, "workbench.json"), preferences); err != nil {
			requestError(w, err)
			return
		}
		s.mu.Lock()
		s.preferences.Workspace = preferences.Workspace
		s.mu.Unlock()
	}
	deleteProject := func(value string) bool { return value == path }
	saved.Paths = slices.DeleteFunc(saved.Paths, deleteProject)
	if err = writePrivate(filename, saved); err != nil {
		requestError(w, err)
		return
	}
	s.mu.Lock()
	share := s.projectShares[path]
	delete(s.projectShares, path)
	s.mu.Unlock()
	if share != nil {
		share.close()
	}
	s.setProjectError(path, nil)
	jsonReply(w, map[string]string{"workspace": s.workspace()})
}
