import { MEMORY_EXPORT_LIMIT_BYTES, MEMORY_WRITE_LIMIT_BYTES, normalizeMemoryPath } from './browser';

export type MemoryImportMode = 'overwrite' | 'merge';

export type MemoryImportFile = {
  path: string;
  content: string;
};

export type MemoryImportDataV1 = {
  schemaVersion: 1;
  exportedAt?: string;
  files: MemoryImportFile[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function coerceFilesArray(raw: unknown): MemoryImportFile[] | null {
  if (!Array.isArray(raw)) return null;
  const out: MemoryImportFile[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) return null;
    const path = entry.path;
    const content = entry.content;
    if (typeof path !== 'string' || typeof content !== 'string') return null;
    out.push({ path, content });
  }
  return out;
}

/**
 * Accepts:
 * - Recommended v1 format: { schemaVersion: 1, exportedAt?, files: [{path, content}] }
 * - Legacy export format (as produced by older endpoints): { files: [{path, content, ...}] } (+ any top-level fields)
 */
export function coerceMemoryImportData(raw: unknown): { ok: true; data: MemoryImportDataV1 } | { ok: false; error: string } {
  if (!isRecord(raw)) return { ok: false, error: 'Import JSON must be an object' };

  const schemaVersion = raw.schemaVersion;
  const exportedAt = typeof raw.exportedAt === 'string' ? raw.exportedAt : undefined;
  const files = coerceFilesArray(raw.files);

  if (schemaVersion === 1) {
    if (!files) return { ok: false, error: 'Invalid v1 import JSON: expected files: [{path, content}]' };
    return { ok: true, data: { schemaVersion: 1, exportedAt, files } };
  }

  if (schemaVersion === undefined) {
    // Legacy-ish: no schemaVersion, but has files.
    if (!files) return { ok: false, error: 'Invalid import JSON: expected files: [{path, content}]' };
    return { ok: true, data: { schemaVersion: 1, exportedAt, files } };
  }

  return { ok: false, error: `Unsupported schemaVersion: ${String(schemaVersion)}` };
}

export type ValidatedMemoryImport = {
  schemaVersion: 1;
  exportedAt?: string;
  files: Array<{ path: string; content: string }>;
  totalBytes: number;
};

export function validateMemoryImportData(
  data: MemoryImportDataV1,
): { ok: true; value: ValidatedMemoryImport } | { ok: false; error: string; details?: unknown } {
  if (!Array.isArray(data.files)) return { ok: false, error: 'Invalid import: files must be an array' };

  let totalBytes = 0;
  const out: Array<{ path: string; content: string }> = [];

  for (const file of data.files) {
    const normalizedPath = normalizeMemoryPath(file.path);
    if (!normalizedPath) return { ok: false, error: `Invalid memory path: ${file.path}` };

    const bytes = Buffer.byteLength(file.content, 'utf8');
    if (bytes > MEMORY_WRITE_LIMIT_BYTES) {
      return {
        ok: false,
        error: 'File content too large',
        details: { path: normalizedPath, bytes, limitBytes: MEMORY_WRITE_LIMIT_BYTES },
      };
    }
    totalBytes += bytes;
    if (totalBytes > MEMORY_EXPORT_LIMIT_BYTES) {
      return {
        ok: false,
        error: 'Import too large',
        details: { totalBytes, limitBytes: MEMORY_EXPORT_LIMIT_BYTES },
      };
    }

    out.push({ path: normalizedPath, content: file.content });
  }

  // De-dup by path (last write wins) to make merges predictable.
  const dedup = new Map<string, string>();
  for (const f of out) dedup.set(f.path, f.content);

  const files = [...dedup.entries()]
    .map(([path, content]) => ({ path, content }))
    .sort((a, b) => a.path.localeCompare(b.path));

  return {
    ok: true,
    value: {
      schemaVersion: 1,
      exportedAt: data.exportedAt,
      files,
      totalBytes,
    },
  };
}

