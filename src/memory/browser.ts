export type MemoryFileKind = 'root' | 'memory'

export type MemoryFileEntry = {
  /** "MEMORY.md" or "memory/<path>.md" */
  path: string
  kind: MemoryFileKind
  bytes: number
  mtimeMs: number
}

export type MemoryFilesResponse = {
  workspaceDir: string
  memoryDir: string
  files: MemoryFileEntry[]
}

export type MemoryFileResponse = {
  workspaceDir: string
  path: string
  kind: MemoryFileKind
  bytes: number
  mtimeMs: number
  content: string
  truncated: boolean
}

export const MEMORY_READ_LIMIT_BYTES = 400_000
export const MEMORY_WRITE_LIMIT_BYTES = 800_000
export const MEMORY_EXPORT_LIMIT_BYTES = 2_500_000

/**
 * Only allow paths that are part of OpenClaw/Clawdbot’s memory system:
 * - "MEMORY.md"
 * - workspace-relative markdown files under "memory/" (any depth)
 */
export function normalizeMemoryPath(raw: string | null | undefined): string | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (!trimmed) return null

  // Normalize Windows separators from user input/clipboard.
  const normalized = trimmed.replace(/\\/g, '/')

  // Avoid log/command injection edge cases.
  if (normalized.includes('\0') || normalized.includes('\n') || normalized.includes('\r')) return null
  if (normalized.length > 500) return null

  if (normalized === 'MEMORY.md') return normalized
  if (!normalized.startsWith('memory/')) return null
  if (!normalized.endsWith('.md')) return null
  if (normalized.endsWith('/')) return null

  const rest = normalized.slice('memory/'.length)
  if (!rest) return null

  const segments = rest.split('/')
  for (const segment of segments) {
    if (!segment) return null
    if (segment === '.' || segment === '..') return null
  }

  return normalized
}
