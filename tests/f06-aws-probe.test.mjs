import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const script = new URL('../scripts/f06-aws-lab.mjs', import.meta.url);

test('F06 AWS review is local, structured and keeps PV15-PV20 NOT_RUN', () => {
  const result = spawnSync(process.execPath, [script.pathname, '--review'], { encoding: 'utf8', env: { ...process.env, PATH: '' } });
  assert.equal(result.status, 0, result.stderr);
  const review = JSON.parse(result.stdout);
  assert.equal(review.phases.preflight.host_mutation, false);
  assert.equal(review.phases.acceptance.host_mutation, true);
  assert.equal(review.phases.acceptance.ready, false);
  assert.match(review.phases.acceptance.fixture_topology, /inside the authorized EC2/u);
  assert.match(review.phases.acceptance.pv19_threshold, />=99%/u);
  assert.deepEqual(Object.keys(review.acceptance), ['PV15', 'PV16', 'PV17', 'PV18', 'PV19', 'PV20']);
  assert.ok(Object.values(review.acceptance).every(item => item.state === 'NOT_RUN'));
});

test('F06 AWS execution remains blocked without an explicit phase guard', () => {
  const result = spawnSync(process.execPath, [script.pathname, '--run', '--phase', 'preflight'], { encoding: 'utf8', env: { ...process.env, PATH: '' } });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /requires --run --phase preflight --allow-ssm-read/u);
});

test('F06 AWS mutating acceptance refuses to run while prerequisites are open', () => {
  const result = spawnSync(process.execPath, [script.pathname, '--run', '--phase', 'acceptance', '--allow-remote-mutation'], { encoding: 'utf8', env: { ...process.env, PATH: '' } });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /acceptance_not_ready/u);
});

test('F06 node unit preserves host mount propagation required by named namespaces', () => {
  const unit = readFileSync(new URL('../infra/aws/lab/nexo-node-agent.service', import.meta.url), 'utf8');
  for (const incompatible of ['Protect', 'ReadWritePaths=', 'ReadOnlyPaths=', 'InaccessiblePaths=', 'BindPaths=', 'BindReadOnlyPaths=', 'PrivateMounts=', 'PrivateTmp=', 'PrivateDevices=']) {
    assert.equal(unit.split('\n').some(line => line.trimStart().startsWith(incompatible)), false, `${incompatible} disconnects namespace mounts from the host`);
  }
  assert.match(unit, /^CapabilityBoundingSet=CAP_NET_ADMIN CAP_SYS_ADMIN$/mu);
  assert.match(unit, /^RestrictAddressFamilies=AF_UNIX AF_INET AF_NETLINK$/mu);
});
