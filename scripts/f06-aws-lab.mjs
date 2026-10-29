// F06 AWS laboratory probe.
// `--review` never contacts AWS. `--phase preflight` sends one fixed, read-only
// SSM command and requires explicit authorization. Acceptance remains blocked
// until its declared fixtures and threshold exist.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const INSTANCE = 'i-006cda6fdc86af7a5';
const ACCOUNT = '423597267645';
const PROFILE = 'nexo-lab';
const REGION = 'us-east-1';
const allowedArguments = new Set(['--review', '--run', '--allow-ssm-read', '--allow-remote-mutation', '--phase', 'preflight', 'acceptance']);
for (const argument of process.argv.slice(2)) {
  if (!allowedArguments.has(argument)) throw new Error(`unsupported_argument:${argument}`);
}

const phaseIndex = process.argv.indexOf('--phase');
const phase = phaseIndex >= 0 ? process.argv[phaseIndex + 1] : undefined;
const acceptance = {
  PV15: { state: 'NOT_RUN', scenario: 'Dos entornos usan la misma LAN.', required: 'Acceso al destino correcto; sin cruce de rutas o respuestas.' },
  PV16: { state: 'NOT_RUN', scenario: 'Reinicio o retirada de un entorno.', required: 'Los demás mantienen conectividad; limpieza solo del entorno afectado.' },
  PV17: { state: 'NOT_RUN', scenario: 'Reinicio completo de la EC2.', required: 'Reconstrucción consistente y denegación durante la preparación.' },
  PV18: { state: 'NOT_RUN', scenario: 'Fallo a mitad de la creación.', required: 'Sin accesos abiertos ni recursos huérfanos; reintento seguro.' },
  PV19: { state: 'NOT_RUN', scenario: 'Una empresa aumenta la carga.', required: 'Límites efectivos y degradación de las demás dentro del umbral acordado.' },
  PV20: { state: 'NOT_RUN', scenario: 'Acceso desde VPN al host y otras empresas.', required: 'Denegación IPv4 e IPv6, incluido acceso a servicios y metadatos no autorizados.' },
};
const contract = {
  scope: 'F06_AWS_LAB',
  account: ACCOUNT,
  region: REGION,
  instance: INSTANCE,
  phases: {
    preflight: {
      host_mutation: false,
      transport: 'SSM AWS-RunShellScript',
      checks: ['identity', 'instance_state', 'tools', 'tun', 'ipv4_forwarding', 'systemd', 'cgroup_v2', 'disk', 'migration_010_presence', 'existing_nexo_runtime'],
      excludes: ['package_install', 'migration', 'service_change', 'network_change', 'imds_request', 'reboot'],
    },
    acceptance: {
      host_mutation: true,
      ready: false,
      fixture_topology: 'ephemeral clients, gateways and homonymous destinations inside the authorized EC2 laboratory',
      pv19_threshold: 'zero disconnects in B; >=99% successful probes; p95 <=2x baseline and <=baseline+50ms',
      blockers: [
        'implement and locally test the internal fixture runner without adding production route fields',
        'implement resumable exact-run cleanup and failure-point tests',
        'two-phase authorized EC2 reboot procedure',
      ],
      cleanup_invariant: 'Remove only resources tagged/named for the run; verify no probe namespace, veth, nft table, unit, process or credential remains. Preserve agent state and PKI unless retirement is the tested action.',
    },
  },
  acceptance,
};

if (process.argv.includes('--review')) {
  console.log(JSON.stringify(contract, null, 2));
  process.exit(0);
}
if (!process.argv.includes('--run') || !phase) {
  console.error('F06 AWS probe blocked. Review first with --review; execution requires --run --phase <phase> and the phase guard.');
  process.exit(2);
}
if (phase === 'acceptance') {
  if (!process.argv.includes('--allow-remote-mutation')) {
    console.error('F06 acceptance requires --allow-remote-mutation and separate explicit authorization.');
    process.exit(2);
  }
  console.error(`acceptance_not_ready:${contract.phases.acceptance.blockers.join(';')}`);
  process.exit(2);
}
if (phase !== 'preflight' || !process.argv.includes('--allow-ssm-read')) {
  console.error('F06 preflight requires --run --phase preflight --allow-ssm-read and explicit SSM authorization.');
  process.exit(2);
}

const runId = `nexo-f06-preflight-${randomUUID().slice(0, 12)}`;
const directory = resolve('artifacts/f06', runId);
await mkdir(directory, { recursive: true, mode: 0o700 });
const report = { ...contract, run_id: runId, phase, started: new Date().toISOString(), status: 'RUNNING' };

function cli(args, timeout = 30_000) {
  const result = spawnSync('aws', ['--profile', PROFILE, '--region', REGION, '--output', 'json', ...args], { encoding: 'utf8', timeout });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`aws_${args[0]}_failed:${(result.stderr || result.stdout).slice(0, 800)}`);
  return JSON.parse(result.stdout);
}

const PREFLIGHT_SCRIPT = String.raw`#!/bin/bash
set -u
pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; }
info() { echo "INFO: $1"; }
check_command() { command -v "$1" >/dev/null 2>&1 && pass "tool_$1" || fail "tool_$1"; }

echo "=== F06 READ-ONLY PREFLIGHT ==="
info "kernel=$(uname -r)"
info "os=$(sed -n 's/^PRETTY_NAME=//p' /etc/os-release 2>/dev/null | head -1)"
for tool in ip nft systemctl sysctl openvpn; do check_command "$tool"; done
[ -c /dev/net/tun ] && pass "tun_device" || fail "tun_device"
[ "$(cat /proc/sys/net/ipv4/ip_forward 2>/dev/null)" = "1" ] && pass "ipv4_forwarding_enabled" || fail "ipv4_forwarding_enabled"
[ "$(stat -fc %T /sys/fs/cgroup 2>/dev/null)" = "cgroup2fs" ] && pass "cgroup_v2" || fail "cgroup_v2"
systemctl is-active --quiet nexo.service && pass "nexo_service_active" || fail "nexo_service_active"
systemctl is-active --quiet postgresql.service && pass "postgresql_service_active" || fail "postgresql_service_active"
if systemctl list-unit-files nexo-node-agent.service --no-legend 2>/dev/null | grep -q '^nexo-node-agent.service'; then
  info "node_agent_installed=yes"
  systemctl is-active --quiet nexo-node-agent.service && pass "node_agent_active" || fail "node_agent_active"
else
  info "node_agent_installed=no"
fi
info "nexo_namespaces=$(ip netns list 2>/dev/null | awk '$1 ~ /^nexo-[a-f0-9]{12}$/ {print $1}' | paste -sd, -)"
info "nexo_tables=$(nft list tables 2>/dev/null | awk '$3 ~ /^nx_[a-f0-9]{12}$/ {print $3}' | paste -sd, -)"
info "nexo_units=$(systemctl list-units 'nexo-vpn-*.service' --all --no-legend 2>/dev/null | awk '{print $1}' | paste -sd, -)"
disk_free=$(df -Pk /var/lib 2>/dev/null | awk 'NR==2 {print $4}')
info "disk_free_kb_var_lib=$disk_free"
case "$disk_free" in (*[!0-9]*|'') fail "disk_free_min_2gb";; (*) [ "$disk_free" -ge 2097152 ] && pass "disk_free_min_2gb" || fail "disk_free_min_2gb";; esac
if command -v psql >/dev/null 2>&1 && id nexo_runtime >/dev/null 2>&1; then
  table_count=$(runuser -u nexo_runtime -- psql -X -A -t -d nexo -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('vpn_environments','vpn_environment_revisions')" 2>/dev/null || true)
  info "f06_table_count=$table_count"
  [ "$table_count" = "2" ] && pass "migration_010_present" || fail "migration_010_present"
else
  fail "postgres_runtime_probe_available"
fi
echo "=== F06 READ-ONLY PREFLIGHT COMPLETE ==="`;

async function runPreflight() {
  const sent = cli([
    'ssm', 'send-command', '--instance-ids', INSTANCE, '--document-name', 'AWS-RunShellScript',
    '--parameters', JSON.stringify({ commands: PREFLIGHT_SCRIPT.split('\n') }),
    '--comment', runId, '--timeout-seconds', '120',
  ]);
  const commandId = sent.Command.CommandId;
  let invocation;
  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise(resolveDelay => setTimeout(resolveDelay, 4_000));
    try {
      invocation = cli(['ssm', 'get-command-invocation', '--command-id', commandId, '--instance-id', INSTANCE], 15_000);
    } catch { continue; }
    if (['Success', 'Failed', 'TimedOut', 'Cancelled'].includes(invocation.Status)) break;
  }
  if (!invocation || !['Success', 'Failed', 'TimedOut', 'Cancelled'].includes(invocation.Status)) {
    cli(['ssm', 'cancel-command', '--command-id', commandId, '--instance-ids', INSTANCE]);
    throw new Error(`ssm_preflight_timeout:${commandId}`);
  }
  const stdout = invocation.StandardOutputContent ?? '';
  const stderr = invocation.StandardErrorContent ?? '';
  const passes = (stdout.match(/^PASS: .+$/gm) ?? []).map(line => line.slice(6));
  const failures = (stdout.match(/^FAIL: .+$/gm) ?? []).map(line => line.slice(6));
  const information = (stdout.match(/^INFO: .+$/gm) ?? []).map(line => line.slice(6));
  await writeFile(resolve(directory, 'preflight.txt'), `COMMAND_ID: ${commandId}\nSTATUS: ${invocation.Status}\n\n--- STDOUT ---\n${stdout}\n--- STDERR ---\n${stderr}`, { mode: 0o600 });
  return { command_id: commandId, ssm_status: invocation.Status, passes, failures, information };
}

try {
  const identity = cli(['sts', 'get-caller-identity']);
  assert.equal(identity.Account, ACCOUNT, `unexpected_account:${identity.Account}`);
  const instance = cli(['ec2', 'describe-instances', '--instance-ids', INSTANCE]);
  const observed = instance.Reservations?.[0]?.Instances?.[0];
  assert.equal(observed?.InstanceId, INSTANCE, 'authorized_instance_not_found');
  assert.equal(observed?.State?.Name, 'running', 'authorized_instance_not_running');
  report.identity = { account: identity.Account, arn: identity.Arn };
  report.preflight = await runPreflight();
  report.status = report.preflight.ssm_status === 'Success' && report.preflight.failures.length === 0 ? 'PASS' : 'FAIL';
  if (report.status !== 'PASS') process.exitCode = 1;
} catch (error) {
  report.status = 'ERROR';
  report.error = String(error);
  process.exitCode = 1;
} finally {
  report.finished = new Date().toISOString();
  await writeFile(resolve(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(`F06 preflight ${report.status}: ${directory}/report.json`);
}
