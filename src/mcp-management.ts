import { resolveCredential, type CredentialStore } from './auth.js';
import type { Fetcher } from './integration.js';

/** Least-privilege default for agent development: read the workspace, write backlog items and changes. */
export const AGENT_MCP_SCOPES = ['workspace:read', 'backlog:write', 'changes:write'] as const;
/** Explicit opt-in scopes for documents, tickets, generation runs, and issue sync. */
export const BROADER_MCP_SCOPES = [...AGENT_MCP_SCOPES, 'documents:write', 'tickets:write', 'generation:run', 'issues:sync'] as const;

export type McpScopePreset = 'recommended' | 'broader';

export const MCP_SCOPE_PRESET_LABELS: Record<McpScopePreset, string> = {
  recommended: 'Recommended development (least privilege: workspace read, backlog and changes write)',
  broader: 'Broader (adds documents:write, tickets:write, generation:run, issues:sync)',
};

export function mcpScopePresetScopes(preset: McpScopePreset = 'recommended'): string[] {
  return [...(preset === 'broader' ? BROADER_MCP_SCOPES : AGENT_MCP_SCOPES)];
}

export type McpCredentialSummary = {
  id: number;
  name: string;
  keyPrefix?: string;
  scopes: string[];
  createdAt?: string;
  lastUsedAt?: string | null;
  expiresAt?: string | null;
  revokedAt?: string | null;
};

export type CreatedMcpCredential = McpCredentialSummary & { secret: string };

export type McpManagementOptions = {
  server?: string;
  fetch?: Fetcher;
  store?: CredentialStore;
  loadStore?: () => Promise<CredentialStore>;
  allowFileStore?: boolean;
};

export type McpManagementApi = {
  origin: string;
  getSettings(): Promise<{ enabled: boolean }>;
  setEnabled(enabled: boolean): Promise<{ enabled: boolean }>;
  createCredential(input: { name: string; scopes?: string[]; expiresAt?: string }): Promise<CreatedMcpCredential>;
  revokeCredential(id: number): Promise<{ success: boolean }>;
};

/**
 * Account-scoped MCP management. Scoped API tokens cannot call these routes, so a
 * user login session is required explicitly rather than silently failing at the server.
 */
export async function mcpManagement(server: string | undefined, options: McpManagementOptions = {}): Promise<McpManagementApi> {
  const { profile, token, authMode } = await resolveCredential({
    server,
    fetch: options.fetch,
    store: options.store,
    loadStore: options.loadStore,
    allowFileStore: options.allowFileStore,
  });
  if (authMode !== 'user') throw new Error('MCP management requires an account login session. Scoped NOTCHLET_TOKEN credentials cannot change account MCP settings; run `notchlet auth login` without NOTCHLET_TOKEN.');
  const fetcher = options.fetch ?? fetch;
  const request = async (route: string, init: RequestInit = {}) => {
    const response = await fetcher(`${profile.origin}${route}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
    });
    if (response.status === 401) throw new Error('The account session was rejected. Run `notchlet auth login` again.');
    if (response.status === 403) throw new Error('This account session cannot manage MCP settings.');
    if (!response.ok) throw new Error(`MCP management request failed with HTTP ${response.status}.`);
    return response.status === 204 ? undefined : response.json();
  };
  return {
    origin: profile.origin,
    async getSettings() { return await request('/mcp/settings') as { enabled: boolean }; },
    async setEnabled(enabled) { return await request('/mcp/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }) }) as { enabled: boolean }; },
    async createCredential(input) {
      return await request('/mcp/settings/credentials', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }) as CreatedMcpCredential;
    },
    async revokeCredential(id) { return await request(`/mcp/settings/credentials/${id}`, { method: 'DELETE' }) as { success: boolean }; },
  };
}

export function credentialName(client: string, workspaceId: string): string {
  const name = `notchlet-${client}-${workspaceId.slice(0, 12)}`;
  return name.slice(0, 80);
}
