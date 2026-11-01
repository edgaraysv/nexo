import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('L07 Tauri exposes only the local IPC bridge without shell, HTTP or filesystem plugins', async () => {
  const [cargo, config, capability, permission, rust] = await Promise.all([
    readFile('product/client/src-tauri/Cargo.toml', 'utf8'),
    readFile('product/client/src-tauri/tauri.conf.json', 'utf8'),
    readFile('product/client/src-tauri/capabilities/main.json', 'utf8'),
    readFile('product/client/src-tauri/permissions/client-ipc.toml', 'utf8'),
    readFile('product/client/src-tauri/src/lib.rs', 'utf8')
  ]);
  assert.doesNotMatch(cargo, /tauri-plugin-(shell|http|fs)/);
  assert.deepEqual(JSON.parse(capability).platforms, ['windows']);
  assert.equal(JSON.parse(config).app.security.capabilities.join(','), 'main');
  assert.match(permission, /commands\.allow = \["service_request"\]/);
  assert.match(rust, /const PIPE: &str = r"\\\\\.\\pipe\\nexo-endpoint-v1"/);
  assert.doesNotMatch(rust, /Command::new|TcpStream|reqwest/);
});

test('L07 UI shows honest module and identity states without persisting credentials', async () => {
  const source = await readFile('product/client/src/App.tsx', 'utf8');
  assert.match(source, /Pendiente de aprobación/);
  assert.match(source, /No integrado/);
  assert.match(source, /La clave se genera en el servicio/);
  assert.doesNotMatch(source, /localStorage|sessionStorage|fetch\(/);
});

test('L07 development installer isolates service state and binds the authorized SID', async () => {
  const [script, uninstall] = await Promise.all([readFile('scripts/install-l07-service.ps1', 'utf8'), readFile('scripts/uninstall-l07-service.ps1', 'utf8')]);
  assert.match(script, /New-Service -Name NexoEndpoint/);
  assert.match(script, /S-1-5-18/);
  assert.match(script, /S-1-5-32-544/);
  assert.match(script, /AllowedSid/);
  assert.match(script, /HTTPS es obligatorio/);
  assert.match(script, /OpenVPN\\bin\\openvpn\.exe/);
  assert.match(script, /OpenVPN 2\\\./);
  assert.match(script, /ProgramW6432/);
  assert.match(script, /nexo-agent-updater\.exe/);
  assert.match(script, /initialize-update-state/);
  assert.match(uninstall, /La identidad local se conservó/);
  assert.match(uninstall, /Revoca el dispositivo/);
});

test('L07 update applies only a staged hash and checks IPC health before constrained rollback', async () => {
  const [updater, script, secureUpdater, runtime, helper] = await Promise.all([
    readFile('product/agent/internal/updater/update.go', 'utf8'),
    readFile('scripts/apply-l07-update.ps1', 'utf8'),
    readFile('product/agent/internal/updater/secure.go', 'utf8'),
    readFile('product/agent/cmd/nexo-agent/update_runtime.go', 'utf8'),
    readFile('product/agent/internal/updater/apply_windows.go', 'utf8')
  ]);
  assert.match(updater, /ed25519\.Verify/);
  assert.match(updater, /nexo-agent\.pending\.exe/);
  assert.match(script, /Get-FileHash/);
  assert.match(script, /update_health_01/);
  assert.match(script, /rollback_allowed/);
  assert.match(secureUpdater, /nexo\.agent-update\.v2/);
  assert.match(secureUpdater, /MetadataVersion/);
  assert.match(secureUpdater, /MinimumAllowedVersion/);
  assert.match(runtime, /v1\/device\/agent-updates\/current/);
  assert.match(runtime, /nexo-agent-updater\.exe/);
  assert.match(helper, /waitHealthy/);
  assert.match(helper, /Action: "health"/);
  assert.match(helper, /AgentVersion\s+string `json:"agent_version"`/);
});
