import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import type { Fetcher } from './integration.js';
import { connectUpstream, createBridgeServer, redactMcpText, resolveMcpCredential } from './mcp-bridge.js';

test('redactMcpText removes bearer values and explicit secrets', () => {
  const redacted = redactMcpText('request failed: Authorization: Bearer abc.def-123 with mcp_live_secret', 'mcp_live_secret');
  assert.doesNotMatch(redacted, /abc\.def-123|mcp_live_secret/);
  assert.match(redacted, /Bearer \[REDACTED\]/);
});

test('bridge proxies tools and converts unexpected upstream failures to redacted MCP errors', async () => {
  const upstream = {
    async listTools() {
      return { tools: [{ name: 'echo', description: 'Echo text', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] };
    },
    async callTool(params: { name: string; arguments?: Record<string, unknown> }) {
      if (params.name !== 'echo') throw new Error('Unknown tool');
      if (params.arguments?.text === 'fail') throw new Error('upstream rejected Authorization: Bearer wrong-secret');
      return { content: [{ type: 'text', text: String(params.arguments?.text ?? '') }] };
    },
  };
  const bridge = createBridgeServer(upstream as any);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await bridge.connect(serverTransport);
  const client = new Client({ name: 'bridge-test', version: '1.0.0' }, { capabilities: {} });
  try {
    await client.connect(clientTransport);
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map(tool => tool.name), ['echo']);
    assert.deepEqual(listed.tools[0].inputSchema.required, ['text']);

    const called = await client.callTool({ name: 'echo', arguments: { text: 'hello' } });
    assert.equal((called.content as Array<{ type: string; text: string }>)[0].text, 'hello');

    await assert.rejects(client.callTool({ name: 'echo', arguments: { text: 'fail' } }), (error: unknown) => {
      assert.ok(error instanceof McpError);
      assert.match(error.message, /REDACTED/);
      assert.doesNotMatch(error.message, /wrong-secret/);
      return true;
    });
  } finally {
    await client.close().catch(() => undefined);
    await bridge.close().catch(() => undefined);
  }
});

test('bridge resolution reports actionable errors when no workspace or credential exists', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'notchlet-mcp-bridge-'));
  try {
    await assert.rejects(resolveMcpCredential('https://bridge.example.test', { workspace: parent }), /No initialized Notchlet workspace/);
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('upstream connection sends the bearer secret and maps authentication failures without leaking it', async () => {
  const headers: Array<string | null> = [];
  const fetcher: Fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    headers.push(new Headers(init?.headers).get('authorization'));
    return new Response('unauthorized', { status: 401 });
  }) as Fetcher;
  await assert.rejects(connectUpstream('https://upstream.example.test', 'wrong-secret', fetcher), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /rejected \(expired or revoked\)/);
    assert.doesNotMatch(error.message, /wrong-secret/);
    return true;
  });
  assert.equal(headers[0], 'Bearer wrong-secret');
});
