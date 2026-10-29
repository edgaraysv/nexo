//go:build !linux

package vpnruntime

import "errors"

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
func RevokeClientCertificate(string, string, string, string, string) error {
	return errors.New("vpn pki unavailable")
}
