import { describe, it, expect } from 'vitest';
import { coerceMemoryImportData, validateMemoryImportData } from './import';

describe('memory import', () => {
  it('accepts schemaVersion=1 format', () => {
    const coerced = coerceMemoryImportData({
      schemaVersion: 1,
      exportedAt: '2026-02-15T00:00:00.000Z',
      files: [{ path: 'memory/a.md', content: '# A' }],
    });
    expect(coerced.ok).toBe(true);
    if (!coerced.ok) return;
    const validated = validateMemoryImportData(coerced.data);
    expect(validated.ok).toBe(true);
  });

  it('accepts legacy-ish format without schemaVersion', () => {
    const coerced = coerceMemoryImportData({
      workspaceDir: '/root/clawd',
      files: [{ path: 'MEMORY.md', content: 'root' }],
    });
    expect(coerced.ok).toBe(true);
  });

  it('rejects invalid paths', () => {
    const coerced = coerceMemoryImportData({
      files: [{ path: '/etc/passwd', content: 'nope' }],
    });
    expect(coerced.ok).toBe(true);
    if (!coerced.ok) return;
    const validated = validateMemoryImportData(coerced.data);
    expect(validated.ok).toBe(false);
  });

  it('dedups by path (last wins)', () => {
    const coerced = coerceMemoryImportData({
      schemaVersion: 1,
      files: [
        { path: 'memory/a.md', content: 'one' },
        { path: 'memory/a.md', content: 'two' },
      ],
    });
    expect(coerced.ok).toBe(true);
    if (!coerced.ok) return;
    const validated = validateMemoryImportData(coerced.data);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(validated.value.files).toEqual([{ path: 'memory/a.md', content: 'two' }]);
  });
});

