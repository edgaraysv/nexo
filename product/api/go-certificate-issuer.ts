import { execFile } from 'node:child_process';
import type { CertificateIssuer, IssuedCertificate } from './device-repository.js';

export class GoCertificateIssuer implements CertificateIssuer {
  constructor(private readonly binary: string, private readonly caDirectory: string) {}
  async issue(input: { deviceId: string; tenantId: string; audience: 'endpoint'|'node'; publicKeyPem: string; validHours: number }): Promise<IssuedCertificate> {
    const request = JSON.stringify({ device_id: input.deviceId, tenant_id: input.tenantId, audience: input.audience, public_key_pem: input.publicKeyPem, valid_hours: input.validHours });
    const output = await new Promise<string>((resolve, reject) => {
      const child = execFile(this.binary, ['issue', this.caDirectory], { timeout: 10_000, maxBuffer: 64 * 1024 }, (error, stdout) => error ? reject(new Error('certificate_issuance_failed')) : resolve(stdout));
      child.stdin?.end(request);
    });
    const value = JSON.parse(output) as Partial<{ serial: string; certificate_pem: string; not_before: string; not_after: string }>;
    if (!value.serial || !value.certificate_pem || !value.not_before || !value.not_after) throw new Error('invalid_issuer_response');
    return { serial: value.serial, certificatePem: value.certificate_pem, notBefore: value.not_before, notAfter: value.not_after };
  }
}
