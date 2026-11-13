package main

import (
	"encoding/json"
	"errors"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"nexo.local/agent/internal/vpnruntime"
)

const testOperationType = "test.operation"

func TestExecuteOperationWithJournalStoresStartedBeforeExecuting(t *testing.T) {
	dir := t.TempDir()
	id, revision := "op-started", int64(1)
	path := operationJournalPath(dir, id)
	executed := 0
	result, replayed, err := executeOperationWithJournal(dir, id, revision, testOperationType, func() operationResult {
		executed++
		entry, exists, loadErr := loadOperationJournalEntry(path)
		if loadErr != nil {
			t.Fatalf("load started marker: %v", loadErr)
		}
		if !exists || entry.State != operationJournalStarted {
			t.Fatalf("operation executed without a durable started marker: %#v", entry)
		}
		return operationResult{Status: "succeeded", Revision: revision, ObservedAt: "2026-11-12T00:00:00Z", Result: map[string]any{"ok": true}}
	}, writeOperationJournalEntryAtomic)
	if err != nil {
		t.Fatal(err)
	}
	if executed != 1 || replayed {
		t.Fatalf("unexpected execution/replay flags: executed=%d replayed=%v", executed, replayed)
	}
	if result.Status != "succeeded" {
		t.Fatalf("unexpected result: %#v", result)
	}
	entry, exists, err := loadOperationJournalEntry(path)
	if err != nil || !exists {
		t.Fatalf("final journal missing: %v %v", exists, err)
	}
	if entry.State != operationJournalFinal || entry.Result == nil || entry.Result.Status != "succeeded" {
		t.Fatalf("final journal was not persisted: %#v", entry)
	}
}

func TestExecuteOperationWithJournalReplaysStartedAsIndeterminate(t *testing.T) {
	dir := t.TempDir()
	id, revision := "op-crash", int64(7)
	path := operationJournalPath(dir, id)
	if err := writeOperationJournalEntryAtomic(path, operationJournalEntry{
		ID: id, Revision: revision, State: operationJournalStarted, UpdatedAt: "2026-11-12T00:00:00Z",
	}); err != nil {
		t.Fatal(err)
	}
	executed := 0
	result, replayed, err := executeOperationWithJournal(dir, id, revision, testOperationType, func() operationResult {
		executed++
		return operationResult{Status: "succeeded", Revision: revision}
	}, writeOperationJournalEntryAtomic)
	if err != nil {
		t.Fatal(err)
	}
	if !replayed || executed != 0 {
		t.Fatalf("started marker was re-executed: replayed=%v executed=%d", replayed, executed)
	}
	if result.Status != "failed" || result.Result["code"] != "operation_outcome_unknown" || result.Revision != revision {
		t.Fatalf("indeterminate result was not stored truthfully: %#v", result)
	}
	if _, exists := result.Result["revoked"]; exists {
		t.Fatalf("indeterminate result claimed revocation: %#v", result.Result)
	}
	if _, exists := result.Result["disconnect_requested"]; exists {
		t.Fatalf("indeterminate result claimed disconnect: %#v", result.Result)
	}
	entry, exists, err := loadOperationJournalEntry(path)
	if err != nil || !exists {
		t.Fatalf("final journal missing: %v %v", exists, err)
	}
	if entry.State != operationJournalFinal || entry.Result == nil || entry.Result.Result["code"] != "operation_outcome_unknown" {
		t.Fatalf("indeterminate result was not persisted as final: %#v", entry)
	}
}

func TestExecuteOperationWithJournalDoesNotExecuteWhenStartedMarkerFails(t *testing.T) {
	dir := t.TempDir()
	executed := 0
	result, replayed, err := executeOperationWithJournal(dir, "op-no-marker", 3, testOperationType, func() operationResult {
		executed++
		return operationResult{Status: "succeeded", Revision: 3}
	}, func(string, operationJournalEntry) error {
		return errors.New("injected journal write failure")
	})
	if err == nil || replayed || executed != 0 {
		t.Fatalf("operation executed despite marker failure: err=%v replayed=%v executed=%d result=%#v", err, replayed, executed, result)
	}
}

func TestExecuteOperationWithJournalPreservesStartedWhenFinalPersistFails(t *testing.T) {
	dir := t.TempDir()
	id, revision := "op-final-fail", int64(11)
	path := operationJournalPath(dir, id)
	executed := 0
	writes := 0
	persist := func(path string, entry operationJournalEntry) error {
		writes++
		if writes == 2 {
			return errors.New("injected final journal failure")
		}
		return writeOperationJournalEntryAtomic(path, entry)
	}
	result, replayed, err := executeOperationWithJournal(dir, id, revision, testOperationType, func() operationResult {
		executed++
		return operationResult{Status: "succeeded", Revision: revision}
	}, persist)
	if err == nil || replayed || executed != 1 || result.Status != "succeeded" {
		t.Fatalf("final persistence failure was not preserved: err=%v replayed=%v executed=%d result=%#v", err, replayed, executed, result)
	}
	entry, exists, loadErr := loadOperationJournalEntry(path)
	if loadErr != nil || !exists || entry.State != operationJournalStarted || entry.Result != nil {
		t.Fatalf("started marker was not preserved after final write failure: %#v %v %v", entry, exists, loadErr)
	}

	result, replayed, err = executeOperationWithJournal(dir, id, revision, testOperationType, func() operationResult {
		executed++
		return operationResult{Status: "succeeded", Revision: revision}
	}, writeOperationJournalEntryAtomic)
	if err != nil {
		t.Fatal(err)
	}
	if !replayed || executed != 1 || result.Status != "failed" || result.Result["code"] != "operation_outcome_unknown" {
		t.Fatalf("replay after final persistence failure executed again: replayed=%v executed=%d result=%#v", replayed, executed, result)
	}
}

func TestExecuteOperationWithJournalRevisionMismatchDoesNotExecute(t *testing.T) {
	dir := t.TempDir()
	id := "op-revision"
	path := operationJournalPath(dir, id)
	if err := writeOperationJournalEntryAtomic(path, operationJournalEntry{ID: id, Revision: 1, State: operationJournalStarted}); err != nil {
		t.Fatal(err)
	}
	executed := 0
	_, replayed, err := executeOperationWithJournal(dir, id, 2, testOperationType, func() operationResult {
		executed++
		return operationResult{Status: "succeeded", Revision: 2}
	}, writeOperationJournalEntryAtomic)
	if err == nil || replayed || executed != 0 {
		t.Fatalf("revision mismatch was re-executed: err=%v replayed=%v executed=%d", err, replayed, executed)
	}
}

func TestExecuteOperationWithJournalConcurrentCallsExecuteOnce(t *testing.T) {
	dir := t.TempDir()
	id, revision := "op-concurrent", int64(5)
	var executed atomic.Int32
	execute := func() operationResult {
		executed.Add(1)
		time.Sleep(20 * time.Millisecond)
		return operationResult{Status: "succeeded", Revision: revision}
	}
	var wait sync.WaitGroup
	results := make([]operationResult, 2)
	replays := make([]bool, 2)
	errs := make([]error, 2)
	for index := 0; index < 2; index++ {
		wait.Add(1)
		go func(index int) {
			defer wait.Done()
			results[index], replays[index], errs[index] = executeOperationWithJournal(dir, id, revision, testOperationType, execute, writeOperationJournalEntryAtomic)
		}(index)
	}
	wait.Wait()
	if executed.Load() != 1 {
		t.Fatalf("concurrent journal calls executed %d times", executed.Load())
	}
	replayedCount := 0
	for index := 0; index < 2; index++ {
		if errs[index] != nil {
			t.Fatalf("concurrent call %d failed: %v", index, errs[index])
		}
		if results[index].Status != "succeeded" {
			t.Fatalf("concurrent call %d returned %#v", index, results[index])
		}
		if replays[index] {
			replayedCount++
		}
	}
	if replayedCount != 1 {
		t.Fatalf("expected exactly one replayed result, got %d", replayedCount)
	}
}

func TestExecuteOperationWithJournalMigratesLegacyCache(t *testing.T) {
	dir := t.TempDir()
	id, revision := "op-legacy", int64(4)
	legacy := map[string]operationResult{
		id: operationResult{Status: "succeeded", Revision: revision, ObservedAt: "2026-11-11T00:00:00Z", Result: map[string]any{"ok": true}},
	}
	raw, err := json.Marshal(legacy)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(legacyOperationResultsPath(dir), raw, 0600); err != nil {
		t.Fatal(err)
	}
	executed := 0
	result, replayed, err := executeOperationWithJournal(dir, id, revision, testOperationType, func() operationResult {
		executed++
		return operationResult{Status: "failed", Revision: revision}
	}, writeOperationJournalEntryAtomic)
	if err != nil {
		t.Fatal(err)
	}
	if !replayed || executed != 0 || result.Status != "succeeded" {
		t.Fatalf("legacy result was not replayed: replayed=%v executed=%d result=%#v", replayed, executed, result)
	}
	entry, exists, err := loadOperationJournalEntry(operationJournalPath(dir, id))
	if err != nil || !exists || entry.State != operationJournalFinal || entry.Result == nil || entry.Result.Status != "succeeded" {
		t.Fatalf("legacy result was not migrated as final: %#v %v %v", entry, exists, err)
	}
}

func TestLegacyRevocationWithoutManagementEvidenceBecomesUnknown(t *testing.T) {
	dir := t.TempDir()
	id, revision := "op-legacy-revoke-old", int64(3)
	legacy := map[string]operationResult{
		id: operationResult{
			Status:     "succeeded",
			Revision:   revision,
			ObservedAt: "2026-11-11T00:00:00Z",
			Result: map[string]any{
				"serial":  "aabbccdd",
				"revoked": true,
			},
		},
	}
	raw, err := json.Marshal(legacy)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(legacyOperationResultsPath(dir), raw, 0600); err != nil {
		t.Fatal(err)
	}
	executed := 0
	result, replayed, err := executeOperationWithJournal(dir, id, revision, revocationOperationType, func() operationResult {
		executed++
		return operationResult{Status: "succeeded", Revision: revision}
	}, writeOperationJournalEntryAtomic)
	if err != nil {
		t.Fatal(err)
	}
	if !replayed || executed != 0 {
		t.Fatalf("legacy revocation was re-executed: replayed=%v executed=%d", replayed, executed)
	}
	if result.Status != "failed" || result.Result["code"] != "operation_outcome_unknown" {
		t.Fatalf("legacy revocation was migrated as success: %#v", result)
	}
	if result.Result["serial"] != "aabbccdd" || result.Result["revoked"] != true {
		t.Fatalf("legacy factual fields were not preserved: %#v", result.Result)
	}
	for _, key := range []string{"management_command_sent", "management_accepted", "disconnect_confirmed", "accept_within_budget", "disconnect_within_budget"} {
		if _, exists := result.Result[key]; exists {
			t.Fatalf("legacy unknown result invented %q: %#v", key, result.Result)
		}
	}
	entry, exists, err := loadOperationJournalEntry(operationJournalPath(dir, id))
	if err != nil || !exists || entry.State != operationJournalFinal || entry.Result == nil || entry.Result.Result["code"] != "operation_outcome_unknown" {
		t.Fatalf("unknown migration was not persisted: %#v %v %v", entry, exists, err)
	}
}

func TestLegacyRevocationIncompleteEvidenceBecomesUnknown(t *testing.T) {
	dir := t.TempDir()
	id, revision := "op-legacy-revoke-over-sla", int64(6)
	legacy := map[string]operationResult{
		id: operationResult{
			Status:   "succeeded",
			Revision: revision,
			Result: map[string]any{
				"serial":                   "aabbccdd",
				"revoked":                  true,
				"management_command_sent":  true,
				"management_accepted":      true,
				"disconnect_confirmed":     true,
				"accept_within_budget":     true,
				"disconnect_within_budget": true,
				"timings": map[string]any{
					"accept_elapsed_ns":     int64(2*time.Second + time.Nanosecond),
					"disconnect_elapsed_ns": int64(6 * time.Second),
				},
			},
		},
	}
	raw, err := json.Marshal(legacy)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(legacyOperationResultsPath(dir), raw, 0600); err != nil {
		t.Fatal(err)
	}
	executed := 0
	result, replayed, err := executeOperationWithJournal(dir, id, revision, revocationOperationType, func() operationResult {
		executed++
		return operationResult{Status: "succeeded", Revision: revision}
	}, writeOperationJournalEntryAtomic)
	if err != nil {
		t.Fatal(err)
	}
	if !replayed || executed != 0 {
		t.Fatalf("invalid legacy evidence was re-executed: replayed=%v executed=%d", replayed, executed)
	}
	if result.Status != "failed" || result.Result["code"] != "operation_outcome_unknown" {
		t.Fatalf("invalid legacy evidence was accepted: %#v", result)
	}
}

func TestLegacyRevocationImplausibleTimingOrderBecomesUnknown(t *testing.T) {
	dir := t.TempDir()
	id, revision := "op-legacy-revoke-timing-order", int64(7)
	legacy := map[string]operationResult{
		id: operationResult{
			Status:   "succeeded",
			Revision: revision,
			Result: map[string]any{
				"serial":                   "aabbccdd",
				"revoked":                  true,
				"management_command_sent":  true,
				"management_accepted":      true,
				"disconnect_confirmed":     true,
				"accept_within_budget":     true,
				"disconnect_within_budget": true,
				"timings": map[string]any{
					"accept_elapsed_ns":     int64(1500 * time.Millisecond),
					"disconnect_elapsed_ns": int64(1000 * time.Millisecond),
				},
			},
		},
	}
	raw, err := json.Marshal(legacy)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(legacyOperationResultsPath(dir), raw, 0600); err != nil {
		t.Fatal(err)
	}
	executed := 0
	result, replayed, err := executeOperationWithJournal(dir, id, revision, revocationOperationType, func() operationResult {
		executed++
		return operationResult{Status: "succeeded", Revision: revision}
	}, writeOperationJournalEntryAtomic)
	if err != nil {
		t.Fatal(err)
	}
	if !replayed || executed != 0 {
		t.Fatalf("implausible legacy timing was re-executed: replayed=%v executed=%d", replayed, executed)
	}
	if result.Status != "failed" || result.Result["code"] != "operation_outcome_unknown" {
		t.Fatalf("implausible legacy timing was migrated as success: %#v", result)
	}
}

func TestLegacyRevocationSufficientEvidenceReplays(t *testing.T) {
	dir := t.TempDir()
	id, revision := "op-legacy-revoke-sufficient", int64(9)
	legacy := map[string]operationResult{
		id: operationResult{
			Status:   "succeeded",
			Revision: revision,
			Result: map[string]any{
				"serial":                   "aabbccdd",
				"revoked":                  true,
				"management_command_sent":  true,
				"management_accepted":      true,
				"disconnect_confirmed":     true,
				"accept_within_budget":     true,
				"disconnect_within_budget": true,
				"timings": map[string]any{
					"accept_elapsed_ns":     int64(1500 * time.Millisecond),
					"disconnect_elapsed_ns": int64(6 * time.Second),
				},
			},
		},
	}
	raw, err := json.Marshal(legacy)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(legacyOperationResultsPath(dir), raw, 0600); err != nil {
		t.Fatal(err)
	}
	executed := 0
	result, replayed, err := executeOperationWithJournal(dir, id, revision, revocationOperationType, func() operationResult {
		executed++
		return operationResult{Status: "failed", Revision: revision}
	}, writeOperationJournalEntryAtomic)
	if err != nil {
		t.Fatal(err)
	}
	if !replayed || executed != 0 || result.Status != "succeeded" {
		t.Fatalf("sufficient legacy evidence was not replayed: replayed=%v executed=%d result=%#v", replayed, executed, result)
	}
	entry, exists, err := loadOperationJournalEntry(operationJournalPath(dir, id))
	if err != nil || !exists || entry.State != operationJournalFinal || entry.Result == nil || entry.Result.Status != "succeeded" {
		t.Fatalf("sufficient legacy evidence was not migrated as final: %#v %v %v", entry, exists, err)
	}
}

func TestJournalRevocationSucceededWithoutEvidenceBecomesUnknown(t *testing.T) {
	dir := t.TempDir()
	id, revision := "op-journal-old-success", int64(8)
	old := operationResult{
		Status:   "succeeded",
		Revision: revision,
		Result: map[string]any{
			"serial":  "aabbccdd",
			"revoked": true,
		},
	}
	if err := writeOperationJournalEntryAtomic(operationJournalPath(dir, id), operationJournalEntry{
		ID: id, Revision: revision, State: operationJournalFinal, Result: &old,
	}); err != nil {
		t.Fatal(err)
	}
	executed := 0
	result, replayed, err := executeOperationWithJournal(dir, id, revision, revocationOperationType, func() operationResult {
		executed++
		return operationResult{Status: "succeeded", Revision: revision}
	}, writeOperationJournalEntryAtomic)
	if err != nil {
		t.Fatal(err)
	}
	if !replayed || executed != 0 {
		t.Fatalf("old journal success was re-executed: replayed=%v executed=%d", replayed, executed)
	}
	if result.Status != "failed" || result.Result["code"] != "operation_outcome_unknown" {
		t.Fatalf("old journal success was replayed as PASS: %#v", result)
	}
}

func TestExecuteOperationWithJournalCorruptLegacyCacheDoesNotExecute(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(legacyOperationResultsPath(dir), []byte("{not-json"), 0600); err != nil {
		t.Fatal(err)
	}
	executed := 0
	_, replayed, err := executeOperationWithJournal(dir, "op-legacy-corrupt", 1, testOperationType, func() operationResult {
		executed++
		return operationResult{Status: "succeeded", Revision: 1}
	}, writeOperationJournalEntryAtomic)
	if err == nil || replayed || executed != 0 {
		t.Fatalf("corrupt legacy cache was executed: err=%v replayed=%v executed=%d", err, replayed, executed)
	}
}

func TestExecuteOperationWithJournalLegacyRevisionMismatchDoesNotExecute(t *testing.T) {
	dir := t.TempDir()
	id := "op-legacy-revision"
	legacy := map[string]operationResult{
		id: operationResult{Status: "succeeded", Revision: 1},
	}
	raw, err := json.Marshal(legacy)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(legacyOperationResultsPath(dir), raw, 0600); err != nil {
		t.Fatal(err)
	}
	executed := 0
	_, replayed, err := executeOperationWithJournal(dir, id, 2, testOperationType, func() operationResult {
		executed++
		return operationResult{Status: "succeeded", Revision: 2}
	}, writeOperationJournalEntryAtomic)
	if err == nil || replayed || executed != 0 {
		t.Fatalf("legacy revision mismatch was re-executed: err=%v replayed=%v executed=%d", err, replayed, executed)
	}
}

// TestOperationJournalLockExcludesSecondHandle exercises two separate handles
// in one process. Cross-process exclusion is covered by
// TestOperationJournalLockExcludesProcess on Unix.
func TestOperationJournalLockExcludesSecondHandle(t *testing.T) {
	dir := t.TempDir()
	release, err := acquireOperationJournalLock(dir)
	if err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{})
	acquired := make(chan struct{})
	go func() {
		close(started)
		secondRelease, acquireErr := acquireOperationJournalLock(dir)
		if acquireErr != nil {
			return
		}
		close(acquired)
		_ = secondRelease()
	}()
	<-started
	select {
	case <-acquired:
		t.Fatal("second journal lock acquired while the first was held")
	case <-time.After(50 * time.Millisecond):
	}
	if err = release(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-acquired:
	case <-time.After(2 * time.Second):
		t.Fatal("second journal lock did not acquire after release")
	}
}

func TestRevocationOperationResultNeverClaimsUnconfirmedDisconnect(t *testing.T) {
	partial := vpnruntime.RevocationResult{Serial: "aabbccdd", Revoked: true}
	result := revocationOperationResult(partial, vpnruntime.ErrRevocationPublished, "2026-11-11T00:00:00Z", 7)
	if result.Status != "failed" || result.Result["code"] != "disconnect_unconfirmed" {
		t.Fatalf("management failure was not surfaced: %#v", result)
	}
	if result.Result["revoked"] != true || result.Result["disconnect_requested"] != false {
		t.Fatalf("failed disconnect was reported incorrectly: %#v", result.Result)
	}

	revocation := vpnruntime.RevocationResult{
		Serial:                 "aabbccdd",
		Revoked:                true,
		DisconnectRequested:    true,
		ManagementCommandSent:  true,
		ManagementAccepted:     true,
		DisconnectConfirmed:    true,
		AcceptWithinBudget:     true,
		DisconnectWithinBudget: true,
		Timings: vpnruntime.RevocationTimings{
			AcceptElapsedNS:     int64(1500 * 1000 * 1000),
			DisconnectElapsedNS: int64(6000 * 1000 * 1000),
		},
	}
	result = revocationOperationResult(revocation, nil, "2026-11-11T00:00:00Z", 7)
	if result.Status != "succeeded" || result.Result["disconnect_requested"] != true {
		t.Fatalf("successful command was not reported: %#v", result)
	}
	if result.Result["management_command_sent"] != true || result.Result["management_command_attempted"] != true ||
		result.Result["management_write_partial"] != false || result.Result["management_accepted"] != true ||
		result.Result["disconnect_confirmed"] != true || result.Result["accept_within_budget"] != true ||
		result.Result["disconnect_within_budget"] != true || result.Result["sla_met"] != true {
		t.Fatalf("explicit acceptance/confirmation/SLA was not reported: %#v", result.Result)
	}
	timings, ok := result.Result["timings"].(vpnruntime.RevocationTimings)
	if !ok || timings.AcceptElapsedNS != int64(1500*1000*1000) || timings.DisconnectElapsedNS != int64(6000*1000*1000) {
		t.Fatalf("timings were not reported: %#v", result.Result["timings"])
	}

	late := revocation
	late.AcceptWithinBudget = false
	result = revocationOperationResult(late, nil, "2026-11-11T00:00:00Z", 7)
	if result.Status != "failed" || result.Result["code"] != "sla_exceeded" || result.Result["management_accepted"] != true ||
		result.Result["accept_within_budget"] != false || result.Result["sla_met"] != false {
		t.Fatalf("late acceptance was not reported truthfully: %#v", result)
	}

	acceptedUnconfirmed := vpnruntime.RevocationResult{
		Serial:                "aabbccdd",
		Revoked:               true,
		DisconnectRequested:   true,
		ManagementCommandSent: true,
		ManagementAccepted:    true,
	}
	result = revocationOperationResult(acceptedUnconfirmed, vpnruntime.ErrDisconnectUnconfirmed, "2026-11-11T00:00:00Z", 7)
	if result.Status != "failed" || result.Result["code"] != "disconnect_unconfirmed" {
		t.Fatalf("accepted but unconfirmed disconnect was not surfaced: %#v", result)
	}
	if result.Result["management_accepted"] != true || result.Result["disconnect_confirmed"] != false {
		t.Fatalf("accepted command was reported as confirmed: %#v", result.Result)
	}

	for _, testCase := range []struct {
		name string
		err  error
		code string
	}{
		{name: "publish failed", err: vpnruntime.ErrRevocationPublishFailed, code: "revocation_publish_failed"},
		{name: "sla exceeded", err: vpnruntime.ErrRevocationSLAExceeded, code: "sla_exceeded"},
		{name: "not attempted", err: vpnruntime.ErrDisconnectNotAttempted, code: "disconnect_not_attempted"},
		{name: "rejected", err: vpnruntime.ErrDisconnectRejected, code: "disconnect_rejected"},
		{name: "record update", err: vpnruntime.ErrRevocationRecordUpdate, code: "revocation_record_update_failed"},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			result := revocationOperationResult(vpnruntime.RevocationResult{Serial: "aabbccdd", Revoked: true}, testCase.err, "2026-11-11T00:00:00Z", 7)
			if result.Status != "failed" || result.Result["code"] != testCase.code {
				t.Fatalf("post-publication failure was misclassified: %#v", result)
			}
		})
	}

	validationFailure := revocationOperationResult(vpnruntime.RevocationResult{Serial: "aabbccdd"}, errors.New("serial mismatch"), "2026-11-11T00:00:00Z", 7)
	if validationFailure.Status != "failed" || validationFailure.Result["code"] != "serial_mismatch" || validationFailure.Result["revoked"] != false {
		t.Fatalf("pre-publish failure was misclassified: %#v", validationFailure)
	}

	nilUnconfirmed := revocationOperationResult(vpnruntime.RevocationResult{Serial: "aabbccdd", Revoked: true}, nil, "2026-11-11T00:00:00Z", 7)
	if nilUnconfirmed.Status != "failed" || nilUnconfirmed.Result["code"] != "disconnect_unconfirmed" {
		t.Fatalf("nil error without confirmation was accepted: %#v", nilUnconfirmed)
	}
}
