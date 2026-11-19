import { findWorkspace } from '@notchlet/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { Readable, Writable } from 'node:stream';
import { normalizeOrigin, osCredentialStore, type CredentialStore } from './auth.js';
import type { Fetcher } from './integration.js';
import type { McpClient } from './mcp-config.js';
import { readMcpState, type McpClientMetadata, type McpCredentialMetadata } from './mcp-state.js';

export type BridgeOptions = {
  client?: McpClient;
  workspace?: string;
  stdin?: Readable;
  stdout?: Writable;
  store?: CredentialStore;
  loadStore?: () => Promise<CredentialStore>;
  fetch?: Fetcher;
};

export type ResolvedMcpCredential = {
  origin: string;
  root: string;
  secret: string;
  credential: McpCredentialMetadata;
  client?: McpClientMetadata;
};

const REDACTION = '[REDACTED]';
export function redactMcpText(text: string, secret?: string): string {
  let value = text.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTION}`);
  if (secret) value = value.split(secret).join(REDACTION);
  return value;
}

/** Resolve the MCP credential for the current workspace without ever logging it. */
export async function resolveMcpCredential(originInput: string, options: BridgeOptions = {}): Promise<ResolvedMcpCredential> {
  const origin = normalizeOrigin(originInput);
  const root = await findWorkspace(process.cwd(), options.workspace);
  if (!root) throw new Error('No initialized Notchlet workspace was found. Run `notchlet init --interactive` in the project root to configure MCP.');
  const state = await readMcpState(root);
  const entry = state.servers[origin];
  if (!entry) throw new Error(`No Notchlet MCP credential is configured for ${origin} in this workspace. Run \`notchlet init --interactive\` to configure it.`);
  let store: CredentialStore;
  try { store = options.store ?? await (options.loadStore ?? osCredentialStore)(); }
  catch { throw new Error('OS credential store is unavailable or locked, so the MCP credential cannot be read. Rerun `notchlet init --interactive` after unlocking it.'); }
  const secret = await store.get(entry.credential.key);
  if (!secret) throw new Error(`The stored MCP credential for ${origin} is missing from the OS credential store. Rerun \`notchlet init --interactive\` to create and store a new credential.`);
  return { origin, root, secret, credential: entry.credential, client: options.client ? entry.clients[options.client] : undefined };
}

function mapUpstreamError(error: unknown, origin: string): Error {
  const code = (error as { code?: unknown })?.code;
  if (code === 401) return new Error('The MCP credential was rejected (expired or revoked). Rerun `notchlet init --interactive` to create a new credential.');
  if (code === 403) return new Error('The MCP credential lacks the scopes required for this operation. Rerun MCP setup with a sufficient account session.');
  if (code === 404) return new Error(`The Notchlet MCP endpoint at ${origin}/mcp was not found. Verify the server URL.`);
  if (typeof code === 'number' && code >= 500) return new Error(`The Notchlet MCP endpoint at ${origin}/mcp is unavailable (HTTP ${code}). Retry when the server is healthy.`);
  return new Error(`Could not connect to the Notchlet MCP endpoint at ${origin}/mcp. Check network access and rerun \`notchlet init --interactive\` if the credential is stale.`);
}

export async function connectUpstream(origin: string, secret: string, fetchImpl?: Fetcher): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${secret}` } },
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
  const client = new Client({ name: 'notchlet-mcp-bridge', version: '0.1.0' }, { capabilities: {} });
  try {
    await client.connect(transport);
    return client;
  } catch (error) {
    await client.close().catch(() => undefined);
    throw mapUpstreamError(error, origin);
  }
}

/**
 * Transport-only proxy: tool schemas, authorization, and business behavior remain
 * owned by the remote Notchlet MCP service.
 */
export function createBridgeServer(upstream: Client): Server {
  const server = new Server({ name: 'notchlet-mcp-bridge', version: '0.1.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => await upstream.listTools());
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      return await upstream.callTool(request.params) as Awaited<ReturnType<Client['callTool']>>;
    } catch (error) {
      if (error instanceof McpError) throw error;
      throw new McpError(ErrorCode.InternalError, redactMcpText(error instanceof Error ? error.message : 'The upstream MCP tool call failed.'));
    }
  });
  return server;
}

/** Run the local stdio bridge until the client closes it. */
export async function serveMcp(originInput: string, options: BridgeOptions = {}): Promise<void> {
  const resolved = await resolveMcpCredential(originInput, options);
  const upstream = await connectUpstream(resolved.origin, resolved.secret, options.fetch);
  const server = createBridgeServer(upstream);
  const transport = new StdioServerTransport(options.stdin, options.stdout);
  const closed = new Promise<void>(resolve => { transport.onclose = () => { void upstream.close().catch(() => undefined); resolve(); }; });
  await server.connect(transport);
  await closed;
}
