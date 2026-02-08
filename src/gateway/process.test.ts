import { describe, it, expect, vi } from 'vitest';
import { ensureMoltbotGateway, findExistingMoltbotProcess } from './process';
import type { Sandbox, Process } from '@cloudflare/sandbox';
import { createMockEnv, createMockSandbox, suppressConsole } from '../test-utils';

// Helper to create a full mock process (with methods needed for process tests)
function createFullMockProcess(overrides: Partial<Process> = {}): Process {
  return {
    id: 'test-id',
    command: 'clawdbot gateway',
    status: 'running',
    startTime: new Date(),
    endTime: undefined,
    exitCode: undefined,
    waitForPort: vi.fn(),
    kill: vi.fn(),
    getLogs: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
    ...overrides,
  } as Process;
}

describe('findExistingMoltbotProcess', () => {
  it('returns null when no processes exist', async () => {
    const { sandbox } = createMockSandbox({ processes: [] });
    const result = await findExistingMoltbotProcess(sandbox);
    expect(result).toBeNull();
  });

  it('returns null when only CLI commands are running', async () => {
    const processes = [
      createFullMockProcess({ command: 'clawdbot devices list --json', status: 'running' }),
      createFullMockProcess({ command: 'clawdbot --version', status: 'completed' }),
    ];
    const { sandbox, listProcessesMock } = createMockSandbox();
    listProcessesMock.mockResolvedValue(processes);
    
    const result = await findExistingMoltbotProcess(sandbox);
    expect(result).toBeNull();
  });

  it('returns gateway process when running', async () => {
    const gatewayProcess = createFullMockProcess({ 
      id: 'gateway-1',
      command: 'clawdbot gateway --port 18789', 
      status: 'running' 
    });
    const processes = [
      createFullMockProcess({ command: 'clawdbot devices list', status: 'completed' }),
      gatewayProcess,
    ];
    const { sandbox, listProcessesMock } = createMockSandbox();
    listProcessesMock.mockResolvedValue(processes);
    
    const result = await findExistingMoltbotProcess(sandbox);
    expect(result).toBe(gatewayProcess);
  });

  it('returns gateway process when starting', async () => {
    const gatewayProcess = createFullMockProcess({ 
      id: 'gateway-1',
      command: '/usr/local/bin/start-moltbot.sh', 
      status: 'starting' 
    });
    const { sandbox, listProcessesMock } = createMockSandbox();
    listProcessesMock.mockResolvedValue([gatewayProcess]);
    
    const result = await findExistingMoltbotProcess(sandbox);
    expect(result).toBe(gatewayProcess);
  });

  it('ignores completed gateway processes', async () => {
    const processes = [
      createFullMockProcess({ command: 'clawdbot gateway', status: 'completed' }),
      createFullMockProcess({ command: 'start-moltbot.sh', status: 'failed' }),
    ];
    const { sandbox, listProcessesMock } = createMockSandbox();
    listProcessesMock.mockResolvedValue(processes);
    
    const result = await findExistingMoltbotProcess(sandbox);
    expect(result).toBeNull();
  });

  it('handles listProcesses errors gracefully', async () => {
    const sandbox = {
      listProcesses: vi.fn().mockRejectedValue(new Error('Network error')),
    } as unknown as Sandbox;
    
    const result = await findExistingMoltbotProcess(sandbox);
    expect(result).toBeNull();
  });

  it('matches start-moltbot.sh command', async () => {
    const gatewayProcess = createFullMockProcess({ 
      id: 'gateway-1',
      command: '/usr/local/bin/start-moltbot.sh', 
      status: 'running' 
    });
    const { sandbox, listProcessesMock } = createMockSandbox();
    listProcessesMock.mockResolvedValue([gatewayProcess]);
    
    const result = await findExistingMoltbotProcess(sandbox);
    expect(result).toBe(gatewayProcess);
  });

  it('returns first matching gateway process', async () => {
    const firstGateway = createFullMockProcess({ 
      id: 'gateway-1',
      command: 'clawdbot gateway', 
      status: 'running' 
    });
    const secondGateway = createFullMockProcess({ 
      id: 'gateway-2',
      command: 'start-moltbot.sh', 
      status: 'starting' 
    });
    const { sandbox, listProcessesMock } = createMockSandbox();
    listProcessesMock.mockResolvedValue([firstGateway, secondGateway]);
    
    const result = await findExistingMoltbotProcess(sandbox);
    expect(result?.id).toBe('gateway-1');
  });
});

describe('ensureMoltbotGateway', () => {
  it('destroys the sandbox and retries once on startup script syntax errors', async () => {
    suppressConsole();

    const failingProcess = createFullMockProcess({
      id: 'proc-fail',
      status: 'starting',
      waitForPort: vi.fn().mockRejectedValue(new Error('port not ready')),
      getLogs: vi.fn().mockResolvedValue({
        stdout: '',
        stderr: '[stdin]:95\nconst isCustomProvider = /\\\\\\\\/custom-[^/]+$/.test(baseUrl);\nSyntaxError: Invalid regular expression flags\n',
      }),
    });

    const goodProcess = createFullMockProcess({
      id: 'proc-ok',
      status: 'running',
      waitForPort: vi.fn().mockResolvedValue(undefined),
      getLogs: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
    });

    const sandbox = {
      listProcesses: vi.fn().mockResolvedValue([]),
      startProcess: vi.fn().mockResolvedValueOnce(failingProcess).mockResolvedValueOnce(goodProcess),
      destroy: vi.fn().mockResolvedValue(undefined),
    } as unknown as Sandbox;

    const env = createMockEnv();
    const proc = await ensureMoltbotGateway(sandbox, env);

    expect(proc.id).toBe('proc-ok');
    expect(sandbox.destroy).toHaveBeenCalledTimes(1);
    expect(sandbox.startProcess).toHaveBeenCalledTimes(2);
  });

  it('does not destroy the sandbox on non-syntax startup failures', async () => {
    suppressConsole();

    const failingProcess = createFullMockProcess({
      id: 'proc-fail',
      status: 'starting',
      waitForPort: vi.fn().mockRejectedValue(new Error('port not ready')),
      getLogs: vi.fn().mockResolvedValue({
        stdout: '',
        stderr: 'Missing ANTHROPIC_API_KEY or AI_GATEWAY_API_KEY',
      }),
    });

    const sandbox = {
      listProcesses: vi.fn().mockResolvedValue([]),
      startProcess: vi.fn().mockResolvedValue(failingProcess),
      destroy: vi.fn().mockResolvedValue(undefined),
    } as unknown as Sandbox;

    const env = createMockEnv();

    await expect(ensureMoltbotGateway(sandbox, env)).rejects.toThrow('Moltbot gateway failed to start');
    expect(sandbox.destroy).toHaveBeenCalledTimes(0);
    expect(sandbox.startProcess).toHaveBeenCalledTimes(1);
  });
});
