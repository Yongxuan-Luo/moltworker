import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { createAccessMiddleware } from '../auth';
import { ensureMoltbotGateway, findExistingMoltbotProcess, mountR2Storage, startMoltbotGatewayProcess, syncToR2, waitForProcess } from '../gateway';
import { R2_MOUNT_PATH } from '../config';
import { MEMORY_EXPORT_LIMIT_BYTES, MEMORY_READ_LIMIT_BYTES, MEMORY_WRITE_LIMIT_BYTES, normalizeMemoryPath, type MemoryFileResponse, type MemoryFilesResponse } from '../memory/browser';
import { coerceMemoryImportData, validateMemoryImportData, type MemoryImportMode } from '../memory/import';

// CLI commands can take 10-15 seconds to complete due to WebSocket connection overhead
const CLI_TIMEOUT_MS = 20000;
const SKILL_READ_LIMIT_BYTES = 200_000;
const MEMORY_IMPORT_FILE_LIMIT = 500;

/**
 * API routes
 * - /api/admin/* - Protected admin API routes (Cloudflare Access required)
 * 
 * Note: /api/status is now handled by publicRoutes (no auth required)
 */
const api = new Hono<AppEnv>();

/**
 * Admin API routes - all protected by Cloudflare Access
 */
const adminApi = new Hono<AppEnv>();

// Middleware: Verify Cloudflare Access JWT for all admin routes
adminApi.use('*', createAccessMiddleware({ type: 'json' }));

// GET /api/admin/gateway/status - Start/check gateway status (Cloudflare Access required)
adminApi.get('/gateway/status', async (c) => {
  const sandbox = c.get('sandbox');

  try {
    const probeGatewayListening = async (): Promise<boolean> => {
      try {
        // Prefer a WS upgrade probe to avoid false positives from non-gateway HTTP servers.
        // If the server accepts the upgrade, the gateway is definitely listening.
        const url = new URL('http://localhost/');
        if (c.env.MOLTBOT_GATEWAY_TOKEN) url.searchParams.set('token', c.env.MOLTBOT_GATEWAY_TOKEN);

        const res = await sandbox.wsConnect(
          new Request(url.toString(), {
            method: 'GET',
            headers: {
              Connection: 'Upgrade',
              Upgrade: 'websocket',
              'Sec-WebSocket-Version': '13',
              'Sec-WebSocket-Key': 'dGVzdC1wcm9iZS1rZXk=',
            },
          }),
          18789
        );
        const ws = res.webSocket;
        if (!ws) return false;
        ws.accept();
        ws.close(1000, 'probe');
        return true;
      } catch {
        return false;
      }
    };

    // Prefer an active gateway process, but also surface errors from the most recent attempt.
    const active = await findExistingMoltbotProcess(sandbox);
    const candidate =
      active ??
      (await (async () => {
        try {
            const processes = await sandbox.listProcesses();
            const gateway = processes.filter((p) => {
              const isGatewayProcess =
              p.command.includes('start-moltbot.sh') ||
              p.command.includes('clawdbot gateway') ||
              // Compatibility: upstream may use OpenClaw naming
              p.command.includes('start-openclaw.sh') ||
              p.command.includes('openclaw gateway');
              const isCliCommand =
              p.command.includes('clawdbot devices') ||
              p.command.includes('clawdbot --version') ||
              p.command.includes('openclaw devices') ||
              p.command.includes('openclaw --version') ||
              p.command.includes('openclaw onboard');
            return isGatewayProcess && !isCliCommand;
          });

          gateway.sort((a, b) => {
            const aTime = a.startTime?.getTime() ?? 0;
            const bTime = b.startTime?.getTime() ?? 0;
            return bTime - aTime;
          });

          return gateway[0] ?? null;
        } catch (err) {
          console.error('[ADMIN] listProcesses failed:', err);
          return null;
        }
      })());

    // If the gateway is already listening, report running even if we can't find a live process.
    if (await probeGatewayListening()) {
      return c.json({
        ok: true,
        status: 'running',
        processId: active?.id ?? null,
      });
    }

    if (!candidate) {
      // Start the gateway process immediately so we can surface errors/logs.
      // Readiness is handled by polling and waitForPort checks below.
      const started = await startMoltbotGatewayProcess(sandbox, c.env);
      // Also wait in the background so a later poll sees it as ready sooner.
      c.executionCtx.waitUntil(
        ensureMoltbotGateway(sandbox, c.env).catch((err: Error) => {
          console.error('[ADMIN] Background gateway ensure failed:', err);
        })
      );
      return c.json({ ok: false, status: 'starting', processId: started.id });
    }

    // If the last attempt failed, surface the error so the UI can stop "loading forever".
    if (candidate.status === 'failed' || candidate.status === 'completed') {
      const logs = await candidate.getLogs();
      const stderr = logs.stderr ?? '';
      const stdout = logs.stdout ?? '';
      return c.json(
        {
          ok: false,
          status: 'error',
          processId: candidate.id,
          exitCode: candidate.exitCode ?? null,
          error: stderr || stdout || `Gateway process ${candidate.status}`,
        },
        500
      );
    }

    if (candidate.status === 'starting') {
      return c.json({ ok: false, status: 'starting', processId: candidate.id });
    }

    try {
      await candidate.waitForPort(18789, { mode: 'tcp', timeout: 5000 });
      return c.json({ ok: true, status: 'running', processId: candidate.id });
    } catch {
      return c.json({ ok: false, status: 'not_responding', processId: candidate.id });
    }
  } catch (error) {
    return c.json(
      { ok: false, status: 'error', error: error instanceof Error ? error.message : 'Unknown error' },
      500
    );
  }
});

// GET /api/admin/gateway/logs - Get current gateway process logs (Cloudflare Access required)
adminApi.get('/gateway/logs', async (c) => {
  const sandbox = c.get('sandbox');

  // Prefer the active gateway process, but fall back to the most recent gateway process
  // (e.g. if it exited quickly with an error).
  const active = await findExistingMoltbotProcess(sandbox);
  const candidate =
    active ??
    (await (async () => {
      try {
        const processes = await sandbox.listProcesses();
        const gateway = processes.filter((p) => {
          const isGatewayProcess =
            p.command.includes('start-moltbot.sh') ||
            p.command.includes('clawdbot gateway') ||
            // Compatibility: upstream may use OpenClaw naming
            p.command.includes('start-openclaw.sh') ||
            p.command.includes('openclaw gateway');
          const isCliCommand =
            p.command.includes('clawdbot devices') ||
            p.command.includes('clawdbot --version') ||
            p.command.includes('openclaw devices') ||
            p.command.includes('openclaw --version') ||
            p.command.includes('openclaw onboard');
          return isGatewayProcess && !isCliCommand;
        });

        gateway.sort((a, b) => {
          const aTime = a.startTime?.getTime() ?? 0;
          const bTime = b.startTime?.getTime() ?? 0;
          return bTime - aTime;
        });

        return gateway[0] ?? null;
      } catch (err) {
        console.error('[ADMIN] listProcesses failed:', err);
        return null;
      }
    })());

  if (!candidate) {
    return c.json({ ok: false, status: 'not_running' }, 404);
  }

  const logs = await candidate.getLogs();
  return c.json({
    ok: true,
    processId: candidate.id,
    status: candidate.status,
    exitCode: candidate.exitCode ?? null,
    startTime: candidate.startTime?.toISOString() ?? null,
    endTime: candidate.endTime?.toISOString() ?? null,
    stdout: logs.stdout ?? '',
    stderr: logs.stderr ?? '',
  });
});

// GET /api/admin/devices - List pending and paired devices
adminApi.get('/devices', async (c) => {
  const sandbox = c.get('sandbox');

  try {
    // Ensure moltbot is running first
    await ensureMoltbotGateway(sandbox, c.env);

    // Run moltbot CLI to list devices (CLI is still named clawdbot until upstream renames)
    // Must specify --url to connect to the gateway running in the same container
    const token = c.env.MOLTBOT_GATEWAY_TOKEN;
    const tokenArg = token ? ` --token ${token}` : '';
    const proc = await sandbox.startProcess(`clawdbot devices list --json --url ws://localhost:18789${tokenArg}`);
    await waitForProcess(proc, CLI_TIMEOUT_MS);

    const logs = await proc.getLogs();
    const stdout = logs.stdout || '';
    const stderr = logs.stderr || '';

    // Try to parse JSON output
    try {
      // Find JSON in output (may have other log lines)
      const jsonMatch = stdout.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const data = JSON.parse(jsonMatch[0]);
        return c.json(data);
      }

      // If no JSON found, return raw output for debugging
      return c.json({
        pending: [],
        paired: [],
        raw: stdout,
        stderr,
      });
    } catch {
      return c.json({
        pending: [],
        paired: [],
        raw: stdout,
        stderr,
        parseError: 'Failed to parse CLI output',
      });
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

type PairingRequest = {
  code: string;
  id: string;
  meta?: unknown;
  createdAt?: string;
};

// GET /api/admin/pairing/:channel - List pending DM pairing requests for a channel
adminApi.get('/pairing/:channel', async (c) => {
  const sandbox = c.get('sandbox');
  const channel = c.req.param('channel')?.trim().toLowerCase();

  if (!channel) {
    return c.json({ error: 'channel is required' }, 400);
  }

  // Avoid command injection: restrict to known channels we support in the UI.
  if (!['telegram', 'discord', 'slack'].includes(channel)) {
    return c.json({ error: `unsupported channel: ${channel}` }, 400);
  }

  try {
    // Note: this is NOT "devices" pairing; it’s DM pairing (channels).
    await ensureMoltbotGateway(sandbox, c.env);
    const token = c.env.MOLTBOT_GATEWAY_TOKEN;
    const tokenArg = token ? ` --token ${token}` : '';
    const proc = await sandbox.startProcess(
      `clawdbot pairing list ${channel} --json --url ws://localhost:18789${tokenArg}`
    );
    await waitForProcess(proc, CLI_TIMEOUT_MS);

    const logs = await proc.getLogs();
    const stdout = logs.stdout || '';
    const stderr = logs.stderr || '';

    const jsonMatch = stdout.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return c.json(
        {
          channel,
          requests: [] as PairingRequest[],
          raw: stdout,
          stderr,
          parseError: 'Failed to find JSON in CLI output',
        },
        200
      );
    }

    const data = JSON.parse(jsonMatch[0]) as { channel?: string; requests?: PairingRequest[] };
    return c.json({
      channel: data.channel ?? channel,
      requests: data.requests ?? [],
      raw: stdout,
      stderr,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// POST /api/admin/pairing/:channel/approve - Approve a DM pairing code
adminApi.post('/pairing/:channel/approve', async (c) => {
  const sandbox = c.get('sandbox');
  const channel = c.req.param('channel')?.trim().toLowerCase();

  if (!channel) {
    return c.json({ error: 'channel is required' }, 400);
  }

  let body: { code?: string; notify?: boolean };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }

  const code = body.code?.trim();
  const notify = Boolean(body.notify);

  if (!code) {
    return c.json({ error: 'code is required' }, 400);
  }

  // Avoid command injection and common shell pitfalls like "<CODE>" (bash treats "<" as stdin redirect).
  // Pairing codes are 8 chars drawn from: ABCDEFGHJKLMNPQRSTUVWXYZ23456789
  const normalizedCode = code.toUpperCase();
  const pairingCodeRe = /^[A-HJ-NP-Z2-9]{8}$/;
  if (!pairingCodeRe.test(normalizedCode)) {
    return c.json(
      {
        error: 'invalid pairing code format',
        hint: 'Paste the exact 8-character pairing code (no angle brackets).',
      },
      400
    );
  }

  try {
    await ensureMoltbotGateway(sandbox, c.env);
    const token = c.env.MOLTBOT_GATEWAY_TOKEN;
    const tokenArg = token ? ` --token ${token}` : '';
    const cmd = `clawdbot pairing approve ${channel} ${normalizedCode}${notify ? ' --notify' : ''} --url ws://localhost:18789${tokenArg}`;
    const proc = await sandbox.startProcess(cmd);
    await waitForProcess(proc, CLI_TIMEOUT_MS);

    const logs = await proc.getLogs();
    const stdout = logs.stdout || '';
    const stderr = logs.stderr || '';

    const success = proc.exitCode === 0 && !stderr.toLowerCase().includes('error');

    return c.json({
      success,
      channel,
      code,
      stdout,
      stderr,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ success: false, error: errorMessage }, 500);
  }
});

// POST /api/admin/devices/:requestId/approve - Approve a pending device
adminApi.post('/devices/:requestId/approve', async (c) => {
  const sandbox = c.get('sandbox');
  const requestId = c.req.param('requestId');

  if (!requestId) {
    return c.json({ error: 'requestId is required' }, 400);
  }

  try {
    // Ensure moltbot is running first
    await ensureMoltbotGateway(sandbox, c.env);

    // Run moltbot CLI to approve the device (CLI is still named clawdbot)
    const token = c.env.MOLTBOT_GATEWAY_TOKEN;
    const tokenArg = token ? ` --token ${token}` : '';
    const proc = await sandbox.startProcess(`clawdbot devices approve ${requestId} --url ws://localhost:18789${tokenArg}`);
    await waitForProcess(proc, CLI_TIMEOUT_MS);

    const logs = await proc.getLogs();
    const stdout = logs.stdout || '';
    const stderr = logs.stderr || '';

    // Check for success indicators (case-insensitive, CLI outputs "Approved ...")
    const success = stdout.toLowerCase().includes('approved') || proc.exitCode === 0;

    return c.json({
      success,
      requestId,
      message: success ? 'Device approved' : 'Approval may have failed',
      stdout,
      stderr,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// POST /api/admin/devices/approve-all - Approve all pending devices
adminApi.post('/devices/approve-all', async (c) => {
  const sandbox = c.get('sandbox');

  try {
    // Ensure moltbot is running first
    await ensureMoltbotGateway(sandbox, c.env);

    // First, get the list of pending devices (CLI is still named clawdbot)
    const token = c.env.MOLTBOT_GATEWAY_TOKEN;
    const tokenArg = token ? ` --token ${token}` : '';
    const listProc = await sandbox.startProcess(`clawdbot devices list --json --url ws://localhost:18789${tokenArg}`);
    await waitForProcess(listProc, CLI_TIMEOUT_MS);

    const listLogs = await listProc.getLogs();
    const stdout = listLogs.stdout || '';

    // Parse pending devices
    let pending: Array<{ requestId: string }> = [];
    try {
      const jsonMatch = stdout.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const data = JSON.parse(jsonMatch[0]);
        pending = data.pending || [];
      }
    } catch {
      return c.json({ error: 'Failed to parse device list', raw: stdout }, 500);
    }

    if (pending.length === 0) {
      return c.json({ approved: [], message: 'No pending devices to approve' });
    }

    // Approve each pending device
    const results: Array<{ requestId: string; success: boolean; error?: string }> = [];

    for (const device of pending) {
      try {
        const approveProc = await sandbox.startProcess(
          `clawdbot devices approve ${device.requestId} --url ws://localhost:18789${tokenArg}`
        );
        await waitForProcess(approveProc, CLI_TIMEOUT_MS);

        const approveLogs = await approveProc.getLogs();
        const success = approveLogs.stdout?.toLowerCase().includes('approved') || approveProc.exitCode === 0;

        results.push({ requestId: device.requestId, success });
      } catch (err) {
        results.push({
          requestId: device.requestId,
          success: false,
          error: err instanceof Error ? err.message : 'Unknown error',
        });
      }
    }

    const approvedCount = results.filter(r => r.success).length;
    return c.json({
      approved: results.filter(r => r.success).map(r => r.requestId),
      failed: results.filter(r => !r.success),
      message: `Approved ${approvedCount} of ${pending.length} device(s)`,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// GET /api/admin/storage - Get R2 storage status and last sync time
adminApi.get('/storage', async (c) => {
  const sandbox = c.get('sandbox');
  const hasCredentials = !!(
    c.env.R2_ACCESS_KEY_ID && 
    c.env.R2_SECRET_ACCESS_KEY && 
    c.env.CF_ACCOUNT_ID
  );

  // Check which credentials are missing
  const missing: string[] = [];
  if (!c.env.R2_ACCESS_KEY_ID) missing.push('R2_ACCESS_KEY_ID');
  if (!c.env.R2_SECRET_ACCESS_KEY) missing.push('R2_SECRET_ACCESS_KEY');
  if (!c.env.CF_ACCOUNT_ID) missing.push('CF_ACCOUNT_ID');

  let lastSync: string | null = null;

  // If R2 is configured, check for last sync timestamp
  if (hasCredentials) {
    try {
      // Mount R2 if not already mounted
      await mountR2Storage(sandbox, c.env);
      
      // Check for sync marker file
      const proc = await sandbox.startProcess(`cat ${R2_MOUNT_PATH}/.last-sync 2>/dev/null || echo ""`);
      await waitForProcess(proc, 5000);
      const logs = await proc.getLogs();
      const timestamp = logs.stdout?.trim();
      if (timestamp && timestamp !== '') {
        lastSync = timestamp;
      }
    } catch {
      // Ignore errors checking sync status
    }
  }

  return c.json({
    configured: hasCredentials,
    missing: missing.length > 0 ? missing : undefined,
    lastSync,
    message: hasCredentials 
      ? 'R2 storage is configured. Your data will persist across container restarts.'
      : 'R2 storage is not configured. Paired devices and conversations will be lost when the container restarts.',
  });
});

function isSafeSkillName(name: string): boolean {
  // Avoid path traversal / shell injection. Skill dirs are expected to be simple slugs.
  return /^[a-zA-Z0-9._-]+$/.test(name);
}

function bashEscapeSingleQuotes(value: string): string {
  return value.replace(/'/g, `'\"'\"'`);
}

function tryParseJsonFromStdout(stdout: string): unknown | null {
  const raw = (stdout ?? '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    const obj = raw.match(/\{[\s\S]*\}/);
    if (obj) {
      try {
        return JSON.parse(obj[0]);
      } catch {
        // ignore
      }
    }
    const arr = raw.match(/\[[\s\S]*\]/);
    if (arr) {
      try {
        return JSON.parse(arr[0]);
      } catch {
        // ignore
      }
    }
  }
  return null;
}

const MEMORY_LIST_NODE_SCRIPT = `
const fs = require("fs");
const path = require("path");
const workspace = process.argv[2] || "/root/clawd";
const memoryDir = path.join(workspace, "memory");
const rootFile = path.join(workspace, "MEMORY.md");
const files = [];

function pushFile(abs, rel, kind) {
  try {
    const st = fs.statSync(abs);
    if (!st.isFile()) return;
    if (!rel.endsWith(".md")) return;
    files.push({ path: rel, kind, bytes: st.size, mtimeMs: st.mtimeMs });
  } catch {}
}

pushFile(rootFile, "MEMORY.md", "root");

function walk(dir, relBase) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const abs = path.join(dir, ent.name);
    const rel = relBase ? path.posix.join(relBase, ent.name) : ent.name;
    if (ent.isDirectory()) {
      walk(abs, rel);
      continue;
    }
    if (ent.isFile()) {
      pushFile(abs, path.posix.join("memory", rel), "memory");
    }
  }
}

if (fs.existsSync(memoryDir)) walk(memoryDir, "");
files.sort((a, b) => a.path.localeCompare(b.path));
console.log(JSON.stringify({ workspaceDir: workspace, memoryDir, files }, null, 2));
`.trim();

const NODE_EVAL_WRAPPER = 'eval(Buffer.from(process.env.OPENCLAW_NODE_SCRIPT_B64,process.env.OPENCLAW_NODE_SCRIPT_ENCODING).toString(process.env.OPENCLAW_NODE_SCRIPT_TEXT_ENCODING))';
const NODE_EVAL_ENV_BASE = {
  OPENCLAW_NODE_SCRIPT_ENCODING: 'base64',
  OPENCLAW_NODE_SCRIPT_TEXT_ENCODING: 'utf8',
} as const;

function nodeEvalEnv(script: string): Record<string, string> {
  return {
    ...NODE_EVAL_ENV_BASE,
    OPENCLAW_NODE_SCRIPT_B64: Buffer.from(script, 'utf8').toString('base64'),
  };
}

const MEMORY_READ_NODE_SCRIPT = `
const fs = require("fs");
const path = require("path");
const workspace = process.argv[2] || "/root/clawd";
const rel = (process.env.OPENCLAW_MEMORY_READ_REL || process.argv[3] || "").replace(/\\\\/g, "/");
const limitRaw = process.env.OPENCLAW_MEMORY_READ_LIMIT || process.argv[4] || "0";
const limit = Number.parseInt(String(limitRaw), 10);

if (!rel) {
  console.log(JSON.stringify({ error: "missing_path" }));
  process.exit(2);
}
if (rel !== "MEMORY.md" && !rel.startsWith("memory/")) {
  console.log(JSON.stringify({ error: "invalid_path" }));
  process.exit(2);
}
if (!rel.endsWith(".md")) {
  console.log(JSON.stringify({ error: "invalid_extension" }));
  process.exit(2);
}

const abs = path.join(workspace, rel);
const resolved = path.resolve(abs);
const resolvedWorkspace = path.resolve(workspace);
if (!resolved.startsWith(resolvedWorkspace + path.sep)) {
  console.log(JSON.stringify({ error: "path_outside_workspace" }));
  process.exit(2);
}

let st;
try {
  st = fs.statSync(resolved);
} catch {
  console.log(JSON.stringify({ error: "not_found" }));
  process.exit(2);
}

if (!st.isFile()) {
  console.log(JSON.stringify({ error: "not_file" }));
  process.exit(2);
}

let buf = fs.readFileSync(resolved);
const effectiveLimit = Number.isFinite(limit) && limit > 0 ? limit : buf.length;
const truncated = buf.length > effectiveLimit;
buf = buf.slice(0, effectiveLimit);

const content = buf.toString("utf8");
const kind = rel === "MEMORY.md" ? "root" : "memory";
console.log(JSON.stringify({ workspaceDir: workspace, path: rel, kind, bytes: st.size, mtimeMs: st.mtimeMs, content, truncated }, null, 2));
`.trim();

const MEMORY_WRITE_NODE_SCRIPT = `
const fs = require("fs");
const path = require("path");
const workspace = process.argv[2] || "/root/clawd";
const rel = (process.env.OPENCLAW_MEMORY_WRITE_REL || "").replace(/\\\\/g, "/");
const b64 = process.env.OPENCLAW_MEMORY_WRITE_B64 || "";

if (!rel) {
  console.log(JSON.stringify({ error: "missing_path" }));
  process.exit(2);
}
if (rel !== "MEMORY.md" && !rel.startsWith("memory/")) {
  console.log(JSON.stringify({ error: "invalid_path" }));
  process.exit(2);
}
if (!rel.endsWith(".md")) {
  console.log(JSON.stringify({ error: "invalid_extension" }));
  process.exit(2);
}

let contentBuf;
try {
  contentBuf = Buffer.from(b64, "base64");
} catch {
  console.log(JSON.stringify({ error: "invalid_base64" }));
  process.exit(2);
}

const abs = path.join(workspace, rel);
const resolved = path.resolve(abs);
const resolvedWorkspace = path.resolve(workspace);
if (!resolved.startsWith(resolvedWorkspace + path.sep)) {
  console.log(JSON.stringify({ error: "path_outside_workspace" }));
  process.exit(2);
}

const dir = path.dirname(resolved);
fs.mkdirSync(dir, { recursive: true });

const tmp = resolved + ".tmp." + process.pid + "." + Date.now();
fs.writeFileSync(tmp, contentBuf);
fs.renameSync(tmp, resolved);

const st = fs.statSync(resolved);
const kind = rel === "MEMORY.md" ? "root" : "memory";
console.log(JSON.stringify({ workspaceDir: workspace, path: rel, kind, bytes: st.size, mtimeMs: st.mtimeMs }, null, 2));
`.trim();

const MEMORY_DELETE_NODE_SCRIPT = `
const fs = require("fs");
const path = require("path");
const workspace = process.argv[2] || "/root/clawd";
const rel = (process.env.OPENCLAW_MEMORY_DELETE_REL || "").replace(/\\\\/g, "/");

if (!rel) {
  console.log(JSON.stringify({ error: "missing_path" }));
  process.exit(2);
}

// Safety: only allow deleting memory/ files (not MEMORY.md).
if (!rel.startsWith("memory/") || rel === "memory/" || !rel.endsWith(".md")) {
  console.log(JSON.stringify({ error: "invalid_path" }));
  process.exit(2);
}

const abs = path.join(workspace, rel);
const resolved = path.resolve(abs);
const resolvedWorkspace = path.resolve(workspace);
if (!resolved.startsWith(resolvedWorkspace + path.sep)) {
  console.log(JSON.stringify({ error: "path_outside_workspace" }));
  process.exit(2);
}

try {
  fs.unlinkSync(resolved);
  console.log(JSON.stringify({ ok: true }));
} catch (err) {
  if (err && err.code === "ENOENT") {
    console.log(JSON.stringify({ error: "not_found" }));
    process.exit(2);
  }
  console.log(JSON.stringify({ error: "delete_failed", details: String(err) }));
  process.exit(2);
}
`.trim();

const MEMORY_DELETE_ALL_NODE_SCRIPT = `
const fs = require("fs");
const path = require("path");
const workspace = process.argv[2] || "/root/clawd";
const memoryDir = path.join(workspace, "memory");
const deleted = [];

function walk(dir, relBase) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const abs = path.join(dir, ent.name);
    const rel = relBase ? path.posix.join(relBase, ent.name) : ent.name;
    if (ent.isDirectory()) {
      walk(abs, rel);
      continue;
    }
    if (ent.isFile() && rel.endsWith(".md")) {
      try {
        fs.unlinkSync(abs);
        deleted.push(path.posix.join("memory", rel));
      } catch {}
    }
  }
}

if (fs.existsSync(memoryDir)) walk(memoryDir, "");
deleted.sort((a, b) => a.localeCompare(b));
console.log(JSON.stringify({ ok: true, deleted }, null, 2));
`.trim();

const MEMORY_EXPORT_NODE_SCRIPT = `
const fs = require("fs");
const path = require("path");
const workspace = process.argv[2] || "/root/clawd";
const maxBytes = Number.parseInt(String(process.env.OPENCLAW_MEMORY_EXPORT_MAX_BYTES || process.argv[3] || "0"), 10);
const memoryDir = path.join(workspace, "memory");
const rootFile = path.join(workspace, "MEMORY.md");

const files = [];
function pushFile(abs, rel, kind) {
  let st;
  try {
    st = fs.statSync(abs);
  } catch { return; }
  if (!st.isFile()) return;
  if (!rel.endsWith(".md")) return;
  files.push({ abs, path: rel, kind, bytes: st.size, mtimeMs: st.mtimeMs });
}
pushFile(rootFile, "MEMORY.md", "root");

function walk(dir, relBase) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch { return; }
  for (const ent of entries) {
    const abs = path.join(dir, ent.name);
    const rel = relBase ? path.posix.join(relBase, ent.name) : ent.name;
    if (ent.isDirectory()) walk(abs, rel);
    else if (ent.isFile()) pushFile(abs, path.posix.join("memory", rel), "memory");
  }
}
if (fs.existsSync(memoryDir)) walk(memoryDir, "");
files.sort((a, b) => a.path.localeCompare(b.path));

let total = 0;
const out = [];
for (const f of files) {
  let content = "";
  let truncated = false;
  try {
    const buf = fs.readFileSync(f.abs);
    const remain = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.max(0, maxBytes - total) : buf.length;
    if (Number.isFinite(maxBytes) && maxBytes > 0 && buf.length > remain) {
      truncated = true;
      content = buf.slice(0, remain).toString("utf8");
      total += remain;
    } else {
      content = buf.toString("utf8");
      total += buf.length;
    }
  } catch {
    continue;
  }
  out.push({ path: f.path, kind: f.kind, bytes: f.bytes, mtimeMs: f.mtimeMs, content, truncated });
  if (Number.isFinite(maxBytes) && maxBytes > 0 && total >= maxBytes) break;
}
console.log(JSON.stringify({ workspaceDir: workspace, memoryDir, totalBytes: total, maxBytes, files: out }, null, 2));
`.trim();

function buildMemoryFilesListCommand(): string {
  return `bash -lc "set -euo pipefail; node -e '${NODE_EVAL_WRAPPER}' \\\"$(clawdbot config get workspace.dir 2>/dev/null || echo /root/clawd)\\\""`;
}

function buildMemoryFileReadCommand(relPath: string, opts: { limitBytes?: number } = {}): string {
  const limitBytes = typeof opts.limitBytes === 'number' ? opts.limitBytes : MEMORY_READ_LIMIT_BYTES;
  return `bash -lc "set -euo pipefail; node -e '${NODE_EVAL_WRAPPER}' \\\"$(clawdbot config get workspace.dir 2>/dev/null || echo /root/clawd)\\\""`;
}

function buildMemoryFileWriteCommand(): string {
  return `bash -lc "set -euo pipefail; node -e '${NODE_EVAL_WRAPPER}' \\\"$(clawdbot config get workspace.dir 2>/dev/null || echo /root/clawd)\\\""`;
}

function buildMemoryFileDeleteCommand(): string {
  return `bash -lc "set -euo pipefail; node -e '${NODE_EVAL_WRAPPER}' \\\"$(clawdbot config get workspace.dir 2>/dev/null || echo /root/clawd)\\\""`;
}

function buildMemoryDeleteAllCommand(): string {
  return `bash -lc "set -euo pipefail; node -e '${NODE_EVAL_WRAPPER}' \\\"$(clawdbot config get workspace.dir 2>/dev/null || echo /root/clawd)\\\""`;
}

function buildMemoryExportCommand(maxBytes: number): string {
  return `bash -lc "set -euo pipefail; node -e '${NODE_EVAL_WRAPPER}' \\\"$(clawdbot config get workspace.dir 2>/dev/null || echo /root/clawd)\\\""`;
}

// GET /api/admin/skills - List skills via clawdbot (bundled + managed + workspace)
adminApi.get('/skills', async (c) => {
  const sandbox = c.get('sandbox');

  const proc = await sandbox.startProcess('clawdbot skills list --json');
  await waitForProcess(proc, CLI_TIMEOUT_MS);
  const logs = await proc.getLogs();
  const stdout = logs.stdout ?? '';

  try {
    const parsed = JSON.parse(stdout) as unknown;
    return c.json(parsed);
  } catch (err) {
    return c.json(
      {
        error: 'Failed to parse clawdbot skills list output',
        details: err instanceof Error ? err.message : 'Unknown error',
        stdout,
        stderr: logs.stderr ?? '',
      },
      500
    );
  }
});

// GET /api/admin/skills/:name - Skill details from clawdbot + SKILL.md content
adminApi.get('/skills/:name', async (c) => {
  const sandbox = c.get('sandbox');
  const name = c.req.param('name');

  if (!isSafeSkillName(name)) {
    return c.json({ error: 'Invalid skill name' }, 400);
  }

  const infoProc = await sandbox.startProcess(`clawdbot skills info ${name} --json`);
  await waitForProcess(infoProc, CLI_TIMEOUT_MS);
  const infoLogs = await infoProc.getLogs();
  const infoStdout = infoLogs.stdout ?? '';

  let skill: any;
  try {
    skill = JSON.parse(infoStdout);
  } catch (err) {
    return c.json(
      {
        error: 'Failed to parse clawdbot skills info output',
        details: err instanceof Error ? err.message : 'Unknown error',
        stdout: infoStdout,
        stderr: infoLogs.stderr ?? '',
      },
      500
    );
  }

  if (skill && typeof skill === 'object' && skill.error === 'not found') {
    return c.json({ error: 'Skill not found' }, 404);
  }

  const filePath = typeof skill?.filePath === 'string' ? skill.filePath : '';
  let skillMd: string | null = null;
  let truncated = false;

  if (filePath) {
    const escaped = bashEscapeSingleQuotes(filePath);
    const cmd = `bash -lc "set -euo pipefail; FILE='${escaped}'; if [ -f \\\"$FILE\\\" ]; then head -c ${SKILL_READ_LIMIT_BYTES} \\\"$FILE\\\"; fi"`;
    const mdProc = await sandbox.startProcess(cmd);
    await waitForProcess(mdProc, CLI_TIMEOUT_MS);
    const mdLogs = await mdProc.getLogs();
    const md = mdLogs.stdout ?? '';
    if (md.length > 0) {
      skillMd = md;
      truncated = md.length >= SKILL_READ_LIMIT_BYTES;
    }
  }

  return c.json({ skill, skillMd, truncated });
});

// POST /api/admin/skills/:skillKey/enabled - Toggle a skill via config override
adminApi.post('/skills/:skillKey/enabled', async (c) => {
  const sandbox = c.get('sandbox');
  const skillKey = c.req.param('skillKey');

  if (!isSafeSkillName(skillKey)) {
    return c.json({ error: 'Invalid skill key' }, 400);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const enabled = (body as any)?.enabled;
  if (typeof enabled !== 'boolean') {
    return c.json({ error: 'Body must include boolean "enabled"' }, 400);
  }

  // Quote the path arg to avoid shell glob expansion (bracket notation) and to safely support hyphens.
  const configPath = `skills.entries[${skillKey}].enabled`;
  const cmd = `clawdbot config set '${configPath}' ${enabled ? 'true' : 'false'}`;
  const proc = await sandbox.startProcess(cmd);
  await waitForProcess(proc, CLI_TIMEOUT_MS);
  const logs = await proc.getLogs();

  return c.json({
    success: true,
    skillKey,
    enabled,
    stdout: logs.stdout ?? '',
    stderr: logs.stderr ?? '',
  });
});

// GET /api/admin/memory/files - List MEMORY.md and workspace memory/*.md files
adminApi.get('/memory/files', async (c) => {
  const sandbox = c.get('sandbox');

  try {
    const proc = await sandbox.startProcess(buildMemoryFilesListCommand(), {
      env: nodeEvalEnv(MEMORY_LIST_NODE_SCRIPT),
    });
    await waitForProcess(proc, CLI_TIMEOUT_MS);

    // Some sandbox implementations can lag on proc.status; poll logs briefly for JSON output.
    let attempts = 0;
    let stdout = '';
    let stderr = '';
    let parsed: MemoryFilesResponse | null = null;
    while (attempts < 10) {
      const logs = await proc.getLogs();
      stdout = logs.stdout ?? '';
      stderr = logs.stderr ?? '';
      parsed = tryParseJsonFromStdout(stdout) as MemoryFilesResponse | null;
      if (parsed) break;
      // eslint-disable-next-line no-await-in-loop -- intentional sequential polling
      await new Promise((r) => setTimeout(r, 300));
      attempts += 1;
    }

    if (parsed) return c.json(parsed);

    return c.json(
      {
        error: 'Failed to list memory files',
        status: proc.status,
        exitCode: proc.exitCode ?? null,
        attempts,
        stdout,
        stderr,
      },
      500,
    );
  } catch (err) {
    return c.json(
      {
        error: 'Failed to list memory files',
        details: err instanceof Error ? err.message : String(err),
      },
      500,
    );
  }
});

// GET /api/admin/memory/file?path=... - Read a memory file (truncated)
adminApi.get('/memory/file', async (c) => {
  const sandbox = c.get('sandbox');
  const rawPath = c.req.query('path') ?? null;
  const relPath = normalizeMemoryPath(rawPath);

  if (!relPath) {
    return c.json({ error: 'Invalid memory path', hint: 'Use MEMORY.md or memory/<file>.md' }, 400);
  }

  let stdout = '';
  let stderr = '';
  try {
    const proc = await sandbox.startProcess(buildMemoryFileReadCommand(relPath), {
      env: {
        ...nodeEvalEnv(MEMORY_READ_NODE_SCRIPT),
        OPENCLAW_MEMORY_READ_REL: relPath,
        OPENCLAW_MEMORY_READ_LIMIT: String(MEMORY_READ_LIMIT_BYTES),
      },
    });
    await waitForProcess(proc, CLI_TIMEOUT_MS);
    const logs = await proc.getLogs();
    stdout = logs.stdout ?? '';
    stderr = logs.stderr ?? '';
  } catch (err) {
    return c.json(
      {
        error: 'Failed to read memory file',
        details: err instanceof Error ? err.message : String(err),
      },
      500,
    );
  }

  const parsed = tryParseJsonFromStdout(stdout) as (MemoryFileResponse | { error: string }) | null;
  if (!parsed) {
    return c.json(
      {
        error: 'Failed to read memory file',
        stdout,
        stderr,
      },
      500,
    );
  }

  if ('error' in parsed) {
    const code = parsed.error === 'not_found' ? 404 : 400;
    return c.json({ error: parsed.error }, code);
  }

  return c.json(parsed);
});

// GET /api/admin/memory/file/raw?path=... - Read a memory file (raw markdown)
adminApi.get('/memory/file/raw', async (c) => {
  const sandbox = c.get('sandbox');
  const rawPath = c.req.query('path') ?? null;
  const relPath = normalizeMemoryPath(rawPath);

  if (!relPath) {
    return c.json({ error: 'Invalid memory path', hint: 'Use MEMORY.md or memory/<file>.md' }, 400);
  }

  let stdout = '';
  let stderr = '';
  try {
    const proc = await sandbox.startProcess(buildMemoryFileReadCommand(relPath, { limitBytes: 0 }), {
      env: {
        ...nodeEvalEnv(MEMORY_READ_NODE_SCRIPT),
        OPENCLAW_MEMORY_READ_REL: relPath,
        OPENCLAW_MEMORY_READ_LIMIT: '0',
      },
    });
    await waitForProcess(proc, CLI_TIMEOUT_MS);
    const logs = await proc.getLogs();
    stdout = logs.stdout ?? '';
    stderr = logs.stderr ?? '';
  } catch (err) {
    return c.json(
      {
        error: 'Failed to read memory file',
        details: err instanceof Error ? err.message : String(err),
      },
      500,
    );
  }

  const parsed = tryParseJsonFromStdout(stdout) as (MemoryFileResponse | { error: string }) | null;
  if (!parsed) {
    return c.json(
      {
        error: 'Failed to read memory file',
        stdout,
        stderr,
      },
      500,
    );
  }

  if ('error' in parsed) {
    const code = parsed.error === 'not_found' ? 404 : 400;
    return c.json({ error: parsed.error }, code);
  }

  return c.text(parsed.content, 200, { 'Content-Type': 'text/markdown; charset=utf-8' });
});

// POST /api/admin/memory/file - Create/update a memory file (MEMORY.md or memory/*.md)
adminApi.post('/memory/file', async (c) => {
  const sandbox = c.get('sandbox');

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const pathRaw = (body as any)?.path;
  const contentRaw = (body as any)?.content;
  if (typeof pathRaw !== 'string' || typeof contentRaw !== 'string') {
    return c.json({ error: 'Body must include string "path" and string "content"' }, 400);
  }

  const relPath = normalizeMemoryPath(pathRaw);
  if (!relPath) {
    return c.json({ error: 'Invalid memory path', hint: 'Use MEMORY.md or memory/<file>.md' }, 400);
  }

  const contentBytes = Buffer.byteLength(contentRaw, 'utf8');
  if (contentBytes > MEMORY_WRITE_LIMIT_BYTES) {
    return c.json(
      {
        error: 'Content too large',
        limitBytes: MEMORY_WRITE_LIMIT_BYTES,
        bytes: contentBytes,
        hint: 'Split into multiple memory/*.md files or use a smaller edit via the debug CLI.',
      },
      413,
    );
  }

  const contentBase64 = Buffer.from(contentRaw, 'utf8').toString('base64');
  const proc = await sandbox.startProcess(buildMemoryFileWriteCommand(), {
    env: {
      ...nodeEvalEnv(MEMORY_WRITE_NODE_SCRIPT),
      OPENCLAW_MEMORY_WRITE_REL: relPath,
      OPENCLAW_MEMORY_WRITE_B64: contentBase64,
    },
  });
  await waitForProcess(proc, CLI_TIMEOUT_MS);
  const logs = await proc.getLogs();

  const parsed = tryParseJsonFromStdout(logs.stdout ?? '') as ({ error?: string } & Partial<MemoryFileResponse>) | null;
  if (parsed) {
    if (typeof parsed.error === 'string') return c.json({ error: parsed.error }, 400);
    return c.json(parsed);
  }

  return c.json(
    {
      error: 'Failed to write memory file',
      stdout: logs.stdout ?? '',
      stderr: logs.stderr ?? '',
    },
    500,
  );
});

// DELETE /api/admin/memory/file?path=... - Delete a memory file under memory/*.md (not MEMORY.md)
adminApi.delete('/memory/file', async (c) => {
  const sandbox = c.get('sandbox');
  const rawPath = c.req.query('path') ?? null;
  const relPath = normalizeMemoryPath(rawPath);

  if (!relPath) {
    return c.json({ error: 'Invalid memory path', hint: 'Use memory/<file>.md' }, 400);
  }
  if (!relPath.startsWith('memory/')) {
    return c.json({ error: 'Refusing to delete non-memory/ file', hint: 'Only memory/*.md can be deleted via this UI.' }, 400);
  }

  const proc = await sandbox.startProcess(buildMemoryFileDeleteCommand(), {
    env: {
      ...nodeEvalEnv(MEMORY_DELETE_NODE_SCRIPT),
      OPENCLAW_MEMORY_DELETE_REL: relPath,
    },
  });
  await waitForProcess(proc, CLI_TIMEOUT_MS);
  const logs = await proc.getLogs();

  const parsed = tryParseJsonFromStdout(logs.stdout ?? '') as { ok?: boolean; error?: string; details?: string } | null;
  if (parsed) {
    if (parsed.ok) return c.json({ ok: true });
    if (parsed.error === 'not_found') return c.json({ error: 'not_found' }, 404);
    return c.json({ error: parsed.error ?? 'delete_failed', details: parsed.details }, 400);
  }

  return c.json(
    {
      error: 'Failed to delete memory file',
      stdout: logs.stdout ?? '',
      stderr: logs.stderr ?? '',
    },
    500,
  );
});

// GET /api/admin/memory/export - Export all memory files as JSON (content may be truncated if too large)
adminApi.get('/memory/export', async (c) => {
  const sandbox = c.get('sandbox');
  const format = (c.req.query('format') ?? 'v1').trim().toLowerCase();
  let stdout = '';
  let stderr = '';
  try {
    const proc = await sandbox.startProcess(buildMemoryExportCommand(MEMORY_EXPORT_LIMIT_BYTES), {
      env: {
        ...nodeEvalEnv(MEMORY_EXPORT_NODE_SCRIPT),
        OPENCLAW_MEMORY_EXPORT_MAX_BYTES: String(MEMORY_EXPORT_LIMIT_BYTES),
      },
    });
    await waitForProcess(proc, CLI_TIMEOUT_MS);
    const logs = await proc.getLogs();
    stdout = logs.stdout ?? '';
    stderr = logs.stderr ?? '';
  } catch (err) {
    return c.json(
      {
        error: 'Failed to export memory',
        details: err instanceof Error ? err.message : String(err),
      },
      500,
    );
  }

  const parsed: any = tryParseJsonFromStdout(stdout);
  if (!parsed) {
    return c.json(
      {
        error: 'Failed to export memory',
        stdout,
        stderr,
      },
      500,
    );
  }

  if (format === 'legacy') {
    return c.body(stdout, 200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': 'attachment; filename="openclaw-memory-export.legacy.json"',
    });
  }

  const files = Array.isArray(parsed?.files)
    ? parsed.files
        .map((f: any) => ({ path: f?.path, content: f?.content }))
        .filter((f: any) => typeof f.path === 'string' && typeof f.content === 'string')
    : [];

  const v1 = {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    files: files.sort((a: any, b: any) => String(a.path).localeCompare(String(b.path))),
  };

  const body = JSON.stringify(v1, null, 2);
  return c.body(body, 200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Disposition': 'attachment; filename="openclaw-memory-export.json"',
  });
});

// POST /api/admin/memory/import - Import memory files from JSON export
adminApi.post('/memory/import', async (c) => {
  const sandbox = c.get('sandbox');

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const modeRaw = (body as any)?.mode;
  const mode: MemoryImportMode = modeRaw === 'merge' ? 'merge' : 'overwrite';
  const dryRun = Boolean((body as any)?.dryRun);
  const data = (body as any)?.data ?? body;

  const coerced = coerceMemoryImportData(data);
  if (!coerced.ok) return c.json({ error: coerced.error }, 400);

  const validated = validateMemoryImportData(coerced.data);
  if (!validated.ok) return c.json({ error: validated.error, details: validated.details }, 400);

  if (validated.value.files.length > MEMORY_IMPORT_FILE_LIMIT) {
    return c.json({ error: 'Too many files', details: { count: validated.value.files.length, limit: MEMORY_IMPORT_FILE_LIMIT } }, 400);
  }

  // For overwrite mode, show what would be deleted based on current workspace state.
  let existingMemoryFiles: string[] = [];
  if (mode === 'overwrite' || dryRun) {
    const listProc = await sandbox.startProcess(buildMemoryFilesListCommand(), {
      env: nodeEvalEnv(MEMORY_LIST_NODE_SCRIPT),
    });
    await waitForProcess(listProc, CLI_TIMEOUT_MS);
    const logs = await listProc.getLogs();
    try {
      const listed = JSON.parse(logs.stdout ?? '') as MemoryFilesResponse;
      existingMemoryFiles = (listed.files ?? []).map((f) => f.path).filter((p) => typeof p === 'string' && p.startsWith('memory/'));
    } catch {
      // If listing fails, continue without a delete preview.
      existingMemoryFiles = [];
    }
  }

  const deleted = mode === 'overwrite' ? existingMemoryFiles : [];
  const wrote = validated.value.files.map((f) => f.path);

  if (dryRun) {
    return c.json({ ok: true, dryRun: true, mode, deleted, wrote, totalBytes: validated.value.totalBytes });
  }

  if (mode === 'overwrite') {
    const delProc = await sandbox.startProcess(buildMemoryDeleteAllCommand(), {
      env: nodeEvalEnv(MEMORY_DELETE_ALL_NODE_SCRIPT),
    });
    await waitForProcess(delProc, CLI_TIMEOUT_MS);
  }

  for (const file of validated.value.files) {
    const contentBase64 = Buffer.from(file.content, 'utf8').toString('base64');
    const proc = await sandbox.startProcess(buildMemoryFileWriteCommand(), {
      env: {
        ...nodeEvalEnv(MEMORY_WRITE_NODE_SCRIPT),
        OPENCLAW_MEMORY_WRITE_REL: file.path,
        OPENCLAW_MEMORY_WRITE_B64: contentBase64,
      },
    });
    await waitForProcess(proc, CLI_TIMEOUT_MS);
    const logs = await proc.getLogs();
    const res = tryParseJsonFromStdout(logs.stdout ?? '') as { error?: string } | null;
    if (!res) {
      return c.json(
        { error: 'Import failed while writing file', details: { path: file.path, stdout: logs.stdout ?? '', stderr: logs.stderr ?? '' } },
        500,
      );
    }
    if (typeof res.error === 'string') {
      return c.json({ error: 'Import failed while writing file', details: { path: file.path, error: res.error } }, 500);
    }
  }

  return c.json({ ok: true, dryRun: false, mode, deleted, wrote, totalBytes: validated.value.totalBytes });
});

// POST /api/admin/storage/sync - Trigger a manual sync to R2
adminApi.post('/storage/sync', async (c) => {
  const sandbox = c.get('sandbox');
  
  const result = await syncToR2(sandbox, c.env);
  
  if (result.success) {
    return c.json({
      success: true,
      message: 'Sync completed successfully',
      lastSync: result.lastSync,
    });
  } else {
    const status = result.error?.includes('not configured') ? 400 : 500;
    return c.json({
      success: false,
      error: result.error,
      details: result.details,
    }, status);
  }
});

// POST /api/admin/gateway/restart - Kill the current gateway and start a new one
adminApi.post('/gateway/restart', async (c) => {
  const sandbox = c.get('sandbox');

  try {
    // Find and kill the existing gateway process
    const existingProcess = await findExistingMoltbotProcess(sandbox);
    
    if (existingProcess) {
      console.log('Killing existing gateway process:', existingProcess.id);
      try {
        await existingProcess.kill();
      } catch (killErr) {
        console.error('Error killing process:', killErr);
      }
      // Wait a moment for the process to die
      await new Promise(r => setTimeout(r, 2000));
    }

    // Start a new gateway in the background
    const bootPromise = ensureMoltbotGateway(sandbox, c.env).catch((err) => {
      console.error('Gateway restart failed:', err);
    });
    c.executionCtx.waitUntil(bootPromise);

    return c.json({
      success: true,
      message: existingProcess 
        ? 'Gateway process killed, new instance starting...'
        : 'No existing process found, starting new instance...',
      previousProcessId: existingProcess?.id,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// POST /api/admin/sandbox/destroy - Destroy the sandbox container (kills processes + deletes files)
// Use this when the container image/startup script is stuck in a bad state after deploy.
// WARNING: Without R2 configured, this will permanently delete your moltbot config and paired devices.
adminApi.post('/sandbox/destroy', async (c) => {
  const sandbox = c.get('sandbox');

  try {
    await sandbox.destroy();
    return c.json({
      success: true,
      message: 'Sandbox destroyed. Reload to recreate the container.',
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ success: false, error: errorMessage }, 500);
  }
});

// Mount admin API routes under /admin
api.route('/admin', adminApi);

export { api };
