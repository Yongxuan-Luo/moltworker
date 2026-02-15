import { describe, it, expect } from 'vitest';
import { normalizeMemoryPath } from './browser';

describe('normalizeMemoryPath', () => {
  it('accepts MEMORY.md', () => {
    expect(normalizeMemoryPath('MEMORY.md')).toBe('MEMORY.md');
    expect(normalizeMemoryPath('  MEMORY.md  ')).toBe('MEMORY.md');
  });

  it('accepts memory/*.md paths and normalizes backslashes', () => {
    expect(normalizeMemoryPath('memory/foo.md')).toBe('memory/foo.md');
    expect(normalizeMemoryPath('memory/a/b.md')).toBe('memory/a/b.md');
    expect(normalizeMemoryPath('memory\\a\\b.md')).toBe('memory/a/b.md');
  });

  it('rejects non-memory paths', () => {
    expect(normalizeMemoryPath('README.md')).toBeNull();
    expect(normalizeMemoryPath('/root/clawd/memory/foo.md')).toBeNull();
    expect(normalizeMemoryPath('memory')).toBeNull();
  });

  it('rejects traversal and invalid segments', () => {
    expect(normalizeMemoryPath('memory/../secrets.md')).toBeNull();
    expect(normalizeMemoryPath('memory/./note.md')).toBeNull();
    expect(normalizeMemoryPath('memory//note.md')).toBeNull();
  });

  it('requires .md extension', () => {
    expect(normalizeMemoryPath('memory/note.txt')).toBeNull();
    expect(normalizeMemoryPath('memory/note')).toBeNull();
  });

  it('rejects control characters', () => {
    expect(normalizeMemoryPath('memory/note.md\nrm -rf /')).toBeNull();
    expect(normalizeMemoryPath('memory/note.md\0')).toBeNull();
  });
});

