import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { assertMockPlansOnly } from '../scripts/f02-safety.mjs';

const suite = await readFile('infra/aws/lab/tests/foundation.tftest.hcl', 'utf8');

test('F02 local solo contiene seis planes simulados y restringe ingreso al host', async () => {
  assert.equal(assertMockPlansOnly(suite), 6);
  const files = (await readdir('infra/aws/lab')).filter(name => name.endsWith('.tf'));
  const source = (await Promise.all(files.map(name => readFile(`infra/aws/lab/${name}`, 'utf8')))).join('\n');
  // Complementa los defaults del mock: solo se admite Webmin en el CIDR /32 aprobado.
  assert.doesNotMatch(source, /^\s*(?:key_name|iam_instance_profile)\s*=/m);
  assert.doesNotMatch(source, /^\s*ingress\s*(?:\{|=)/m);
  const ingressRules = [...source.matchAll(/^resource\s+"aws_vpc_security_group_ingress_rule"\s+"([^"]+)"/gm)];
  assert.deepEqual(ingressRules.map(match => match[1]), ['webmin']);
  const webmin = source.match(/resource\s+"aws_vpc_security_group_ingress_rule"\s+"webmin"\s*\{[\s\S]*?\n\}/)?.[0];
  assert.ok(webmin);
  assert.match(webmin, /cidr_ipv4\s*=\s*var\.webmin_admin_cidr/);
  assert.match(webmin, /from_port\s*=\s*10000[\s\S]*to_port\s*=\s*10000/);
  assert.doesNotMatch(source, /^resource\s+"aws_security_group_rule"/m);
  assert.match(source, /sse_algorithm\s*=\s*"aws:kms"/);
  assert.match(source, /"aws:SecureTransport"\s*=\s*"false"/);
  assert.match(source, /Effect\s*=\s*"Deny"/);
});

test('guardia F02 rechaza apply explicito e implicito', () => {
  assert.throws(() => assertMockPlansOnly(suite.replace('command = plan', 'command = apply')));
  assert.throws(() => assertMockPlansOnly(suite.replace('command = plan', '# command = plan')));
  assert.throws(() => assertMockPlansOnly(suite.replace('command = plan', '')));
});

test('guardia F02 exige mocks y rechaza providers/modulos adicionales', () => {
  assert.throws(() => assertMockPlansOnly(suite.replace('mock_provider "aws"', 'provider "aws"')));
  assert.throws(() => assertMockPlansOnly(suite + '\nprovider "aws" {}'));
  assert.throws(() => assertMockPlansOnly(suite + '\nrun "unsafe" { module { source = "elsewhere" } command = plan }'));
});

test('toolchain F02 y lock fijan el mismo provider', async () => {
  const toolchain = JSON.parse(await readFile('infra/toolchain.json', 'utf8'));
  const versions = await readFile('infra/aws/lab/versions.tf', 'utf8');
  const lock = await readFile('infra/aws/lab/.terraform.lock.hcl', 'utf8');
  assert.ok(versions.includes(`required_version = "= ${toolchain.opentofu.version}"`));
  assert.ok(versions.includes(`required_version = "= ${toolchain.terraform.version}"`));
  assert.ok(versions.includes(`version = "= ${toolchain.awsProvider.version}"`));
  assert.ok(lock.includes(`version     = "${toolchain.awsProvider.version}"`));
  assert.match(lock, /provider "registry\.opentofu\.org\/hashicorp\/aws"/);
  assert.match(lock, /provider "registry\.terraform\.io\/hashicorp\/aws"/);
  assert.match(toolchain.terraform.sha256, /^[a-f0-9]{64}$/);
  assert.equal(toolchain.terraform.url, `https://releases.hashicorp.com/terraform/${toolchain.terraform.version}/terraform_${toolchain.terraform.version}_linux_amd64.zip`);
  assert.match(toolchain.opentofu.sha256, /^[a-f0-9]{64}$/);
});
