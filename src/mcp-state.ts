import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { serverKey } from './auth.js';
import type { McpClient } from './mcp-config.js';

export type McpCredentialMetadata = {
  key: string;
  id?: number;
  name: string;
  scopes: string[];
  createdAt: string;
};

export type McpClientMetadata = {
  relativePath: string;
  serverName: 'notchlet';
  entryHash: string;
  configuredAt: string;
  /** Absent in older state files, which recorded only the stdio bridge. */
  transport?: 'bridge' | 'remote' | 'local';
  /** Environment variable referenced by a remote entry's Authorization header. */
  tokenEnv?: string;
};

export type McpServerState = {
  /** Local-only configuration has no remote credential. */
  credential?: McpCredentialMetadata;
  clients: Partial<Record<McpClient, McpClientMetadata>>;
};

export type McpWorkspaceState = {
  schemaVersion: 1;
  servers: Record<string, McpServerState>;
};

const STATE_RELATIVE = path.join('.notchlet', '.local', 'mcp.json');

export function mcpStatePath(root: string): string {
  return path.join(path.resolve(root), STATE_RELATIVE);
}

export function mcpWorkspaceId(root: string): string {
  return createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 24);
}

/** MCP credentials live under a distinct keyring account so they never overwrite a user session. */
export function mcpCredentialKey(origin: string, workspaceId: string): string {
  return `mcp:${serverKey(origin)}:${workspaceId}`;
}

async function lstatOrNull(file: string) {
  try { return await lstat(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

async function assertSafeStatePath(root: string) {
  let current = path.resolve(root);
  for (const segment of path.dirname(STATE_RELATIVE).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = await lstatOrNull(current);
    if (stat?.isSymbolicLink() || (stat && !stat.isDirectory())) throw new Error('MCP state path traverses a non-directory or symlink.');
  }
  const target = await lstatOrNull(mcpStatePath(root));
  if (target?.isSymbolicLink() || (target && !target.isFile())) throw new Error('MCP state file is not a regular file.');
}

export async function readMcpState(root: string): Promise<McpWorkspaceState> {
  const file = mcpStatePath(root);
  try {
    const raw = JSON.parse(await readFile(file, 'utf8')) as Partial<McpWorkspaceState>;
    if (raw?.schemaVersion !== 1 || !raw.servers || typeof raw.servers !== 'object' || Array.isArray(raw.servers)) throw new Error('Invalid MCP state file.');
    for (const [origin, server] of Object.entries(raw.servers)) {
      if (!server || typeof server !== 'object') throw new Error(`Invalid MCP state for ${origin}.`);
      if (server.credential !== undefined && (typeof server.credential !== 'object' || typeof server.credential.key !== 'string')) throw new Error(`Invalid MCP state for ${origin}.`);
      if (!server.clients || typeof server.clients !== 'object') server.clients = {};
    }
    return raw as McpWorkspaceState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: 1, servers: {} };
    throw new Error(`MCP state is unreadable; preserve it and reconcile manually. ${(error as Error).message}`);
  }
}

export async function writeMcpState(root: string, state: McpWorkspaceState): Promise<void> {
  await assertSafeStatePath(root);
  const file = mcpStatePath(root);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  try { await rename(temporary, file); }
  catch (error) { await rm(temporary, { force: true }); throw error; }
}
