BEGIN;

-- The tls-crypt material is end-to-end encrypted to the endpoint key from
-- its CSR. Persist only the bounded ciphertext envelope, never the static key.
ALTER TABLE vpn_client_credentials
  ADD COLUMN tls_crypt_key_envelope text
  CHECK (tls_crypt_key_envelope IS NULL OR length(tls_crypt_key_envelope) BETWEEN 128 AND 4096);

COMMIT;
