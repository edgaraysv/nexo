//go:build !linux

package vpnruntime

import (
	"errors"
	"fmt"
)

type ClientCertificate struct {
	Serial              string `json:"serial"`
	CertificatePEM      string `json:"certificate_pem"`
	CACertificatePEM    string `json:"ca_certificate_pem"`
	TLSCryptKeyEnvelope string `json:"tls_crypt_key_envelope"`
	NotBefore           string `json:"not_before"`
	NotAfter            string `json:"not_after"`
}

func IssueClientCertificate(string, string, string, string, string) (ClientCertificate, error) {
	return ClientCertificate{}, errors.New("vpn pki unavailable")
}

type RevocationStatusTiming struct {
	StartNS int64 `json:"start_ns"`
	EndNS   int64 `json:"end_ns"`
}

type RevocationTimings struct {
	ValidationEndNS      int64                    `json:"validation_end_ns"`
	RecordReadEndNS      int64                    `json:"record_read_end_ns"`
	CRLStartNS           int64                    `json:"crl_start_ns"`
	CRLPublishedNS       int64                    `json:"crl_published_ns"`
	RecordUpdatedNS      int64                    `json:"record_updated_ns"`
	ConnectStartNS       int64                    `json:"connect_start_ns"`
	DialStartNS          int64                    `json:"dial_start_ns"`
	DialEndNS            int64                    `json:"dial_end_ns"`
	GreetingEndNS        int64                    `json:"greeting_end_ns"`
	InitialStatusStartNS int64                    `json:"initial_status_start_ns"`
	InitialStatusEndNS   int64                    `json:"initial_status_end_ns"`
	PreKillStatusStartNS int64                    `json:"pre_kill_status_start_ns"`
	PreKillStatusEndNS   int64                    `json:"pre_kill_status_end_ns"`
	KillWriteStartNS     int64                    `json:"kill_write_start_ns"`
	KillWriteEndNS       int64                    `json:"kill_write_end_ns"`
	AcceptTerminalNS     int64                    `json:"accept_terminal_ns"`
	FinalStatusStartNS   int64                    `json:"final_status_start_ns"`
	FinalStatusEndNS     int64                    `json:"final_status_end_ns"`
	FinalStatusPolls     []RevocationStatusTiming `json:"final_status_polls,omitempty"`
	AcceptElapsedNS      int64                    `json:"accept_elapsed_ns"`
	DisconnectElapsedNS  int64                    `json:"disconnect_elapsed_ns"`
}

type RevocationResult struct {
	Serial                     string            `json:"serial"`
	Revoked                    bool              `json:"revoked"`
	DisconnectRequested        bool              `json:"disconnect_requested"`
	ManagementCommandSent      bool              `json:"management_command_sent"`
	ManagementCommandAttempted bool              `json:"management_command_attempted"`
	ManagementWritePartial     bool              `json:"management_write_partial"`
	ManagementAccepted         bool              `json:"management_accepted"`
	DisconnectConfirmed        bool              `json:"disconnect_confirmed"`
	AcceptWithinBudget         bool              `json:"accept_within_budget"`
	DisconnectWithinBudget     bool              `json:"disconnect_within_budget"`
	Timings                    RevocationTimings `json:"timings"`
}

var ErrRevocationPublished = errors.New("revocation published but client disconnect unconfirmed")

var (
	ErrRevocationPublishFailed = errors.New("revocation CRL publication failed")
	ErrRevocationSLAExceeded   = errors.New("revocation SLA exceeded")
	ErrDisconnectNotAttempted  = fmt.Errorf("%w: disconnect not attempted", ErrRevocationPublished)
	ErrDisconnectRejected      = fmt.Errorf("%w: management rejected disconnect", ErrRevocationPublished)
	ErrDisconnectUnconfirmed   = fmt.Errorf("%w: management disconnect unconfirmed", ErrRevocationPublished)
	ErrRevocationRecordUpdate  = fmt.Errorf("%w: durable client record update failed", ErrRevocationPublished)
)

func RevokeClientCertificate(string, string, string, string, string) (RevocationResult, error) {
	return RevocationResult{}, errors.New("vpn pki unavailable")
}
