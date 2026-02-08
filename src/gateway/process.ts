import type { Sandbox, Process } from '@cloudflare/sandbox';
import type { MoltbotEnv } from '../types';
import { MOLTBOT_PORT, STARTUP_TIMEOUT_MS } from '../config';
import { buildEnvVars } from './env';
import { mountR2Storage } from './r2';

function buildWsProbeRequest(token?: string): Request {
  const url = new URL('http://localhost/');
  if (token) url.searchParams.set('token', token);

  // Minimal WebSocket upgrade headers.
  // (Key can be any base64-ish string; server will compute accept if it supports WS.)
  return new Request(url.toString(), {
    method: 'GET',
    headers: {
      Connection: 'Upgrade',
      Upgrade: 'websocket',
      'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': 'dGVzdC1wcm9iZS1rZXk=',
    },
  });
}

async function isGatewayListening(sandbox: Sandbox, token?: string): Promise<boolean> {
  try {
    const res = await sandbox.wsConnect(buildWsProbeRequest(token), MOLTBOT_PORT);
    const ws = res.webSocket;
    if (!ws) return false;
    ws.accept();
    ws.close(1000, 'probe');
    return true;
  } catch {
    return false;
  }
}

async function findMostRecentGatewayProcess(sandbox: Sandbox): Promise<Process | null> {
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
    console.error('[Gateway] listProcesses failed while finding most recent gateway process:', err);
    return null;
  }
}

function shouldRecreateSandboxFromStartupLogs(stderr: string, stdout: string): boolean {
  const combined = `${stderr}\n${stdout}`;

  // These indicate the container image/start script itself is broken or stale.
  // Recreating the sandbox container is usually the fastest recovery.
  if (combined.includes('SyntaxError: Invalid regular expression flags')) return true;
  if (combined.includes('/bin/bash^M: bad interpreter')) return true;
  if (combined.includes('bad substitution') && combined.includes('process.env.')) return true;

  return false;
}

/**
 * Start a new Moltbot gateway process (does not wait for readiness).
 *
 * Useful for UI endpoints that want to kick off startup quickly and then poll.
 */
export async function startMoltbotGatewayProcess(sandbox: Sandbox, env: MoltbotEnv): Promise<Process> {
  // Mount R2 storage for persistent data (non-blocking if not configured)
  await mountR2Storage(sandbox, env);

  const envVars = buildEnvVars(env);
  const command = '/usr/local/bin/start-moltbot.sh';

  console.log('Starting process with command:', command);
  console.log('Environment vars being passed:', Object.keys(envVars));

  return sandbox.startProcess(command, {
    env: Object.keys(envVars).length > 0 ? envVars : undefined,
  });
}

/**
 * Find an existing Moltbot gateway process
 * 
 * @param sandbox - The sandbox instance
 * @returns The process if found and running/starting, null otherwise
 */
export async function findExistingMoltbotProcess(sandbox: Sandbox): Promise<Process | null> {
  try {
    const processes = await sandbox.listProcesses();
    for (const proc of processes) {
      // Only match the gateway process, not CLI commands like "clawdbot devices list"
      // Note: CLI is still named "clawdbot" until upstream renames it
      const isGatewayProcess = 
        proc.command.includes('start-moltbot.sh') ||
        proc.command.includes('clawdbot gateway') ||
        // Compatibility: upstream may use OpenClaw naming
        proc.command.includes('start-openclaw.sh') ||
        proc.command.includes('openclaw gateway');
      const isCliCommand = 
        proc.command.includes('clawdbot devices') ||
        proc.command.includes('clawdbot --version') ||
        proc.command.includes('openclaw devices') ||
        proc.command.includes('openclaw --version') ||
        proc.command.includes('openclaw onboard');
      
      if (isGatewayProcess && !isCliCommand) {
        if (proc.status === 'starting' || proc.status === 'running') {
          return proc;
        }
      }
    }
  } catch (e) {
    console.log('Could not list processes:', e);
  }
  return null;
}

/**
 * Ensure the Moltbot gateway is running
 * 
 * This will:
 * 1. Mount R2 storage if configured
 * 2. Check for an existing gateway process
 * 3. Wait for it to be ready, or start a new one
 * 
 * @param sandbox - The sandbox instance
 * @param env - Worker environment bindings
 * @returns The running gateway process
 */
export async function ensureMoltbotGateway(
  sandbox: Sandbox,
  env: MoltbotEnv,
  opts: { recreateAttempted?: boolean } = {}
): Promise<Process> {
  // Mount R2 storage for persistent data (non-blocking if not configured)
  // R2 is used as a backup - the startup script will restore from it on boot
  await mountR2Storage(sandbox, env);

  // If the gateway is already listening, we don't need to start anything.
  // This covers cases where the gateway runs under an internal supervisor and
  // doesn't show up as a "running" Process via listProcesses().
  if (await isGatewayListening(sandbox, env.MOLTBOT_GATEWAY_TOKEN)) {
    console.log('[Gateway] Gateway port is already listening.');
    return (await findExistingMoltbotProcess(sandbox)) ?? (await findMostRecentGatewayProcess(sandbox)) ?? ({} as Process);
  }

  // Check if Moltbot is already running or starting
  const existingProcess = await findExistingMoltbotProcess(sandbox);
  if (existingProcess) {
    console.log('Found existing Moltbot process:', existingProcess.id, 'status:', existingProcess.status);

    // Always use full startup timeout - a process can be "running" but not ready yet
    // (e.g., just started by another concurrent request). Using a shorter timeout
    // causes race conditions where we kill processes that are still initializing.
    try {
      console.log('Waiting for Moltbot gateway on port', MOLTBOT_PORT, 'timeout:', STARTUP_TIMEOUT_MS);
      await existingProcess.waitForPort(MOLTBOT_PORT, { mode: 'tcp', timeout: STARTUP_TIMEOUT_MS });
      console.log('Moltbot gateway is reachable');
      return existingProcess;
    } catch (e) {
      if (await isGatewayListening(sandbox, env.MOLTBOT_GATEWAY_TOKEN)) {
        console.log('[Gateway] Gateway is reachable despite waitForPort error; proceeding.');
        return existingProcess;
      }
      // Timeout waiting for port - process is likely dead or stuck, kill and restart
      console.log('Existing process not reachable after full timeout, killing and restarting...');
      try {
        await existingProcess.kill();
      } catch (killError) {
        console.log('Failed to kill process:', killError);
      }
    }
  }

  // Start a new Moltbot gateway
  console.log('Starting new Moltbot gateway...');
  let process: Process;
  try {
    process = await startMoltbotGatewayProcess(sandbox, env);
    console.log('Process started with id:', process.id, 'status:', process.status);
  } catch (startErr) {
    console.error('Failed to start process:', startErr);
    throw startErr;
  }

  // Wait for the gateway to be ready
  try {
    console.log('[Gateway] Waiting for Moltbot gateway to be ready on port', MOLTBOT_PORT);
    await process.waitForPort(MOLTBOT_PORT, { mode: 'tcp', timeout: STARTUP_TIMEOUT_MS });
    console.log('[Gateway] Moltbot gateway is ready!');

    const logs = await process.getLogs();
    if (logs.stdout) console.log('[Gateway] stdout:', logs.stdout);
    if (logs.stderr) console.log('[Gateway] stderr:', logs.stderr);
  } catch (e) {
    console.error('[Gateway] waitForPort failed:', e);
    if (await isGatewayListening(sandbox, env.MOLTBOT_GATEWAY_TOKEN)) {
      console.log('[Gateway] Gateway port is listening despite waitForPort failure; proceeding.');
      return process;
    }
    let logs: { stdout?: string; stderr?: string };
    try {
      logs = await process.getLogs();
    } catch (logErr) {
      console.error('[Gateway] Failed to get logs:', logErr);
      throw e;
    }

    console.error('[Gateway] startup failed. Stderr:', logs.stderr);
    console.error('[Gateway] startup failed. Stdout:', logs.stdout);

    const stderr = logs.stderr ?? '';
    const stdout = logs.stdout ?? '';

    // Self-heal: if we deployed a fixed image but the sandbox container is still
    // running an older cached filesystem, destroy and recreate it once.
    if (!opts.recreateAttempted && shouldRecreateSandboxFromStartupLogs(stderr, stdout)) {
      console.warn(
        '[Gateway] Startup looks like a stale/broken container image. Destroying sandbox and retrying once...'
      );
      try {
        await sandbox.destroy();
      } catch (destroyErr) {
        console.error('[Gateway] sandbox.destroy() failed:', destroyErr);
      }

      return ensureMoltbotGateway(sandbox, env, { recreateAttempted: true });
    }

    throw new Error(`Moltbot gateway failed to start. Stderr: ${stderr || '(empty)'}`);
  }

  // Verify gateway is actually responding
  console.log('[Gateway] Verifying gateway health...');
  
  return process;
}
