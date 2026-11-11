package workbench

import (
	"errors"
	"net/http"
)

func (s *Server) launch(w http.ResponseWriter, kind string, run func() error) {
	job, err := s.submitJob(kind, run)
	switch {
	case errors.Is(err, errJobsClosed):
		http.Error(w, "Фоновая служба обновляется; снова откройте Cage.", http.StatusServiceUnavailable)
	case errors.Is(err, errJobBusy):
		http.Error(w, "Выполняется другое действие; подождите", http.StatusConflict)
	case err != nil:
		requestError(w, err)
	default:
		jsonReply(w, job)
	}
}
