import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentUpdateFeed } from '../dist/product/agent-update-feed.js';

test('F12 feed serves only the current signed manifest and fixed versioned agent package', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nexo-f12-feed-'));
  try {
    await mkdir(join(root, 'current'));
    await mkdir(join(root, '0.2.0'));
    const manifest = Buffer.from(JSON.stringify({ schema: 'nexo.agent-update.v2', version: '0.2.0', signature: 'signed' }));
    const agent = Buffer.from('windows agent fixture');
    await writeFile(join(root, 'current', 'manifest.json'), manifest);
    await writeFile(join(root, '0.2.0', 'nexo-agent.exe'), agent);
    const feed = new AgentUpdateFeed(root);
    assert.deepEqual(await feed.currentManifest(), manifest);
    const release = await feed.packageFor('0.2.0');
    assert.equal(release.size, agent.length);
    const chunks = [];
    for await (const chunk of release.body) chunks.push(chunk);
    assert.deepEqual(Buffer.concat(chunks), agent);
    assert.equal(await feed.packageFor('../secret'), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('F12 feed rejects invalid manifest versions and symlinked packages', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nexo-f12-feed-'));
  const outside = join(root, 'outside.exe');
  try {
    await mkdir(join(root, 'current'));
    await mkdir(join(root, '0.2.0'));
    await writeFile(outside, 'outside file');
    await writeFile(join(root, 'current', 'manifest.json'), JSON.stringify({ schema: 'nexo.agent-update.v2', version: '../latest' }));
    await symlink(outside, join(root, '0.2.0', 'nexo-agent.exe'));
    const feed = new AgentUpdateFeed(root);
    await assert.rejects(feed.currentManifest(), /invalid_agent_update_manifest/);
    await assert.rejects(feed.packageFor('0.2.0'), /invalid_agent_update_file/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('F12 feed reports no release when it has no configured publication', async () => {
  assert.equal(await new AgentUpdateFeed(undefined).currentManifest(), undefined);
  assert.equal(await new AgentUpdateFeed(undefined).packageFor('0.2.0'), undefined);
});
