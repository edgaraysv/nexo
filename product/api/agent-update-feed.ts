import { lstat, readFile, realpath } from 'node:fs/promises';
import { createReadStream, type ReadStream } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export const MAX_AGENT_RELEASE_BYTES = 64 * 1024 * 1024;
export const MAX_AGENT_MANIFEST_BYTES = 32 * 1024;

export type AgentReleasePackage = { body: ReadStream; size: number };

const semver = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;

/** Reads a fixed, versioned release layout; route input never becomes a path. */
export class AgentUpdateFeed {
  constructor(private readonly root = process.env.NEXO_AGENT_UPDATE_DIR) {}

  async currentManifest(): Promise<Buffer | undefined> {
    if (!this.root) return undefined;
    const contents = await this.read('current/manifest.json', MAX_AGENT_MANIFEST_BYTES);
    if (!contents) return undefined;
    let manifest: Record<string, unknown>;
    try {
      manifest = JSON.parse(contents.toString('utf8')) as Record<string, unknown>;
    } catch {
      throw new Error('invalid_agent_update_manifest');
    }
    if (manifest.schema !== 'nexo.agent-update.v2' || typeof manifest.version !== 'string' || !semver.test(manifest.version)) {
      throw new Error('invalid_agent_update_manifest');
    }
    return contents;
  }

  async packageFor(version: string): Promise<AgentReleasePackage | undefined> {
    if (!this.root || !semver.test(version)) return undefined;
    const file = await this.resolveFile(`${version}/nexo-agent.exe`, MAX_AGENT_RELEASE_BYTES);
    return file ? { body: createReadStream(file.path), size: file.size } : undefined;
  }

  private async read(relativePath: string, maxBytes: number): Promise<Buffer | undefined> {
    const file = await this.resolveFile(relativePath, maxBytes);
    if (!file) return undefined;
    const contents = await readFile(file.path);
    if (contents.length !== file.size || contents.length > maxBytes) throw new Error('invalid_agent_update_file');
    return contents;
  }

  private async resolveFile(relativePath: string, maxBytes: number): Promise<{ path: string; size: number } | undefined> {
    const root = resolve(this.root!);
    let rootReal: string;
    try {
      rootReal = await realpath(root);
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    const candidate = resolve(rootReal, relativePath);
    const lexicalPath = relative(rootReal, candidate);
    if (!lexicalPath || lexicalPath === '..' || lexicalPath.startsWith(`..${sep}`) || isAbsolute(lexicalPath)) {
      throw new Error('invalid_agent_update_path');
    }
    let info;
    try {
      info = await lstat(candidate);
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > maxBytes) {
      throw new Error('invalid_agent_update_file');
    }
    const resolvedFile = await realpath(candidate);
    const actualPath = relative(rootReal, resolvedFile);
    if (!actualPath || actualPath === '..' || actualPath.startsWith(`..${sep}`) || isAbsolute(actualPath)) {
      throw new Error('invalid_agent_update_path');
    }
    return { path: resolvedFile, size: info.size };
  }
}

function isMissing(error: unknown): boolean {
	return error !== null && typeof error === 'object' && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}
