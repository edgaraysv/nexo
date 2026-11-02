import test from 'node:test';
import assert from 'node:assert/strict';
import { SmtpNotificationSink } from '../dist/product/mail-sink.js';

const config = {
  host: 'smtp.example.test',
  port: 587,
  tlsMode: 'starttls',
  username: 'nexo@example.test',
  passwordFile: '/etc/nexo/smtp-password',
  from: 'noreply@example.test',
  publicUrl: 'https://control.example.test/nexo/'
};
const token = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq';

test('SMTP sink formats and dispatches recovery and invitation messages through an injected transport', async () => {
  const sent = [];
  let closed = false;
  const sink = new SmtpNotificationSink(config, {
    async sendMail(message) {
      sent.push(message);
      return { accepted: [message.to], rejected: [] };
    },
    close() { closed = true; }
  });

  await sink.deliver('person@example.test', token);
  await sink.deliver('person@example.test', token, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  sink.close();

  assert.equal(sent.length, 2);
  assert.equal(sent[0].from, 'noreply@example.test');
  assert.equal(sent[0].to, 'person@example.test');
  assert.equal(sent[0].subject, 'Recuperación de cuenta NEXO');
  assert.match(sent[0].text, /https:\/\/control\.example\.test\/nexo\/account/u);
  assert.match(sent[0].text, new RegExp('Token de recuperación \\(un solo uso\\): ' + token, 'u'));
  assert.match(sent[0].text, /15 minutos/u);
  assert.equal(sent[1].subject, 'Invitación a NEXO');
  assert.match(sent[1].text, /https:\/\/control\.example\.test\/nexo\/account/u);
  assert.match(sent[1].text, new RegExp('Token de invitación \\(un solo uso\\): ' + token, 'u'));
  assert.match(sent[1].text, /24 horas/u);
  assert.equal(closed, true);
});

test('SMTP sink reports rejected recipient delivery and rejects malformed tokens', async () => {
  const sink = new SmtpNotificationSink(config, {
    async sendMail(message) { return { accepted: [], rejected: [message.to] }; }
  });
  await assert.rejects(sink.deliver('person@example.test', token), /notification_delivery_rejected/u);
  await assert.rejects(sink.deliver('person@example.test', 'bad-token'), /invalid_notification/u);
});
