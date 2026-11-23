import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { inspectGitContext, WorkflowError, type NamedRemote } from '@notchlet/core';
import { resolveCredential, type CredentialStore } from './auth.js';
import { bindWorkspace, platformApi, type Fetcher } from './integration.js';

export interface BootstrapOptions {
  server: string;
  name: string;
  organization?: string;
  team?: string;
  slug?: string;
  description?: string;
  remote?: string;
  provider?: 'GITHUB' | 'GITLAB';
  repoLabel?: string;
  dryRun?: boolean;
  rebind?: boolean;
  endpoint?: string;
  allowFileStore?: boolean;
  fetch?: Fetcher;
  store?: CredentialStore;
  loadStore?: () => Promise<CredentialStore>;
}

export interface BootstrapPlan {
  organization: { id: number; name: string; slug?: string };
  team: { id: number; name: string; slug?: string };
  product: { id?: number; name: string; slug: string; action: 'adopted' | 'created' | 'create' };
  repository: { id?: number; owner: string; name: string; remote: string; repoUrl: string; provider: 'GITHUB' | 'GITLAB'; action: 'reused' | 'connected' | 'connect' };
}

type Organization = { id: number; name: string; slug?: string };
type Team = { id: number; name: string; slug?: string };
type Product = { id: number; name: string; slug: string; team?: { id: number } };

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const bootstrapError = (code: string, message: string, recovery: string) => new WorkflowError(code, message, recovery);
const statusOf = (error: unknown) => (error as { status?: unknown }).status;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
  return JSON.stringify(value);
}

export function slugifyProduct(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/g, '');
}

function matchOne<T extends { id: number; name: string; slug?: string }>(query: string, candidates: T[], kind: 'organization' | 'team' | 'product'): T | undefined {
  const needle = query.trim().toLowerCase();
  const numeric = /^\d+$/.test(needle) ? Number(needle) : undefined;
  const matches = candidates.filter(candidate => candidate.id === numeric || candidate.name.toLowerCase() === needle || candidate.slug?.toLowerCase() === needle);
  if (matches.length > 1) throw bootstrapError(`${kind}_ambiguous`, `${matches.length} ${kind}s match "${query}".`, `Pass the numeric ID of the ${kind} instead.`);
  return matches[0];
}

function selectOne<T extends { id: number; name: string }>(query: string | undefined, candidates: T[], kind: 'organization' | 'team'): T {
  if (query) {
    const match = matchOne(query, candidates, kind);
    if (!match) throw bootstrapError(`${kind}_not_found`, `No ${kind} matched "${query}".`, `Run with a ${kind} name or ID available to this account.`);
    return match;
  }
  if (candidates.length === 1) return candidates[0];
  if (!candidates.length) throw bootstrapError(`${kind}_not_found`, `This account has no ${kind}s to bind.`, 'Create one on the Notchlet platform first.');
  throw bootstrapError(`${kind}_required`, `Multiple ${kind}s are available; choose one.`, `Pass --${kind === 'organization' ? 'org' : 'team'} <name|id>. Candidates: ${candidates.map(candidate => `${candidate.name} (#${candidate.id})`).join(', ')}`);
}

async function journalProductCreate(root: string, body: Record<string, unknown>) {
  const directory = path.join(root, '.notchlet', '.local', 'bootstrap');
  const file = path.join(directory, 'product-create.operation.json');
  const payloadHash = createHash('sha256').update(canonical(body)).digest('hex');
  try {
    const saved = JSON.parse(await readFile(file, 'utf8'));
    if (saved.payloadHash !== payloadHash) throw bootstrapError('operation_payload_conflict', 'An earlier product create for different content is unresolved.', 'Re-run `workspace bind --create` with the original name/slug, or remove the bootstrap journal after confirming the platform state.');
    return saved.operationId as string;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const operationId = randomUUID();
  await mkdir(directory, { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ operationId, payloadHash, createdAt: new Date().toISOString(), body }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  await rename(temporary, file);
  return operationId;
}

const clearProductJournal = (root: string) => rm(path.join(root, '.notchlet', '.local', 'bootstrap', 'product-create.operation.json'), { force: true });

function normalizeRemoteUrl(remote: NamedRemote): { repoUrl: string; provider?: 'GITHUB' | 'GITLAB'; serverUrl?: string } {
  const repoUrl = `https://${remote.host}/${remote.owner}/${remote.repo}`;
  if (remote.host === 'github.com') return { repoUrl, provider: 'GITHUB' };
  if (remote.host === 'gitlab.com') return { repoUrl, provider: 'GITLAB' };
  return { repoUrl, serverUrl: `https://${remote.host}` };
}

function selectRemote(input: BootstrapOptions, remotes: NamedRemote[], origin: NamedRemote | undefined): NamedRemote {
  if (input.remote) {
    const chosen = remotes.find(remote => remote.name === input.remote);
    if (!chosen) throw bootstrapError('git_remote_missing', `Git remote "${input.remote}" does not exist in this checkout.`, `Available remotes: ${remotes.map(remote => remote.name).join(', ') || '(none)'}.`);
    return chosen;
  }
  if (origin) return origin;
  if (remotes.length === 1) return remotes[0];
  if (!remotes.length) throw bootstrapError('git_remote_missing', 'This checkout has no Git remote to connect.', 'Add an origin remote pointing at the product repository, then retry.');
  throw bootstrapError('git_remote_ambiguous', `This checkout has ${remotes.length} remotes; choose one.`, `Pass --remote <name>. Candidates: ${remotes.map(remote => remote.name).join(', ')}`);
}

export async function bootstrapWorkspace(root: string, input: BootstrapOptions): Promise<{ dryRun: boolean; plan: BootstrapPlan; binding?: unknown; rebound?: boolean }> {
  try { await readFile(path.join(root, '.notchlet', 'workspace.json'), 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    throw bootstrapError('workspace_not_initialized', 'This directory is not an initialized Notchlet workspace.', 'Run `notchlet init` before `workspace bind --create`.');
  }
  const credential = await resolveCredential({ server: input.server, allowFileStore: input.allowFileStore, fetch: input.fetch, store: input.store, loadStore: input.loadStore });
  if (credential.authMode !== 'user') throw bootstrapError('user_auth_required', 'Creating a product requires a user login session.', 'Run `notchlet auth login` with an email and password, then retry.');
  const api = await platformApi(input.server, { allowFileStore: input.allowFileStore, fetch: input.fetch, store: input.store, loadStore: input.loadStore });

  const organizations = await api.get('/organizations/mine') as Organization[];
  const organization = selectOne(input.organization, Array.isArray(organizations) ? organizations : [], 'organization');
  const teams = await api.get(`/teams?organizationId=${organization.id}`) as Team[];
  const team = selectOne(input.team, Array.isArray(teams) ? teams : [], 'team');

  const slug = input.slug ?? slugifyProduct(input.name);
  if (!SLUG_PATTERN.test(slug) || slug.length > 48) throw bootstrapError('invalid_slug', `"${slug}" is not a valid product slug.`, 'Use lowercase letters, digits, and single hyphens (maximum 48 characters), or pass --slug.');
  const listProducts = async () => ((await api.get(`/products?organizationId=${organization.id}`)) as Product[] ?? []).filter(product => Number(product.team?.id) === team.id);

  const wanted = input.name.trim().toLowerCase();
  const existing = (await listProducts()).find(product => product.slug === slug || product.name.trim().toLowerCase() === wanted);
  let product: BootstrapPlan['product'];
  if (existing) {
    product = { id: existing.id, name: existing.name, slug: existing.slug, action: 'adopted' };
  } else if (input.dryRun) {
    product = { name: input.name, slug, action: 'create' };
  } else {
    const body = { teamId: team.id, name: input.name, slug, ...(input.description === undefined ? {} : { description: input.description }) };
    await journalProductCreate(root, body);
    let created: any;
    let adopted = false;
    try {
      created = await api.post('/products', body);
    } catch (error) {
      const status = statusOf(error);
      if (typeof status === 'number' && status < 500 && status !== 409) throw error;
      const matches = (await listProducts()).filter(candidate => candidate.slug === slug);
      if (matches.length > 1) throw bootstrapError('product_ambiguous', `${matches.length} products already use slug "${slug}" in this team.`, 'Choose the product explicitly on the platform before binding.');
      if (!matches.length) throw bootstrapError('product_create_unknown', 'The product create response was lost and no matching product is visible yet.', 'Re-run `workspace bind --create` to adopt the product once it appears; the journal keeps the request stable.');
      created = matches[0];
      adopted = true;
    }
    await clearProductJournal(root);
    if (!Number.isSafeInteger(Number(created?.id)) || Number(created.id) <= 0) throw bootstrapError('product_create_unknown', 'The platform returned a product without a usable ID.', 'Re-run `workspace bind --create`; the matching product will be adopted.');
    product = { id: Number(created.id), name: typeof created.name === 'string' ? created.name : input.name, slug: typeof created.slug === 'string' ? created.slug : slug, action: adopted ? 'adopted' : 'created' };
  }

  const git = await inspectGitContext(root);
  if (!git.available || !git.isRepository) throw bootstrapError('git_required', 'Product binding requires a Git checkout.', 'Initialize a Git repository with an origin remote, or bind the product on the platform instead.');
  const remotes = git.repository.remoteDetails;
  const chosen = selectRemote(input, remotes, remotes.find(remote => remote.name === 'origin'));
  const normalized = normalizeRemoteUrl(chosen);
  const provider = input.provider ?? normalized.provider;
  if (!provider) throw bootstrapError('provider_required', `Cannot infer the Git provider for ${chosen.host}.`, 'Pass --provider GITHUB or --provider GITLAB.');

  let repository: BootstrapPlan['repository'];
  const existingRepositories = product.id === undefined ? [] : ((await api.get(`/git/config?productId=${product.id}`)) as any[] | null) ?? [];
  const reused = existingRepositories.find(candidate => String(candidate.repoOwner).toLowerCase() === chosen.owner.toLowerCase() && String(candidate.repoName).toLowerCase() === chosen.repo.toLowerCase());
  if (reused) {
    repository = { id: Number(reused.id), owner: reused.repoOwner, name: reused.repoName, remote: chosen.name, repoUrl: normalized.repoUrl, provider: (reused.provider ?? provider) as 'GITHUB' | 'GITLAB', action: 'reused' };
  } else if (input.dryRun) {
    repository = { owner: chosen.owner, name: chosen.repo, remote: chosen.name, repoUrl: normalized.repoUrl, provider, action: 'connect' };
  } else {
    if (product.id === undefined) throw bootstrapError('product_create_unknown', 'A product ID is required before connecting a repository.', 'Re-run `workspace bind --create` without --dry-run.');
    await api.post('/git/connect', {
      productId: product.id,
      repoUrl: normalized.repoUrl,
      provider,
      ...(input.repoLabel === undefined ? {} : { repoLabel: input.repoLabel }),
      ...(normalized.serverUrl === undefined ? {} : { serverUrl: normalized.serverUrl }),
    });
    const confirmed = ((await api.get(`/git/config?productId=${product.id}`)) as any[] | null ?? []).find(candidate => String(candidate.repoOwner).toLowerCase() === chosen.owner.toLowerCase() && String(candidate.repoName).toLowerCase() === chosen.repo.toLowerCase());
    if (!confirmed) throw bootstrapError('repository_connect_unknown', 'The repository connect response could not be confirmed.', 'Re-run `workspace bind --create`; an already connected repository is reused.');
    repository = { id: Number(confirmed.id), owner: confirmed.repoOwner, name: confirmed.repoName, remote: chosen.name, repoUrl: normalized.repoUrl, provider: (confirmed.provider ?? provider) as 'GITHUB' | 'GITLAB', action: 'connected' };
  }

  const plan: BootstrapPlan = { organization, team, product, repository };
  if (input.dryRun) return { dryRun: true, plan };
  if (product.id === undefined || repository.id === undefined) throw bootstrapError('product_create_unknown', 'The bootstrap plan is missing a product or repository ID.', 'Re-run `workspace bind --create` without --dry-run.');
  const binding = await bindWorkspace(root, {
    server: input.server,
    productId: product.id,
    repositoryId: repository.id,
    endpoint: input.endpoint,
    rebind: input.rebind,
    allowFileStore: input.allowFileStore,
    fetch: input.fetch,
    store: input.store,
    loadStore: input.loadStore,
    context: { organizationName: organization.name, teamName: team.name, productName: product.name, productSlug: product.slug, repositoryLabel: input.repoLabel ?? `${repository.owner}/${repository.name}` },
  });
  return { dryRun: false, plan, binding, rebound: (binding as any).rebound };
}
