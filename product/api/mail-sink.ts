import { isIP } from 'node:net';
import nodemailer from 'nodemailer';
import type { InvitationSink, RecoverySink } from './application.js';

export interface SmtpMailConfig {
  host: string;
  port: number;
  tlsMode: 'implicit' | 'starttls';
  username: string;
  passwordFile: string;
  from: string;
  publicUrl: string;
}

export interface MailMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
}

export interface MailDeliveryInfo {
  accepted?: unknown[];
  rejected?: unknown[];
}

export interface MailTransport {
  sendMail(message: MailMessage): Promise<MailDeliveryInfo>;
  close?(): void;
}

function requiredValue(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value || value.trim() !== value || /[\r\n\0]/u.test(value)) throw new Error(`invalid_${key.toLowerCase()}`);
  return value;
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error('invalid_nexo_smtp_port');
  return port;
}

function validHost(value: string): boolean {
  if (value.length > 253 || value.includes('..')) return false;
  return isIP(value) !== 0 || /^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?)$/u.test(value);
}

function validAddress(value: string): boolean {
  return value.length <= 320 && /^[^\s<>@]+@[^\s<>@.]+(?:\.[^\s<>@.]+)+$/u.test(value);
}

export function readSmtpMailConfig(env: NodeJS.ProcessEnv): SmtpMailConfig {
  const host = requiredValue(env, 'NEXO_SMTP_HOST');
  const port = parsePort(requiredValue(env, 'NEXO_SMTP_PORT'));
  const tlsMode = env.NEXO_SMTP_TLS_MODE ?? (port === 465 ? 'implicit' : 'starttls');
  const username = requiredValue(env, 'NEXO_SMTP_USER');
  const passwordFile = requiredValue(env, 'NEXO_SMTP_PASSWORD_FILE');
  const from = requiredValue(env, 'NEXO_MAIL_FROM');
  const publicUrl = requiredValue(env, 'NEXO_PUBLIC_URL');

  if (!validHost(host)) throw new Error('invalid_nexo_smtp_host');
  if (tlsMode !== 'implicit' && tlsMode !== 'starttls') throw new Error('invalid_nexo_smtp_tls_mode');
  if (!passwordFile.startsWith('/') || passwordFile.includes('\0')) throw new Error('invalid_nexo_smtp_password_file');
  if (username.length > 255) throw new Error('invalid_nexo_smtp_user');
  if (!validAddress(from)) throw new Error('invalid_nexo_mail_from');

  let parsedPublicUrl: URL;
  try {
    parsedPublicUrl = new URL(publicUrl);
  } catch {
    throw new Error('invalid_nexo_public_url');
  }
  if (parsedPublicUrl.protocol !== 'https:' || parsedPublicUrl.username || parsedPublicUrl.password || parsedPublicUrl.search || parsedPublicUrl.hash) {
    throw new Error('invalid_nexo_public_url');
  }

  return { host, port, tlsMode, username, passwordFile, from, publicUrl: parsedPublicUrl.toString().replace(/\/$/u, '') };
}

export function createSmtpMailTransport(config: SmtpMailConfig, password: string): MailTransport {
  if (!password || /[\r\n\0]/u.test(password)) throw new Error('invalid_nexo_smtp_password');
  const transport = nodemailer.createTransport({
    pool: true,
    host: config.host,
    port: config.port,
    secure: config.tlsMode === 'implicit',
    requireTLS: config.tlsMode === 'starttls',
    auth: { user: config.username, pass: password },
    tls: { minVersion: 'TLSv1.2' },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
    maxConnections: 2,
    maxMessages: 100
  });
  return {
    sendMail: async (message) => await transport.sendMail(message) as MailDeliveryInfo,
    close: () => transport.close()
  };
}

function addressOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value.toLowerCase();
  if (value && typeof value === 'object' && 'address' in value && typeof value.address === 'string') return value.address.toLowerCase();
  return undefined;
}

export class SmtpNotificationSink implements RecoverySink, InvitationSink {
  constructor(private readonly config: SmtpMailConfig, private readonly transport: MailTransport) {}

  deliver(email: string, token: string): Promise<void>;
  deliver(email: string, token: string, tenantId: string): Promise<void>;
  async deliver(email: string, token: string, tenantId?: string): Promise<void> {
    if (!validAddress(email) || !/^[A-Za-z0-9_-]{43}$/u.test(token)) throw new Error('invalid_notification');
    const apiBase = this.config.publicUrl.replace(/\/$/u, '');
    const invitation = tenantId !== undefined;
    const route = invitation ? '/v1/company/invitations/accept' : '/v1/auth/recovery/confirm';
    const url = `${apiBase}${route}`;
    const text = invitation
      ? [
          'Se creó una invitación para esta dirección de correo en NEXO.',
          `Empresa: ${tenantId}`,
          'Inicia sesión en NEXO con esta dirección y acepta la invitación usando el token de un solo uso.',
          `POST ${url}`,
          'Content-Type: application/json',
          '',
          JSON.stringify({ token }),
          '',
          'El token vence en 24 horas. Si no esperabas esta invitación, ignora este mensaje.'
        ].join('\n')
      : [
          'Se solicitó restablecer la contraseña de tu cuenta NEXO.',
          'Para completar la recuperación, envía el siguiente JSON al endpoint indicado y establece una contraseña nueva:',
          `POST ${url}`,
          'Content-Type: application/json',
          '',
          JSON.stringify({ token, new_password: '<tu-nueva-contraseña>' }),
          '',
          'El token vence en 15 minutos y solo puede usarse una vez. Si no solicitaste este cambio, ignora este mensaje.'
        ].join('\n');

    const result = await this.transport.sendMail({
      from: this.config.from,
      to: email,
      subject: invitation ? 'Invitación a NEXO' : 'Recuperación de cuenta NEXO',
      text
    });
    const accepted = result.accepted?.some((recipient) => addressOf(recipient) === email.toLowerCase()) ?? false;
    const rejected = result.rejected?.some((recipient) => addressOf(recipient) === email.toLowerCase()) ?? false;
    if (!accepted || rejected) throw new Error('notification_delivery_rejected');
  }

  close(): void {
    this.transport.close?.();
  }
}
