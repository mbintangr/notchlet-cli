import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { initWorkspace } from '@notchlet/core';
import { authCommand, type CredentialStore } from './auth.js';
import { bootstrapWorkspace } from './bootstrap.js';

const execFileAsync = promisify(execFile);
const server = 'https://bootstrap.example';
const capabilities = {
  server: { id: 'bootstrap-server', version: '1.0.0' }, protocol: { minimum: '1.0', maximum: '1.0' },
  versions: { core: '1.0.0', schema: '1.0.0' },
  limits: { snapshotUploadBytes: 1_048_576, instructionContextBytes: 32768, pageSizeDefault: 20, pageSizeMaximum: 100 },
  operations: ['createChange', 'uploadSnapshot', 'checkpoint', 'linkChange', 'delivery', 'getOperation'],
};

type ProductRecord = { id: number; name: string; slug: string; description?: string; team: { id: number }; organizationId: number };
type RepoRecord = { id: number; productId: number; repoOwner: string; repoName: string; provider: string; repoLabel: string; serverUrl?: string; webhookSecret: string };
type CreateBehavior = 'create' | 'conflict' | 'throw' | 'ambiguous';

async function bootstrapFixture(options: { remotes?: string[]; behavior?: CreateBehavior; extraProducts?: ProductRecord[] } = {}) {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'notchlet-bootstrap-'));
  const root = path.join(temp, 'workspace');
  const oldConfig = process.env.NOTCHLET_CONFIG_DIR, oldToken = process.env.NOTCHLET_TOKEN;
  process.env.NOTCHLET_CONFIG_DIR = path.join(temp, 'config');
  delete process.env.NOTCHLET_TOKEN;
  await mkdir(root);
  await initWorkspace(root);
  await execFileAsync('git', ['init', '-q'], { cwd: root });
  for (const remote of options.remotes ?? ['origin git@github.com:acme/demo.git']) {
    const [name, url] = remote.split(' ');
    await execFileAsync('git', ['remote', 'add', name, url], { cwd: root });
  }

  const values = new Map<string, string>();
  const store: CredentialStore = { name: 'bootstrap test store', async get(key) { return values.get(key); }, async set(key, value) { values.set(key, value); }, async delete(key) { values.delete(key); } };
  const token = `header.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.signature`;
  const products: ProductRecord[] = [...(options.extraProducts ?? [])];
  const repositories: RepoRecord[] = [];
  const requests: Array<{ method: string; path: string; body: any }> = [];
  let productSequence = Math.max(10, ...products.map(product => product.id));
  let repositorySequence = 0;
  const behavior = options.behavior ?? 'create';

  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    requests.push({ method, path: url.pathname + url.search, body });
    if (url.pathname === '/auth/login') return Response.json({ accessToken: token, refreshToken: 'refresh-token', user: { email: 'bootstrap@example.test' } });
    if (new Headers(init?.headers).get('Authorization') !== `Bearer ${token}`) return Response.json({ message: 'unauthorized' }, { status: 401 });
    if (url.pathname.endsWith('/capabilities')) return Response.json(capabilities);
    if (url.pathname === '/organizations/mine') return Response.json([{ id: 1, name: 'Acme', slug: 'acme' }]);
    if (url.pathname === '/teams') return Response.json([{ id: 2, name: 'Core', slug: 'core' }]);
    if (url.pathname === '/products' && method === 'GET') return Response.json(products.filter(product => product.organizationId === Number(url.searchParams.get('organizationId'))));
    if (url.pathname === '/products' && method === 'POST') {
      const record: ProductRecord = { id: ++productSequence, name: body.name, slug: body.slug, ...(body.description === undefined ? {} : { description: body.description }), team: { id: body.teamId }, organizationId: 1 };
      if (behavior === 'ambiguous') {
        products.push({ ...record, id: ++productSequence }, record);
        return Response.json({ message: 'Product slug already exists.' }, { status: 409 });
      }
      products.push(record);
      if (behavior === 'conflict') return Response.json({ message: 'Product slug already exists.' }, { status: 409 });
      if (behavior === 'throw') throw new TypeError('fetch failed');
      return Response.json(record, { status: 201 });
    }
    const productMatch = url.pathname.match(/^\/products\/(\d+)$/);
    if (productMatch) {
      const product = products.find(candidate => candidate.id === Number(productMatch[1]));
      return product ? Response.json(product) : Response.json({ message: 'not found' }, { status: 404 });
    }
    if (url.pathname === '/git/config') {
      return Response.json(repositories.filter(repository => repository.productId === Number(url.searchParams.get('productId'))));
    }
    if (url.pathname === '/git/connect' && method === 'POST') {
      const parsed = new URL(body.repoUrl);
      const parts = parsed.pathname.replace(/^\/+|\/+$/g, '').split('/');
      const record: RepoRecord = {
        id: ++repositorySequence, productId: body.productId, repoOwner: parts.at(-2)!, repoName: parts.at(-1)!, provider: body.provider,
        repoLabel: body.repoLabel ?? `${parts.at(-2)!}/${parts.at(-1)!}`, ...(body.serverUrl === undefined ? {} : { serverUrl: body.serverUrl }), webhookSecret: 'whsec_leaked_if_printed',
      };
      repositories.push(record);
      return Response.json(record, { status: 201 });
    }
    return Response.json({ message: `unhandled ${method} ${url.pathname}` }, { status: 404 });
  }) as typeof fetch;

  await authCommand('login', { server, email: 'bootstrap@example.test', password: 'hidden', fetch: fetcher, store });
  const posts = () => requests.filter(request => request.method === 'POST' && request.path !== '/auth/login');
  const dispose = async () => {
    if (oldConfig === undefined) delete process.env.NOTCHLET_CONFIG_DIR; else process.env.NOTCHLET_CONFIG_DIR = oldConfig;
    if (oldToken === undefined) delete process.env.NOTCHLET_TOKEN; else process.env.NOTCHLET_TOKEN = oldToken;
    await rm(temp, { recursive: true, force: true });
  };
  return { root, store, fetcher, requests, posts, products, repositories, dispose };
}

const options = (f: Awaited<ReturnType<typeof bootstrapFixture>>, extra: Record<string, unknown> = {}) => ({
  server, name: 'Parity Demo', fetch: f.fetcher, store: f.store, allowFileStore: true, ...extra,
});

const codeOf = async (operation: Promise<unknown>) => {
  try { await operation; return null; } catch (error) { return (error as { code?: string }).code; }
};

test('dry run resolves org, team, product slug, and Git remote without writing', async () => {
  const f = await bootstrapFixture();
  try {
    const result = await bootstrapWorkspace(f.root, options(f, { dryRun: true }));
    assert.equal(result.dryRun, true);
    assert.deepEqual(result.plan.organization, { id: 1, name: 'Acme', slug: 'acme' });
    assert.deepEqual(result.plan.team, { id: 2, name: 'Core', slug: 'core' });
    assert.deepEqual(result.plan.product, { name: 'Parity Demo', slug: 'parity-demo', action: 'create' });
    assert.equal(result.plan.repository.owner, 'acme');
    assert.equal(result.plan.repository.name, 'demo');
    assert.equal(result.plan.repository.repoUrl, 'https://github.com/acme/demo');
    assert.equal(result.plan.repository.provider, 'GITHUB');
    assert.equal(result.plan.repository.action, 'connect');
    assert.deepEqual(f.posts(), []);
    assert.equal(f.products.length, 0);
  } finally { await f.dispose(); }
});

test('create mode creates the product, connects the checkout remote, and binds with context', async () => {
  const f = await bootstrapFixture();
  try {
    const result = await bootstrapWorkspace(f.root, options(f));
    assert.equal(result.dryRun, false);
    assert.equal(result.plan.product.action, 'created');
    assert.equal(result.plan.product.id, 11);
    assert.equal(result.plan.repository.action, 'connected');
    const createCalls = f.requests.filter(request => request.path === '/products' && request.method === 'POST');
    assert.deepEqual(createCalls.map(call => call.body), [{ teamId: 2, name: 'Parity Demo', slug: 'parity-demo' }]);
    const connectCalls = f.requests.filter(request => request.path === '/git/connect');
    assert.equal(connectCalls.length, 1);
    assert.deepEqual(connectCalls[0].body, { productId: 11, repoUrl: 'https://github.com/acme/demo', provider: 'GITHUB' });
    assert.equal('accessToken' in connectCalls[0].body, false);
    assert.equal(JSON.stringify(result).includes('whsec_'), false, 'webhook secrets never surface');

    const workspace = JSON.parse(await readFile(path.join(f.root, '.notchlet', 'workspace.json'), 'utf8'));
    assert.equal(workspace.binding.productId, 11);
    assert.equal(workspace.binding.repositoryId, 1);
    assert.deepEqual(workspace.binding.context, {
      organizationName: 'Acme', teamName: 'Core', productName: 'Parity Demo', productSlug: 'parity-demo', repositoryLabel: 'acme/demo',
    });
  } finally { await f.dispose(); }
});

test('a 409 create response adopts the matching product instead of duplicating it', async () => {
  const f = await bootstrapFixture({ behavior: 'conflict' });
  try {
    const result = await bootstrapWorkspace(f.root, options(f));
    assert.equal(result.plan.product.action, 'adopted');
    assert.equal(f.products.length, 1);
    assert.equal(f.products[0].slug, 'parity-demo');
  } finally { await f.dispose(); }
});

test('an uncertain create response adopts the visible product', async () => {
  const f = await bootstrapFixture({ behavior: 'throw' });
  try {
    const result = await bootstrapWorkspace(f.root, options(f));
    assert.equal(result.plan.product.action, 'adopted');
    assert.equal(f.products.length, 1);
  } finally { await f.dispose(); }
});

test('two products with the same slug after a conflict are reported as ambiguous', async () => {
  const f = await bootstrapFixture({ behavior: 'ambiguous' });
  try {
    assert.equal(await codeOf(bootstrapWorkspace(f.root, options(f))), 'product_ambiguous');
  } finally { await f.dispose(); }
});

test('a checkout without a Git remote fails before any write', async () => {
  const f = await bootstrapFixture({ remotes: [] });
  try {
    assert.equal(await codeOf(bootstrapWorkspace(f.root, options(f, { dryRun: true }))), 'git_remote_missing');
    assert.deepEqual(f.posts(), []);
  } finally { await f.dispose(); }
});

test('non-GitHub/GitLab hosts require an explicit provider', async () => {
  const f = await bootstrapFixture({ remotes: ['origin git@git.example.com:acme/demo.git'] });
  try {
    assert.equal(await codeOf(bootstrapWorkspace(f.root, options(f, { dryRun: true }))), 'provider_required');
    const result = await bootstrapWorkspace(f.root, options(f, { dryRun: true, provider: 'GITLAB' }));
    assert.equal(result.plan.repository.provider, 'GITLAB');
    assert.equal(result.plan.repository.repoUrl, 'https://git.example.com/acme/demo');
  } finally { await f.dispose(); }
});

test('rebinding the same product updates context without requiring --rebind', async () => {
  const f = await bootstrapFixture();
  try {
    await bootstrapWorkspace(f.root, options(f));
    const postsAfterFirst = f.posts().length;
    const again = await bootstrapWorkspace(f.root, options(f, { repoLabel: 'Demo service' }));
    assert.equal(again.plan.product.action, 'adopted');
    assert.equal(again.plan.repository.action, 'reused');
    assert.equal(f.posts().length, postsAfterFirst, 'rebinding makes no create or connect calls');
    const workspace = JSON.parse(await readFile(path.join(f.root, '.notchlet', 'workspace.json'), 'utf8'));
    assert.equal(workspace.binding.context.repositoryLabel, 'Demo service');
  } finally { await f.dispose(); }
});

test('product creation refuses token credentials', async () => {
  const f = await bootstrapFixture();
  try {
    process.env.NOTCHLET_TOKEN = 'mcp-token-value';
    assert.equal(await codeOf(bootstrapWorkspace(f.root, options(f, { dryRun: true }))), 'user_auth_required');
  } finally { delete process.env.NOTCHLET_TOKEN; await f.dispose(); }
});
