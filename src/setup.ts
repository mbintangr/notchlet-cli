import { createInterface } from 'node:readline/promises';
import { initWorkspace } from '@notchlet/core';
import { authCommand, getProfile, readHiddenToken, resolveCredential, type AuthIO, type CredentialStore } from './auth.js';
import { bindWorkspace, platformApi, setWorkspaceSyncMode, type Fetcher } from './integration.js';

export interface SetupIO extends AuthIO {
  readLine: (prompt: string) => Promise<string>;
  write: (text: string) => void;
}

function terminalSetupIO(): SetupIO {
  const input = process.stdin;
  const output = process.stderr;
  const readLine = async (prompt: string) => {
    if (!input.isTTY || !output.isTTY) throw new Error('Interactive setup requires a terminal. Use `notchlet init --local` or run `notchlet init --interactive` in a TTY.');
    const rl = createInterface({ input, output });
    try { return await rl.question(prompt); }
    finally { rl.close(); }
  };
  return {
    stdin: input,
    stdout: output,
    readLine,
    readSecret: (prompt) => readHiddenToken({ stdin: input, stdout: output }, prompt),
    write: (text) => output.write(`${text}\n`),
  };
}

async function choose<T>(io: SetupIO, title: string, values: T[], label: (value: T) => string, defaultIndex = 0): Promise<T> {
  if (values.length === 0) throw new Error(`No ${title.toLowerCase()} are available for this account.`);
  io.write(title);
  values.forEach((value, index) => io.write(`  ${index + 1}) ${label(value)}${index === defaultIndex ? ' (default)' : ''}`));
  while (true) {
    const answer = (await io.readLine(`Choose 1-${values.length}${defaultIndex >= 0 ? ` [${defaultIndex + 1}]` : ''}: `)).trim();
    if (!answer && defaultIndex >= 0) return values[defaultIndex];
    const index = Number(answer) - 1;
    if (Number.isInteger(index) && index >= 0 && index < values.length) return values[index];
    io.write(`Enter a number from 1 to ${values.length}.`);
  }
}

export async function interactiveInit(root: string, options: { io?: SetupIO; fetch?: Fetcher; store?: CredentialStore; loadStore?: () => Promise<CredentialStore> } = {}) {
  const io = options.io ?? terminalSetupIO();
  await initWorkspace(root);
  io.write('Set up this checkout for Notchlet:');
  const mode = await choose(io, 'Choose a mode:', ['local', 'connected'] as const, (value) => value === 'local' ? 'Local-only (offline; no account login)' : 'Connect to a Notchlet account', 0);
  if (mode === 'local') return { root, mode: 'local', initialized: true };

  const currentProfile = await getProfile().catch(() => undefined);
  const suggestedServer = process.env.NOTCHLET_SERVER ?? currentProfile?.origin ?? '';
  const serverAnswer = (await io.readLine(`Notchlet server HTTPS origin${suggestedServer ? ` [${suggestedServer}]` : ''}: `)).trim();
  const server = serverAnswer || suggestedServer;
  if (!server) throw new Error('A Notchlet server URL is required to connect. The local workspace is initialized and remains usable offline.');

  if (process.env.NOTCHLET_TOKEN?.trim()) {
    throw new Error('Connected interactive setup needs a Notchlet account session. Unset NOTCHLET_TOKEN (a scoped API credential) and rerun `notchlet init`, or use `--local`.');
  }
  let profile = await getProfile(server).catch(() => undefined);
  if (!profile || profile.authMode !== 'user') {
    await authCommand('login', { server, fetch: options.fetch, io, store: options.store, loadStore: options.loadStore, forceUserLogin: true });
    profile = await getProfile(server);
  } else {
    try { await resolveCredential({ server, fetch: options.fetch, store: options.store, loadStore: options.loadStore }); }
    catch {
      await authCommand('login', { server, fetch: options.fetch, io, store: options.store, loadStore: options.loadStore, forceUserLogin: true });
      profile = await getProfile(server);
    }
  }

  const api = await platformApi(server, { fetch: options.fetch, store: options.store, loadStore: options.loadStore });
  const organizations = await api.get('/organizations/mine') as Array<{ id: number; name: string; slug?: string }>;
  if (!organizations.length) return { root, mode: 'local', initialized: true, accountConnected: true, message: 'No organizations are available to this account yet; the checkout remains local-only.' };
  const organization = await choose(io, 'Organizations:', organizations, (item) => `${item.name} (#${item.id})`);
  const products = await api.get(`/products?organizationId=${organization.id}`) as Array<{ id: number; name: string; team?: { name?: string } }>;
  if (!products.length) return { root, mode: 'local', initialized: true, accountConnected: true, organizationId: organization.id, message: 'This organization has no products yet; the checkout remains local-only.' };
  const product = await choose(io, 'Products:', products, (item) => `${item.name}${item.team?.name ? ` · ${item.team.name}` : ''} (#${item.id})`);
  const repositoryResponse = await api.get(`/git/config?productId=${product.id}`);
  const repositories = Array.isArray(repositoryResponse) ? repositoryResponse : repositoryResponse ? [repositoryResponse] : [];
  if (!repositories.length) return { root, mode: 'local', initialized: true, accountConnected: true, productId: product.id, message: 'No repositories are connected to this product. Local work remains available; connect a repository before binding for remote sync.' };
  const repository = await choose(io, 'Repositories:', repositories, (item: any) => `${item.repoLabel ?? `${item.repoOwner ?? ''}/${item.repoName ?? ''}`} · ${item.provider ?? 'Git'} (#${item.id})`);
  const syncMode = await choose(io, 'Sync preference:', ['auto', 'manual'] as const, (value) => value === 'auto' ? 'Automatic on CLI use when online (conflicts remain explicit)' : 'Manual only; sync only when requested', 0);
  const binding = await bindWorkspace(root, { server, productId: product.id, repositoryId: repository.id, fetch: options.fetch, store: options.store, loadStore: options.loadStore });
  await setWorkspaceSyncMode(root, syncMode);
  io.write(`Connected to ${organization.name} / ${product.name} / ${repository.repoLabel ?? repository.repoName}.`);
  io.write(`Sync mode: ${syncMode}.`);
  return { root, mode: 'connected', initialized: true, binding, syncMode };
}
