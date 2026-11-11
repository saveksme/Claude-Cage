package workbench

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
)

type claudeSwitchInput struct {
	Action    string `json:"action"`
	Policy    string `json:"policy"`
	Target    string `json:"target"`
	RequestID string `json:"request_id"`
	SourceID  string `json:"source_id"`
	Confirm   bool   `json:"confirm"`
	Continue  bool   `json:"continue"`
}

type claudeSwitchOption struct {
	ID    string `json:"id"`
	Label string `json:"label"`
}

func validSwitchPolicy(policy string) bool {
	return policy == "ask" || policy == "allow" || policy == "wait"
}

// Explicit groups prevent a work transcript from silently moving to a personal
// identity. Empty groups never authorize a cross-account transfer.
func switchCandidates(list claudeAccountList, record *mobileRecord) []claudeSwitchOption {
	options := []claudeSwitchOption{}
	source := list.find(record.Account.ID)
	if source == nil || source.HandoffGroup == "" || source.guestID() != record.Account.GuestID || claudeIdentityHash(source.Email, source.Organization) != record.Account.Subject {
		return options
	}
	for _, a := range list.Accounts {
		_, available := a.headroom(time.Now())
		if a.ID != source.ID && a.Enabled && a.Status == "ready" && a.HandoffGroup == source.HandoffGroup && available {
			options = append(options, claudeSwitchOption{a.ID, a.Label})
		}
	}
	return options
}

func (s *Server) mobileSessionAccount(w http.ResponseWriter, r *http.Request) {
	view, terminal, ok := s.authorizedMobileSessionRecord(w, r)
	if !ok {
		return
	}
	var input claudeSwitchInput
	if !readJSON(w, r, &input) {
		return
	}
	if input.Action == "switch" {
		if !input.Confirm || !mobileID(input.RequestID) || !validCLIUUID(input.SourceID) {
			http.Error(w, "Подтвердите продолжение аккаунта и укажите идентификатор текущего сеанса", 400)
			return
		}
		if err := s.switchClaudeAccount(r.Context(), view.ID, input, false); err != nil {
			http.Error(w, err.Error(), 409)
			return
		}
	} else if input.Action == "cancel" {
		if err := s.cancelClaudeSwitch(r.Context(), view.ID, input.RequestID); err != nil {
			http.Error(w, err.Error(), 409)
			return
		}
	} else if input.Action == "policy" {
		if !validSwitchPolicy(input.Policy) {
			http.Error(w, "Неверная авторизация переключения", 400)
			return
		}
		if !s.op.TryLock() {
			http.Error(w, errTerminalBusy.Error(), 409)
			return
		}
		defer s.op.Unlock()
		s.account.mu.Lock()
		if !s.mobileAuthorized(r.Context()) {
			s.account.mu.Unlock()
			http.Error(w, errMobileLocked.Error(), 423)
			return
		}
		s.mobileCLI.mu.Lock()
		record, err := s.mobileCLI.record(s.profile, view.ID)
		if err == nil {
			if record.Switch != nil && record.Switch.Phase != "completed" {
				err = errors.New("Идёт передача аккаунта; дождитесь завершения, затем меняйте авторизацию")
			} else {
				record.SwitchPolicy = input.Policy
				record.changed()
				err = writePrivate(mobileRecordPath(s.profile, view.ID), record)
			}
		}
		s.mobileCLI.mu.Unlock()
		s.account.mu.Unlock()
		if err != nil {
			requestError(w, err)
			return
		}
	} else if input.Action != "inspect" {
		http.Error(w, "Неизвестная операция с аккаунтом", 400)
		return
	}
	if terminal {
		if _, err := s.terminalConversationView(r.Context(), view.ID); err != nil && input.Action != "inspect" {
			http.Error(w, err.Error(), 503)
			return
		}
	}
	s.claudeAccounts.mu.Lock()
	list, err := s.loadClaudeAccounts()
	s.claudeAccounts.mu.Unlock()
	if err != nil {
		requestError(w, err)
		return
	}
	s.mobileCLI.mu.Lock()
	record, err := s.mobileCLI.record(s.profile, view.ID)
	if err != nil {
		s.mobileCLI.mu.Unlock()
		requestError(w, err)
		return
	}
	if a := list.find(record.Account.ID); a != nil {
		record.AccountLabel = a.Label
	}
	snapshot := record.snapshot()
	policy := record.SwitchPolicy
	if policy == "" {
		policy = list.Scheduling.SwitchPolicy
	}
	sourceID := record.CLIID
	options := switchCandidates(list, record)
	supported := record.Terminal && record.Launcher == "claude" && record.Account.ID != ""
	s.mobileCLI.mu.Unlock()
	jsonReply(w, map[string]any{"session": snapshot, "source_id": sourceID, "switch_policy": policy, "candidates": options, "supported": supported})
}

func (s *Server) switchClaudeAccount(ctx context.Context, id string, input claudeSwitchInput, automatic bool) error {
	if !s.op.TryLock() {
		return errTerminalBusy
	}
	defer s.op.Unlock()
	s.conversationMu.Lock()
	defer s.conversationMu.Unlock()
	s.account.mu.Lock()
	allowed := s.mobileAuthorized(ctx)
	s.account.mu.Unlock()
	if !allowed {
		return errMobileLocked
	}
	s.mu.Lock()
	ready := s.ready && !s.closing && !s.guestUpdateRequired && claudeTerminalCommand(s.preferences) == "claude"
	s.mu.Unlock()
	if !ready {
		return errTerminalNotReady
	}
	s.claudeAccounts.mu.Lock()
	list, err := s.loadClaudeAccounts()
	s.claudeAccounts.mu.Unlock()
	if err != nil {
		return err
	}
	m := &s.mobileCLI
	m.mu.Lock()
	record, err := m.record(s.profile, id)
	m.mu.Unlock()
	if err != nil {
		return err
	}
	if record.Archived || record.Deleted || !record.Terminal || record.Launcher != "claude" {
		return errors.New("Этот сеанс не поддерживает продолжение аккаунта")
	}
	if sw := record.Switch; sw != nil && sw.ID == input.RequestID && sw.Phase == "completed" {
		return nil
	}
	if record.Switch != nil && record.Switch.Phase != "completed" && record.Switch.ID != input.RequestID {
		return errors.New("Есть незавершённая передача аккаунта; повторите исходное действие")
	}
	if input.SourceID != record.CLIID && (record.Switch == nil || record.Switch.ID != input.RequestID || record.Switch.Source.CLIID != input.SourceID) {
		return errors.New("Аккаунт сеанса изменился; обновите и подтвердите")
	}
	if record.Switch == nil || record.Switch.ID != input.RequestID {
		if automatic {
			policy := record.SwitchPolicy
			if policy == "" {
				policy = list.Scheduling.SwitchPolicy
			}
			a := list.find(record.Account.ID)
			if policy != "allow" || record.AccountFailure != "rate_limit" || a == nil {
				return errors.New("Текущий сеанс требует ручного подтверждения переключения")
			}
			if _, available := a.headroom(time.Now()); available {
				return errors.New("Исчерпание квоты подписки не подтверждено, исходный аккаунт сохранён")
			}
		}
		found := false
		for _, option := range switchCandidates(list, record) {
			if option.ID == input.Target {
				found = true
			}
		}
		if !found {
			return errors.New("Целевой аккаунт недоступен; назначьте аккаунтам, которым разрешено продолжение, одну группу и проверьте квоту")
		}
		a := list.find(input.Target)
		selection := claudeSelection{ID: a.ID, GuestID: a.guestID(), Subject: claudeIdentityHash(a.Email, a.Organization)}
		// Check the official CLI identity before stopping any existing work.
		status, probeErr := s.probeClaude(ctx, selection.GuestID)
		if probeErr != nil || status.subject() != selection.Subject {
			return errors.New("Не удалось подтвердить вход целевого аккаунта; сначала проверьте состояние аккаунта")
		}
		sourceStatus, sourceErr := s.probeClaude(ctx, record.Account.GuestID)
		if sourceErr != nil || sourceStatus.subject() != record.Account.Subject {
			return errors.New("Учётная запись исходного аккаунта изменилась; сначала проверьте вход исходного сеанса")
		}
		record.Switch = &claudeAccountSwitch{ID: input.RequestID, Phase: "preparing", Source: claudeExecution{record.CLIID, record.Account, record.GuestConfig}, Target: selection, TargetLabel: a.Label, TargetID: uuid.NewString(), Connection: record.Connection, Continue: input.Continue}
		if err := s.saveClaudeSwitch(record); err != nil {
			return err
		}
	}
	sw := record.Switch
	fail := func(err error) error { sw.Error = err.Error(); _ = s.saveClaudeSwitch(record); return err }
	if sw.Phase == "preparing" {
		// Authorization can be revoked or the target identity can change while
		// an interrupted preparation is waiting for a retry.
		target := list.find(sw.Target.ID)
		eligible := false
		for _, option := range switchCandidates(list, record) {
			eligible = eligible || option.ID == sw.Target.ID
		}
		if !eligible || target == nil || target.guestID() != sw.Target.GuestID || claudeIdentityHash(target.Email, target.Organization) != sw.Target.Subject {
			return fail(errors.New("Целевой аккаунт или группа продолжения изменились; отмените эту передачу и выберите заново"))
		}
		status, err := s.probeClaude(ctx, sw.Target.GuestID)
		if err != nil || status.subject() != sw.Target.Subject {
			return fail(errors.New("Вход целевого аккаунта изменился; отмените передачу и проверьте аккаунт"))
		}
		var result struct {
			Transcript string `json:"transcript"`
			Error      string `json:"error"`
		}
		if sw.Source.Config == "" || sw.Connection == "" {
			return fail(errors.New("Подключение исходного сеанса ещё не готово; сначала откройте исходный сеанс"))
		}
		query := map[string]any{"cli_id": sw.Source.CLIID, "config": sw.Source.Config, "connection": sw.Connection, "workspace": record.GuestWorkspace, "target_cli_id": sw.TargetID, "switch_id": sw.ID}
		if err := s.windowsConversationInput(record, query); err != nil {
			return fail(err)
		}
		err = s.runCLIChannel(ctx, "account-switch", query, &result)
		if err != nil {
			return fail(err)
		}
		if result.Error != "" {
			return fail(errors.New(result.Error))
		}
		if !strings.HasPrefix(result.Transcript, "/") && !(s.windowsGuest != nil && windowsCLIAbsolutePath(result.Transcript)) {
			return fail(errors.New("История исходного сеанса не подтверждена, целевой аккаунт не запущен"))
		}
		if old := s.terminals.get(record.TerminalID); old != nil {
			s.terminals.remove(old.id)
		}
		record.Executions = append(record.Executions, sw.Source)
		record.CLIID, record.Account, record.AccountLabel = sw.TargetID, sw.Target, sw.TargetLabel
		record.GuestConfig, record.Connection, record.TerminalID = "", "", ""
		record.Resume, record.TerminalRunning, record.Active = false, false, false
		record.ResumeTranscript = result.Transcript
		record.AccountFailure = ""
		sw.Phase, sw.Error = "prepared", ""
		if err := s.saveClaudeSwitch(record); err != nil {
			return err
		}
	}
	if sw.Phase == "prepared" {
		// Treat a previous launch with unknown HTTP outcome as owned until its
		// PTY or the guest registry proves otherwise. The connection UUID is
		// deterministic for this switch, and guest launch also rejects duplicates.
		var state struct {
			Running bool `json:"running"`
		}
		query := map[string]any{"cli_id": record.CLIID, "config": record.GuestConfig, "account": record.Account.GuestID}
		if err := s.windowsConversationInput(record, query); err != nil {
			return fail(err)
		}
		if err := s.runCLIChannel(ctx, "active", query, &state); err != nil {
			return fail(err)
		}
		if state.Running {
			sw.Phase = "starting"
			return s.saveClaudeSwitch(record)
		}
		status, err := s.probeClaude(ctx, record.Account.GuestID)
		if err != nil || status.subject() != record.Account.Subject {
			return fail(errors.New("Не удалось подтвердить учётную запись целевого аккаунта; история сохранена для восстановления"))
		}
		_, err = s.createTerminalLocked(terminalRequest{Workspace: record.Workspace, Kind: "claude", sharedID: id, requestContext: ctx})
		if err != nil {
			return fail(err)
		}
		// A launched process may outlive the HTTP request. Never launch it again
		// while its published PTY or guest registry can still own this execution.
		m.mu.Lock()
		latest, loadErr := m.record(s.profile, id)
		m.mu.Unlock()
		if loadErr != nil {
			return loadErr
		}
		record = latest
		record.Switch.Phase = "starting"
		if err := s.saveClaudeSwitch(record); err != nil {
			return err
		}
	}
	return nil
}

func (s *Server) cancelClaudeSwitch(ctx context.Context, id, requestID string) error {
	if !s.op.TryLock() {
		return errTerminalBusy
	}
	defer s.op.Unlock()
	s.conversationMu.Lock()
	defer s.conversationMu.Unlock()
	s.account.mu.Lock()
	allowed := s.mobileAuthorized(ctx)
	s.account.mu.Unlock()
	if !allowed {
		return errMobileLocked
	}
	s.mobileCLI.mu.Lock()
	record, err := s.mobileCLI.record(s.profile, id)
	s.mobileCLI.mu.Unlock()
	if err != nil {
		return err
	}
	if record.Switch == nil {
		return nil
	}
	sw := record.Switch
	if sw.ID != requestID || sw.Phase != "preparing" {
		return errors.New("Целевой аккаунт принял историю; продолжайте в текущем сеансе")
	}
	var response struct {
		OK    bool   `json:"ok"`
		Error string `json:"error"`
	}
	query := map[string]any{"cli_id": sw.Source.CLIID, "connection": sw.Connection, "switch_id": sw.ID}
	if err := s.windowsConversationInput(record, query); err != nil {
		return err
	}
	if err := s.runCLIChannel(ctx, "account-switch-cancel", query, &response); err != nil {
		return err
	}
	if !response.OK {
		return errors.New(response.Error)
	}
	record.Switch = nil
	return s.saveClaudeSwitch(record)
}

// Preserve metadata written concurrently while committing execution ownership.
func (s *Server) saveClaudeSwitch(record *mobileRecord) error {
	m := &s.mobileCLI
	m.mu.Lock()
	defer m.mu.Unlock()
	current, err := m.record(s.profile, record.ID)
	if err != nil {
		return err
	}
	record.CustomTitle, record.Pinned, record.Archived, record.Deleted = current.CustomTitle, current.Pinned, current.Archived, current.Deleted
	record.SwitchPolicy = current.SwitchPolicy
	record.Revision = current.Revision
	record.changed()
	return writePrivate(mobileRecordPath(s.profile, record.ID), record)
}

func (s *Server) monitorClaudeAccount(terminal *terminalSession, id string) {
	ctx, cancel := context.WithCancel(s.lifetimeContext())
	s.activities.Add(1)
	go func() {
		defer s.activities.Done()
		defer cancel()
		var lastUsageCheck time.Time
		ticker := time.NewTicker(10 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-terminal.done:
				return
			case <-ticker.C:
			}
			epoch, ok := s.account.access()
			if !ok {
				continue
			}
			// Locking pauses observation; unlocking resumes it for the same
			// terminal. Cancel an in-flight attempt if its access epoch ends.
			attempt, finish := context.WithCancel(context.WithValue(ctx, mobileEpochKey{}, epoch))
			stop := context.AfterFunc(epoch, finish)
			s.maybeSwitchClaudeAccount(attempt, id, &lastUsageCheck)
			stop()
			finish()
		}
	}()
}

func (s *Server) maybeSwitchClaudeAccount(ctx context.Context, id string, lastUsageCheck *time.Time) {
	view, err := s.terminalConversationView(ctx, id)
	if err != nil || view.AccountFailure != "rate_limit" || view.SwitchPolicy != "allow" || view.AccountSwitch != nil && view.AccountSwitch.Phase != "completed" {
		return
	}
	s.claudeAccounts.mu.Lock()
	list, err := s.loadClaudeAccounts()
	s.claudeAccounts.mu.Unlock()
	if err != nil {
		return
	}
	s.mobileCLI.mu.Lock()
	record, err := s.mobileCLI.record(s.profile, id)
	s.mobileCLI.mu.Unlock()
	if err != nil {
		return
	}
	options := switchCandidates(list, record)
	if len(options) == 0 {
		return
	}
	// One bounded quota refresh on the failure path. The CLI owns this
	// query and its tokens; no model prompt is generated for probing.
	if time.Since(*lastUsageCheck) >= claudeUsageInterval {
		*lastUsageCheck = time.Now()
		_ = s.refreshClaudeUsage(ctx, claudeAccountInput{Action: "refresh", ID: record.Account.ID})
	}
	// Apply the same scheduling mode to eligible handoff targets.
	candidates := claudeAccountList{Scheduling: list.Scheduling}
	for _, a := range list.Accounts {
		for _, option := range options {
			if option.ID == a.ID {
				candidates.Accounts = append(candidates.Accounts, a)
			}
		}
	}
	active := s.mobileCLI.activeAccounts()
	logins := make(map[string]bool)
	for _, terminal := range s.terminals.snapshot() {
		if terminal["closed"] == true {
			continue
		}
		account, _ := terminal["claude_account_id"].(string)
		if terminal["kind"] == "claude-login" {
			logins[account] = true
		} else {
			active[account]++
		}
	}
	s.claudeAccounts.mu.Lock()
	last := s.claudeAccounts.lastPick
	s.claudeAccounts.mu.Unlock()
	target := pickClaudeAccount(candidates, active, logins, last, "", time.Now())
	if target == "" {
		return
	}
	_ = s.switchClaudeAccount(ctx, id, claudeSwitchInput{RequestID: uuid.NewString(), SourceID: record.CLIID, Target: target, Continue: true}, true)
}
