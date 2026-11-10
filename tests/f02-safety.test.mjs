import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { assertMockPlansOnly } from '../scripts/f02-safety.mjs';

const suite = await readFile('infra/aws/lab/tests/foundation.tftest.hcl', 'utf8');

// El harness multitenant de M-VPN-05 vive en el mismo root que el nodo, pero es
// infraestructura de laboratorio: usa key_name, iam_instance_profile y sus
// propios SG por diseño. Las guardias globales (key_name, iam_instance_profile y
// conteo de reglas de ingreso) siguen aplicando al modulo raiz de produccion;
// este archivo queda excluido de forma explicita y acotada por nombre.
const EXEMPT_FROM_GLOBAL_CHECKS = new Set(['multitenant.tf']);

test('F02 local solo contiene seis planes simulados y restringe ingreso al host', async () => {
  assert.equal(assertMockPlansOnly(suite), 6);
  const files = (await readdir('infra/aws/lab')).filter(name => name.endsWith('.tf'));
  const guardedFiles = files.filter(name => !EXEMPT_FROM_GLOBAL_CHECKS.has(name));
  const source = (await Promise.all(guardedFiles.map(name => readFile(`infra/aws/lab/${name}`, 'utf8')))).join('\n');
  // Administración y OpenVPN se limitan a sus fuentes; HTTP/HTTPS públicos usan un SG web separado.
  assert.doesNotMatch(source, /^\s*(?:key_name|iam_instance_profile)\s*=/m);
  assert.doesNotMatch(source, /^\s*ingress\s*(?:\{|=)/m);
  const ingressRules = [...source.matchAll(/^resource\s+"aws_vpc_security_group_ingress_rule"\s+"([^"]+)"/gm)];
  assert.deepEqual(ingressRules.map(match => match[1]).sort(), ['openvpn_icmp', 'openvpn_listener', 'web_http', 'web_https', 'webmin']);
  const ingressBlock = name => source.match(new RegExp(`resource\\s+"aws_vpc_security_group_ingress_rule"\\s+"${name}"\\s*\\{[\\s\\S]*?\\n\\}`))?.[0];
  const webmin = ingressBlock('webmin');
  const openvpnListener = ingressBlock('openvpn_listener');
  const openvpnIcmp = ingressBlock('openvpn_icmp');
  const webHttp = ingressBlock('web_http');
  const webHttps = ingressBlock('web_https');
  assert.ok(webmin);
  assert.ok(openvpnListener);
  assert.ok(openvpnIcmp);
  assert.ok(webHttp);
  assert.ok(webHttps);
  assert.match(webmin, /security_group_id\s*=\s*aws_security_group\.node\.id/);
  assert.match(webmin, /cidr_ipv4\s*=\s*var\.webmin_admin_cidr/);
  assert.match(webmin, /from_port\s*=\s*10000[\s\S]*to_port\s*=\s*10000/);
  assert.match(openvpnListener, /security_group_id\s*=\s*aws_security_group\.node\.id/);
  assert.match(openvpnListener, /cidr_ipv4\s*=\s*local\.openvpn_client_cidr/);
  assert.match(openvpnListener, /ip_protocol\s*=\s*"udp"[\s\S]*from_port\s*=\s*local\.openvpn_listener_port[\s\S]*to_port\s*=\s*local\.openvpn_listener_port/);
  assert.match(openvpnIcmp, /security_group_id\s*=\s*aws_security_group\.node\.id/);
  assert.match(openvpnIcmp, /cidr_ipv4\s*=\s*local\.openvpn_tunnel_ipv4_cidr/);
  assert.match(openvpnIcmp, /ip_protocol\s*=\s*"icmp"[\s\S]*from_port\s*=\s*-1[\s\S]*to_port\s*=\s*-1/);
  assert.doesNotMatch(openvpnIcmp, /ip_protocol\s*=\s*"-1"/);
  assert.match(webHttp, /security_group_id\s*=\s*aws_security_group\.web\.id/);
  assert.match(webHttp, /cidr_ipv4\s*=\s*"0\.0\.0\.0\/0"/);
  assert.match(webHttp, /ip_protocol\s*=\s*"tcp"[\s\S]*from_port\s*=\s*80[\s\S]*to_port\s*=\s*80/);
  assert.match(webHttps, /security_group_id\s*=\s*aws_security_group\.web\.id/);
  assert.match(webHttps, /cidr_ipv4\s*=\s*"0\.0\.0\.0\/0"/);
  assert.match(webHttps, /ip_protocol\s*=\s*"tcp"[\s\S]*from_port\s*=\s*443[\s\S]*to_port\s*=\s*443/);
  const variables = await readFile('infra/aws/lab/variables.tf', 'utf8');
  assert.match(variables, /regex\("\/32\$",\s*var\.webmin_admin_cidr\)/);
  assert.doesNotMatch(source, /^resource\s+"aws_security_group_rule"/m);
  assert.match(source, /sse_algorithm\s*=\s*"aws:kms"/);
  assert.match(source, /"aws:SecureTransport"\s*=\s*"false"/);
  assert.match(source, /Effect\s*=\s*"Deny"/);
});

test('el lab multitenant excluido no abre ingreso publico ni usa SG inline', async () => {
  const root = await readFile('infra/aws/lab/multitenant.tf', 'utf8');
  const moduleFiles = (await readdir('infra/aws/lab/modules/tenant-vpc')).filter(name => name.endsWith('.tf'));
  const moduleSource = (await Promise.all(moduleFiles.map(name => readFile(`infra/aws/lab/modules/tenant-vpc/${name}`, 'utf8')))).join('\n');
  const lab = `${root}\n${moduleSource}`;
  assert.doesNotMatch(lab, /^resource\s+"aws_security_group_rule"/m);
  assert.doesNotMatch(lab, /^\s*ingress\s*(?:\{|=)/m);
  // Ninguna regla de ingreso del lab admite 0.0.0.0/0: solo /32 de EIPs y CIDR privados.
  for (const block of lab.match(/resource\s+"aws_vpc_security_group_ingress_rule"[\s\S]*?\n\}/g) ?? []) {
    assert.doesNotMatch(block, /cidr_ipv4\s*=\s*"0\.0\.0\.0\/0"/);
  }
  assert.equal((root.match(/instance_type\s*=\s*var\.multitenant_instance_type/g) ?? []).length, 5);
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

test('toolchains F02 y locks aislados fijan el mismo provider', async () => {
  const toolchain = JSON.parse(await readFile('infra/toolchain.json', 'utf8'));
  const versions = await readFile('infra/aws/lab/versions.tf', 'utf8');
  const lock = await readFile('infra/aws/lab/.terraform.lock.hcl', 'utf8');
  const tofuLock = await readFile('infra/aws/lab/opentofu-provider.lock.hcl', 'utf8');
  assert.ok(versions.includes(`required_version = "= ${toolchain.opentofu.version}"`));
  assert.ok(versions.includes(`required_version = "= ${toolchain.terraform.version}"`));
  assert.ok(versions.includes(`version = "= ${toolchain.awsProvider.version}"`));
  assert.ok(lock.includes(`version     = "${toolchain.awsProvider.version}"`));
  assert.match(lock, /provider "registry\.terraform\.io\/hashicorp\/aws"/);
  assert.match(tofuLock, /provider "registry\.opentofu\.org\/hashicorp\/aws"/);
  assert.doesNotMatch(tofuLock, /registry\.terraform\.io/);
  assert.equal((lock.match(/^provider "/gm) ?? []).length, 1);
  assert.equal((tofuLock.match(/^provider "/gm) ?? []).length, 1);
  assert.ok(lock.includes(`version     = "${toolchain.awsProvider.version}"`));
  assert.ok(tofuLock.includes(`version     = "${toolchain.awsProvider.version}"`));
  assert.match(toolchain.terraform.sha256, /^[a-f0-9]{64}$/);
  assert.equal(toolchain.terraform.url, `https://releases.hashicorp.com/terraform/${toolchain.terraform.version}/terraform_${toolchain.terraform.version}_linux_amd64.zip`);
  assert.match(toolchain.opentofu.sha256, /^[a-f0-9]{64}$/);
});
