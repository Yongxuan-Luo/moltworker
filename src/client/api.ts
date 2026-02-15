// API client for admin endpoints
// Authentication is handled by Cloudflare Access (JWT in cookies)

const API_BASE = '/api/admin';

export interface PendingDevice {
  requestId: string;
  deviceId: string;
  displayName?: string;
  platform?: string;
  clientId?: string;
  clientMode?: string;
  role?: string;
  roles?: string[];
  scopes?: string[];
  remoteIp?: string;
  ts: number;
}

export interface PairedDevice {
  deviceId: string;
  displayName?: string;
  platform?: string;
  clientId?: string;
  clientMode?: string;
  role?: string;
  roles?: string[];
  scopes?: string[];
  createdAtMs: number;
  approvedAtMs: number;
}

export interface DeviceListResponse {
  pending: PendingDevice[];
  paired: PairedDevice[];
  raw?: string;
  stderr?: string;
  parseError?: string;
  error?: string;
}

export interface ApproveResponse {
  success: boolean;
  requestId: string;
  message?: string;
  stdout?: string;
  stderr?: string;
  error?: string;
}

export interface ApproveAllResponse {
  approved: string[];
  failed: Array<{ requestId: string; success: boolean; error?: string }>;
  message?: string;
  error?: string;
}

export interface PairingRequest {
  code: string;
  id: string;
  meta?: unknown;
  createdAt?: string;
}

export interface PairingListResponse {
  channel: string;
  requests: PairingRequest[];
  raw?: string;
  stderr?: string;
  parseError?: string;
  error?: string;
}

export interface PairingApproveResponse {
  success: boolean;
  channel: string;
  code: string;
  stdout?: string;
  stderr?: string;
  error?: string;
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

async function apiRequest<T>(path: string, options: globalThis.RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  } as globalThis.RequestInit);

  if (response.status === 401) {
    throw new AuthError('Unauthorized - please log in via Cloudflare Access');
  }

  const contentType = response.headers.get('content-type') || '';
  const expectsJson = contentType.includes('application/json') || contentType.includes('+json') || contentType === '';

  let data: (T & { error?: string; message?: string }) | null = null;
  let rawText: string | null = null;

  try {
    if (expectsJson) {
      data = (await response.json()) as T & { error?: string; message?: string };
    } else {
      rawText = await response.text();
    }
  } catch {
    try {
      rawText = await response.text();
    } catch {
      rawText = null;
    }
  }

  if (!response.ok) {
    const message =
      (data && (data.error || data.message)) ||
      (rawText ? rawText.slice(0, 500) : null) ||
      `API error: ${response.status}`;
    throw new Error(message);
  }

  if (data === null) {
    const preview = rawText ? rawText.slice(0, 200) : '';
    throw new Error(`Expected JSON but got ${contentType || 'non-JSON'} response. ${preview}`.trim());
  }

  return data;
}

export async function listDevices(): Promise<DeviceListResponse> {
  return apiRequest<DeviceListResponse>('/devices');
}

export async function approveDevice(requestId: string): Promise<ApproveResponse> {
  return apiRequest<ApproveResponse>(`/devices/${requestId}/approve`, {
    method: 'POST',
  });
}

export async function approveAllDevices(): Promise<ApproveAllResponse> {
  return apiRequest<ApproveAllResponse>('/devices/approve-all', {
    method: 'POST',
  });
}

export async function listPairingRequests(channel: string): Promise<PairingListResponse> {
  return apiRequest<PairingListResponse>(`/pairing/${encodeURIComponent(channel)}`);
}

export async function approvePairingCode(
  channel: string,
  code: string,
  opts: { notify?: boolean } = {}
): Promise<PairingApproveResponse> {
  return apiRequest<PairingApproveResponse>(`/pairing/${encodeURIComponent(channel)}/approve`, {
    method: 'POST',
    body: JSON.stringify({ code, notify: Boolean(opts.notify) }),
  });
}

export interface RestartGatewayResponse {
  success: boolean;
  message?: string;
  error?: string;
}

export async function restartGateway(): Promise<RestartGatewayResponse> {
  return apiRequest<RestartGatewayResponse>('/gateway/restart', {
    method: 'POST',
  });
}

export interface DestroySandboxResponse {
  success: boolean;
  message?: string;
  error?: string;
}

export async function destroySandbox(): Promise<DestroySandboxResponse> {
  return apiRequest<DestroySandboxResponse>('/sandbox/destroy', {
    method: 'POST',
  });
}

export interface StorageStatusResponse {
  configured: boolean;
  missing?: string[];
  lastSync: string | null;
  message: string;
}

export async function getStorageStatus(): Promise<StorageStatusResponse> {
  return apiRequest<StorageStatusResponse>('/storage');
}

export interface SyncResponse {
  success: boolean;
  message?: string;
  lastSync?: string;
  error?: string;
  details?: string;
}

export async function triggerSync(): Promise<SyncResponse> {
  return apiRequest<SyncResponse>('/storage/sync', {
    method: 'POST',
  });
}

export interface SkillMissing {
  bins: string[];
  anyBins: string[];
  env: string[];
  config: string[];
  os: string[];
}

export interface SkillSummary {
  name: string;
  description: string;
  emoji?: string;
  eligible: boolean;
  disabled: boolean;
  blockedByAllowlist: boolean;
  source?: string;
  primaryEnv?: string;
  homepage?: string;
  missing: SkillMissing;
}

export interface SkillsListResponse {
  workspaceDir?: string;
  managedSkillsDir?: string;
  skills: SkillSummary[];
}

export interface SkillRequirements {
  bins: string[];
  anyBins: string[];
  env: string[];
  config: string[];
  os: string[];
}

export interface SkillConfigCheck {
  path: string;
  value: unknown;
  satisfied: boolean;
}

export interface SkillInstallOption {
  id: string;
  kind: string;
  label: string;
  bins: string[];
}

export interface SkillInfo {
  name: string;
  description: string;
  source?: string;
  filePath?: string;
  baseDir?: string;
  skillKey?: string;
  primaryEnv?: string;
  emoji?: string;
  homepage?: string;
  always?: boolean;
  disabled: boolean;
  blockedByAllowlist: boolean;
  eligible: boolean;
  requirements: SkillRequirements;
  missing: SkillMissing;
  configChecks?: SkillConfigCheck[];
  install?: SkillInstallOption[];
}

export interface SkillDetailResponse {
  skill: SkillInfo;
  skillMd: string | null;
  truncated: boolean;
}

export async function listSkills(): Promise<SkillsListResponse> {
  return apiRequest<SkillsListResponse>('/skills');
}

export async function getSkill(name: string): Promise<SkillDetailResponse> {
  return apiRequest<SkillDetailResponse>(`/skills/${encodeURIComponent(name)}`);
}

export interface SkillEnabledResponse {
  success: boolean;
  skillKey: string;
  enabled: boolean;
  stdout?: string;
  stderr?: string;
  error?: string;
}

export async function setSkillEnabled(skillKey: string, enabled: boolean): Promise<SkillEnabledResponse> {
  return apiRequest<SkillEnabledResponse>(`/skills/${encodeURIComponent(skillKey)}/enabled`, {
    method: 'POST',
    body: JSON.stringify({ enabled }),
  });
}

export type MemoryFileKind = 'root' | 'memory';

export interface MemoryFileEntry {
  /** "MEMORY.md" or "memory/<path>.md" */
  path: string;
  kind: MemoryFileKind;
  bytes: number;
  mtimeMs: number;
}

export interface MemoryFilesResponse {
  workspaceDir: string;
  memoryDir: string;
  files: MemoryFileEntry[];
}

export interface MemoryFileResponse {
  workspaceDir: string;
  path: string;
  kind: MemoryFileKind;
  bytes: number;
  mtimeMs: number;
  content: string;
  truncated: boolean;
}

export async function listMemoryFiles(): Promise<MemoryFilesResponse> {
  return apiRequest<MemoryFilesResponse>('/memory/files');
}

export async function getMemoryFile(path: string): Promise<MemoryFileResponse> {
  return apiRequest<MemoryFileResponse>(`/memory/file?path=${encodeURIComponent(path)}`);
}

export interface MemoryWriteResponse {
  workspaceDir?: string;
  path?: string;
  kind?: MemoryFileKind;
  bytes?: number;
  mtimeMs?: number;
  error?: string;
  details?: string;
}

export async function saveMemoryFile(path: string, content: string): Promise<MemoryWriteResponse> {
  return apiRequest<MemoryWriteResponse>('/memory/file', {
    method: 'POST',
    body: JSON.stringify({ path, content }),
  });
}

export interface MemoryDeleteResponse {
  ok?: boolean;
  error?: string;
  details?: string;
}

export async function deleteMemoryFile(path: string): Promise<MemoryDeleteResponse> {
  return apiRequest<MemoryDeleteResponse>(`/memory/file?path=${encodeURIComponent(path)}`, {
    method: 'DELETE',
  });
}

export interface MemoryImportResponse {
  ok?: boolean;
  dryRun?: boolean;
  mode?: 'overwrite' | 'merge';
  deleted?: string[];
  wrote?: string[];
  totalBytes?: number;
  error?: string;
  details?: unknown;
}

export async function importMemoryJson(data: unknown, mode: 'overwrite' | 'merge'): Promise<MemoryImportResponse> {
  return apiRequest<MemoryImportResponse>('/memory/import', {
    method: 'POST',
    body: JSON.stringify({ mode, data }),
  });
}
