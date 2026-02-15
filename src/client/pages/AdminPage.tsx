import { useState, useEffect, useCallback } from 'react'
import {
  listDevices,
  approveDevice,
  approveAllDevices,
  listPairingRequests,
  approvePairingCode,
  listMemoryFiles,
  getMemoryFile,
  saveMemoryFile,
  deleteMemoryFile,
  importMemoryJson,
  listSkills,
  getSkill,
  setSkillEnabled,
  restartGateway,
  destroySandbox,
  getStorageStatus,
  triggerSync,
  AuthError,
  type PendingDevice,
  type PairedDevice,
  type DeviceListResponse,
  type StorageStatusResponse,
  type PairingRequest,
  type SkillsListResponse,
  type SkillSummary,
  type SkillDetailResponse,
  type MemoryFilesResponse,
  type MemoryFileEntry,
  type MemoryFileResponse,
} from '../api'
import './AdminPage.css'

// Small inline spinner for buttons
function ButtonSpinner() {
  return <span className="btn-spinner" />
}

type SkillStatusLike = {
  eligible: boolean
  disabled: boolean
  blockedByAllowlist: boolean
}

function formatSkillStatus(skill: SkillStatusLike): { label: string; className: string } {
  if (skill.eligible) return { label: 'Ready', className: 'ready' }
  if (skill.disabled) return { label: 'Disabled', className: 'disabled' }
  if (skill.blockedByAllowlist) return { label: 'Blocked', className: 'blocked' }
  return { label: 'Missing', className: 'missing' }
}

function countMissing(missing: SkillSummary['missing']): number {
  return (
    (missing?.bins?.length ?? 0) +
    (missing?.anyBins?.length ?? 0) +
    (missing?.env?.length ?? 0) +
    (missing?.config?.length ?? 0) +
    (missing?.os?.length ?? 0)
  )
}

export default function AdminPage() {
  const [pending, setPending] = useState<PendingDevice[]>([])
  const [paired, setPaired] = useState<PairedDevice[]>([])
  const [storageStatus, setStorageStatus] = useState<StorageStatusResponse | null>(null)
  const [skillsReport, setSkillsReport] = useState<SkillsListResponse | null>(null)
  const [memoryReport, setMemoryReport] = useState<MemoryFilesResponse | null>(null)
  const [memoryLoading, setMemoryLoading] = useState(false)
  const [memoryFileLoading, setMemoryFileLoading] = useState(false)
  const [memorySaveLoading, setMemorySaveLoading] = useState(false)
  const [memoryDeleteLoading, setMemoryDeleteLoading] = useState(false)
  const [memoryImportLoading, setMemoryImportLoading] = useState(false)
  const [memoryError, setMemoryError] = useState<string | null>(null)
  const [memoryFilter, setMemoryFilter] = useState('')
  const [memoryImportMode, setMemoryImportMode] = useState<'overwrite' | 'merge'>('overwrite')
  const [selectedMemoryPath, setSelectedMemoryPath] = useState<string | null>(null)
  const [selectedMemoryFile, setSelectedMemoryFile] = useState<MemoryFileResponse | null>(null)
  const [memoryDraft, setMemoryDraft] = useState('')
  const [memoryDirty, setMemoryDirty] = useState(false)
  const [skillsLoading, setSkillsLoading] = useState(false)
  const [skillDetailLoading, setSkillDetailLoading] = useState(false)
  const [skillToggleLoading, setSkillToggleLoading] = useState(false)
  const [selectedSkillName, setSelectedSkillName] = useState<string | null>(null)
  const [selectedSkill, setSelectedSkill] = useState<SkillDetailResponse | null>(null)
  const [pairingChannel, setPairingChannel] = useState('telegram')
  const [pairingRequests, setPairingRequests] = useState<PairingRequest[]>([])
  const [pairingCode, setPairingCode] = useState('')
  const [pairingNotify, setPairingNotify] = useState(true)
  const [pairingLoading, setPairingLoading] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [actionInProgress, setActionInProgress] = useState<string | null>(null)
  const [restartInProgress, setRestartInProgress] = useState(false)
  const [destroyInProgress, setDestroyInProgress] = useState(false)
  const [syncInProgress, setSyncInProgress] = useState(false)

  const fetchDevices = useCallback(async () => {
    try {
      setError(null)
      const data: DeviceListResponse = await listDevices()
      setPending(data.pending || [])
      setPaired(data.paired || [])
      
      if (data.error) {
        setError(data.error)
      } else if (data.parseError) {
        setError(`Parse error: ${data.parseError}`)
      }
    } catch (err) {
      if (err instanceof AuthError) {
        setError('Authentication required. Please log in via Cloudflare Access.')
      } else {
        setError(err instanceof Error ? err.message : 'Failed to fetch devices')
      }
    } finally {
      setLoading(false)
    }
  }, [])

  const fetchStorageStatus = useCallback(async () => {
    try {
      const status = await getStorageStatus()
      setStorageStatus(status)
    } catch (err) {
      // Don't show error for storage status - it's not critical
      console.error('Failed to fetch storage status:', err)
    }
  }, []) 

  const fetchMemoryFiles = useCallback(async () => {
    setMemoryLoading(true)
    setMemoryError(null)
    try {
      const data = await listMemoryFiles()
      setMemoryReport(data)
    } catch (err) {
      if (err instanceof AuthError) {
        setError('Authentication required. Please log in via Cloudflare Access.')
      } else {
        setMemoryError(err instanceof Error ? err.message : 'Failed to fetch memory files')
      }
    } finally {
      setMemoryLoading(false)
    }
  }, [])

  const fetchMemoryFile = useCallback(
    async (path: string) => {
      setSelectedMemoryPath(path)
      setSelectedMemoryFile(null)
      setMemoryDraft('')
      setMemoryDirty(false)
      setMemoryFileLoading(true)
      setMemoryError(null)
      try {
        const data = await getMemoryFile(path)
        setSelectedMemoryFile(data)
        setMemoryDraft(data.content ?? '')
      } catch (err) {
        if (err instanceof AuthError) {
          setError('Authentication required. Please log in via Cloudflare Access.')
        } else {
          setMemoryError(err instanceof Error ? err.message : 'Failed to read memory file')
        }
      } finally {
        setMemoryFileLoading(false)
      }
    },
    [setError]
  )

  const handleNewMemoryFile = async () => {
    if (memoryDirty && !confirm('You have unsaved changes. Continue and discard them?')) return
    const name = prompt('New memory file name (will be created under memory/):', 'note.md')
    if (!name) return
    const trimmed = name.trim()
    if (!trimmed) return

    const rel = trimmed.startsWith('memory/') ? trimmed : `memory/${trimmed}`
    if (!rel.endsWith('.md')) {
      setMemoryError('File name must end with .md')
      return
    }

    setMemorySaveLoading(true)
    setMemoryError(null)
    try {
      const res = await saveMemoryFile(rel, '')
      if (res.error) {
        setMemoryError(res.error)
        return
      }
      await fetchMemoryFiles()
      await fetchMemoryFile(rel)
    } catch (err) {
      setMemoryError(err instanceof Error ? err.message : 'Failed to create file')
    } finally {
      setMemorySaveLoading(false)
    }
  }

  const handleSaveMemory = async () => {
    if (!selectedMemoryPath) return
    setMemorySaveLoading(true)
    setMemoryError(null)
    try {
      const res = await saveMemoryFile(selectedMemoryPath, memoryDraft)
      if (res.error) {
        setMemoryError(res.error)
        return
      }
      setMemoryDirty(false)
      await fetchMemoryFiles()
      await fetchMemoryFile(selectedMemoryPath)
    } catch (err) {
      setMemoryError(err instanceof Error ? err.message : 'Failed to save file')
    } finally {
      setMemorySaveLoading(false)
    }
  }

  const handleDeleteMemory = async () => {
    if (!selectedMemoryPath) return
    if (!selectedMemoryPath.startsWith('memory/')) {
      setMemoryError('Only files under memory/ can be deleted via this UI.')
      return
    }
    if (!confirm(`Delete ${selectedMemoryPath}? This cannot be undone.`)) return

    setMemoryDeleteLoading(true)
    setMemoryError(null)
    try {
      const res = await deleteMemoryFile(selectedMemoryPath)
      if (res.error) {
        setMemoryError(res.error)
        return
      }
      setSelectedMemoryPath(null)
      setSelectedMemoryFile(null)
      setMemoryDraft('')
      setMemoryDirty(false)
      await fetchMemoryFiles()
    } catch (err) {
      setMemoryError(err instanceof Error ? err.message : 'Failed to delete file')
    } finally {
      setMemoryDeleteLoading(false)
    }
  }

  const handleImportMemory = async (file: File) => {
    if (memoryDirty && !confirm('You have unsaved changes. Continue and discard them?')) return

    setMemoryImportLoading(true)
    setMemoryError(null)
    try {
      const text = await file.text()
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        setMemoryError('Invalid JSON file')
        return
      }

      const res = await importMemoryJson(parsed, memoryImportMode)
      if (!res.ok) {
        setMemoryError(res.error || 'Import failed')
        return
      }

      alert(`Import complete (${res.mode}). Wrote ${res.wrote?.length ?? 0} file(s). Deleted ${res.deleted?.length ?? 0} file(s).`)
      await fetchMemoryFiles()
      setSelectedMemoryPath(null)
      setSelectedMemoryFile(null)
      setMemoryDraft('')
      setMemoryDirty(false)
    } catch (err) {
      setMemoryError(err instanceof Error ? err.message : 'Failed to import')
    } finally {
      setMemoryImportLoading(false)
    }
  }

  const fetchSkills = useCallback(async () => {
    setSkillsLoading(true)
    try {
      const data = await listSkills()
      setSkillsReport(data)
    } catch (err) {
      if (err instanceof AuthError) {
        setError('Authentication required. Please log in via Cloudflare Access.')
      } else {
        console.error('Failed to fetch skills:', err)
      }
    } finally {
      setSkillsLoading(false)
    }
  }, [])

  const fetchSkillDetail = useCallback(async (name: string) => {
    setSelectedSkillName(name)
    setSkillDetailLoading(true)
    try {
      const detail = await getSkill(name)
      setSelectedSkill(detail)
    } catch (err) {
      if (err instanceof AuthError) {
        setError('Authentication required. Please log in via Cloudflare Access.')
      } else {
        setError(err instanceof Error ? err.message : 'Failed to fetch skill')
      }
      setSelectedSkill(null)
    } finally {
      setSkillDetailLoading(false)
    }
  }, [])

  const handleSetSkillEnabled = useCallback(
    async (enabled: boolean) => {
      const skillKey = selectedSkill?.skill?.skillKey || selectedSkill?.skill?.name
      const refreshName = selectedSkill?.skill?.name
      if (!skillKey || !refreshName) return

      setSkillToggleLoading(true)
      try {
        const result = await setSkillEnabled(skillKey, enabled)
        if (!result.success) {
          setError(result.error || 'Failed to update skill')
          return
        }
        setError(null)
        await fetchSkills()
        await fetchSkillDetail(refreshName)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to update skill')
      } finally {
        setSkillToggleLoading(false)
      }
    },
    [selectedSkill, fetchSkills, fetchSkillDetail]
  )

  const fetchPairing = useCallback(async () => {
    setPairingLoading(true)
    try {
      const data = await listPairingRequests(pairingChannel)
      setPairingRequests(data.requests || [])
    } catch (err) {
      console.error('Failed to fetch pairing requests:', err)
    } finally {
      setPairingLoading(false)
    }
  }, [pairingChannel])

  useEffect(() => {
    fetchDevices()
    fetchStorageStatus()
    fetchMemoryFiles()
    fetchSkills()
    fetchPairing()
  }, [fetchDevices, fetchStorageStatus, fetchMemoryFiles, fetchSkills, fetchPairing])

  const handleApprove = async (requestId: string) => {
    setActionInProgress(requestId)
    try {
      const result = await approveDevice(requestId)
      if (result.success) {
        // Refresh the list
        await fetchDevices()
      } else {
        setError(result.error || 'Approval failed')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to approve device')
    } finally {
      setActionInProgress(null)
    }
  }

  const handleApproveAll = async () => {
    if (pending.length === 0) return
    
    setActionInProgress('all')
    try {
      const result = await approveAllDevices()
      if (result.failed && result.failed.length > 0) {
        setError(`Failed to approve ${result.failed.length} device(s)`)
      }
      // Refresh the list
      await fetchDevices()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to approve devices')
    } finally {
      setActionInProgress(null)
    }
  }

  const handleRestartGateway = async () => {
    if (!confirm('Are you sure you want to restart the gateway? This will disconnect all clients temporarily.')) {
      return
    }
    
    setRestartInProgress(true)
    try {
      const result = await restartGateway()
      if (result.success) {
        setError(null)
        // Show success message briefly
        alert('Gateway restart initiated. Clients will reconnect automatically.')
      } else {
        setError(result.error || 'Failed to restart gateway')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to restart gateway')
    } finally {
      setRestartInProgress(false)
    }
  }

  const handleDestroySandbox = async () => {
    if (
      !confirm(
        'This will destroy the sandbox container (kills all processes and deletes all files).\n\nIf R2 is NOT configured, your moltbot config and paired devices will be lost.\n\nContinue?'
      )
    ) {
      return
    }

    setDestroyInProgress(true)
    try {
      const result = await destroySandbox()
      if (result.success) {
        setError(null)
        alert('Sandbox destroyed. Reloading to recreate the container...')
        window.location.reload()
      } else {
        setError(result.error || 'Failed to destroy sandbox')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to destroy sandbox')
    } finally {
      setDestroyInProgress(false)
    }
  }

  const handleSync = async () => {
    setSyncInProgress(true)
    try {
      const result = await triggerSync()
      if (result.success) {
        // Update the storage status with new lastSync time
        setStorageStatus(prev => prev ? { ...prev, lastSync: result.lastSync || null } : null)
        setError(null)
      } else {
        setError(result.error || 'Sync failed')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to sync')
    } finally {
      setSyncInProgress(false)
    }
  }

  const handleApprovePairing = async (code: string) => {
    if (!code.trim()) return
    setActionInProgress(`pairing:${code}`)
    try {
      const result = await approvePairingCode(pairingChannel, code.trim(), { notify: pairingNotify })
      if (!result.success) {
        setError(result.error || result.stderr || 'Failed to approve pairing code')
        return
      }
      setPairingCode('')
      await fetchPairing()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to approve pairing code')
    } finally {
      setActionInProgress(null)
    }
  }

  const formatSyncTime = (isoString: string | null) => {
    if (!isoString) return 'Never'
    try {
      const date = new Date(isoString)
      return date.toLocaleString()
    } catch {
      return isoString
    }
  }

  const formatTimestamp = (ts: number) => {
    const date = new Date(ts)
    return date.toLocaleString()
  }

  const formatTimeAgo = (ts: number) => {
    const seconds = Math.floor((Date.now() - ts) / 1000)
    if (seconds < 60) return `${seconds}s ago`
    const minutes = Math.floor(seconds / 60)
    if (minutes < 60) return `${minutes}m ago`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `${hours}h ago`
    const days = Math.floor(hours / 24)
    return `${days}d ago`
  }

  const formatBytes = (bytes: number) => {
    if (!Number.isFinite(bytes) || bytes < 0) return '—'
    if (bytes < 1024) return `${bytes} B`
    const kb = bytes / 1024
    if (kb < 1024) return `${kb.toFixed(1)} KB`
    const mb = kb / 1024
    if (mb < 1024) return `${mb.toFixed(1)} MB`
    const gb = mb / 1024
    return `${gb.toFixed(1)} GB`
  }

  const skills: SkillSummary[] = skillsReport?.skills ?? []
  const skillsReady = skills.filter((s) => s.eligible).length
  const sortedSkills = [...skills].sort((a, b) => {
    const weight = (s: SkillSummary) => {
      if (s.eligible) return 0
      if (!s.eligible && !s.disabled && !s.blockedByAllowlist) return 1
      if (s.disabled) return 2
      if (s.blockedByAllowlist) return 3
      return 4
    }
    const diff = weight(a) - weight(b)
    if (diff !== 0) return diff
    return a.name.localeCompare(b.name)
  })

  const memoryFiles: MemoryFileEntry[] = memoryReport?.files ?? []
  const filteredMemoryFiles = memoryFiles.filter((f) =>
    memoryFilter.trim() ? f.path.toLowerCase().includes(memoryFilter.trim().toLowerCase()) : true
  )

  return (
    <div className="devices-page">
      {error && (
        <div className="error-banner">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="dismiss-btn">
            Dismiss
          </button>
        </div>
      )}

      {storageStatus && !storageStatus.configured && (
        <div className="warning-banner">
          <div className="warning-content">
            <strong>R2 Storage Not Configured</strong>
            <p>
              Paired devices and conversations will be lost when the container restarts.
              To enable persistent storage, configure R2 credentials.
              See the <a href="https://github.com/cloudflare/moltworker" target="_blank" rel="noopener noreferrer">README</a> for setup instructions.
            </p>
            {storageStatus.missing && (
              <p className="missing-secrets">
                Missing: {storageStatus.missing.join(', ')}
              </p>
            )}
          </div>
        </div>
      )}

      {storageStatus?.configured && (
        <div className="success-banner">
          <div className="storage-status">
            <div className="storage-info">
              <span>R2 storage is configured. Your data will persist across container restarts.</span>
              <span className="last-sync">
                Last backup: {formatSyncTime(storageStatus.lastSync)}
              </span>
            </div>
            <button
              className="btn btn-secondary btn-sm"
              onClick={handleSync}
              disabled={syncInProgress}
            >
              {syncInProgress && <ButtonSpinner />}
              {syncInProgress ? 'Syncing...' : 'Backup Now'}
            </button>
          </div>
        </div>
      )}

      <section className="devices-section gateway-section">
        <div className="section-header">
          <h2>Gateway Controls</h2>
          <div className="header-actions">
            <button
              className="btn btn-secondary"
              onClick={handleRestartGateway}
              disabled={restartInProgress || destroyInProgress}
            >
              {restartInProgress && <ButtonSpinner />}
              {restartInProgress ? 'Restarting...' : 'Restart Gateway'}
            </button>
            <button
              className="btn btn-danger"
              onClick={handleDestroySandbox}
              disabled={destroyInProgress || restartInProgress}
            >
              {destroyInProgress && <ButtonSpinner />}
              {destroyInProgress ? 'Resetting...' : 'Reset Sandbox'}
            </button>
          </div>
        </div>
        <p className="hint">
          Restart the gateway to apply configuration changes or recover from errors. If the container image/startup script is stuck
          after a deploy, use "Reset Sandbox" to recreate the container.
        </p>
      </section>

      <section className="devices-section skills-section">
        <div className="section-header">
          <div className="skills-header-title">
            <h2>Skills</h2>
            <span className="skills-count">
              {skillsLoading && skills.length === 0 ? 'Loading…' : `${skillsReady}/${skills.length} ready`}
            </span>
          </div>
          <div className="header-actions">
            <a className="btn btn-secondary" href="/" target="_blank" rel="noopener noreferrer">
              Open Control UI
            </a>
            <button className="btn btn-secondary" onClick={fetchSkills} disabled={skillsLoading}>
              {skillsLoading ? 'Refreshing...' : 'Refresh'}
            </button>
          </div>
        </div>
        <p className="hint">
          Skills are loaded by <code>clawdbot</code> from workspace, managed, and bundled sources (workspace wins on conflicts). Use the
          Control UI “Skills” page for full management; this panel focuses on diagnostics + quick enable/disable.
        </p>

        {skillsLoading && skills.length === 0 ? (
          <div className="loading">
            <div className="spinner"></div>
            <p>Loading skills...</p>
          </div>
        ) : skills.length === 0 ? (
          <div className="empty-state">
            <p>No skills found</p>
            <p className="hint">If you just deployed new skills, try "Reset Sandbox" once.</p>
          </div>
        ) : (
          <div className="skills-layout">
            <div className="skills-list">
              {sortedSkills.map((skill) => {
                const isActive = selectedSkillName === skill.name
                const isLoading = skillDetailLoading && isActive
                const status = formatSkillStatus(skill)
                const missingCount = countMissing(skill.missing)
                return (
                  <button
                    key={skill.name}
                    className={`skill-item ${isActive ? 'active' : ''}`}
                    onClick={() => fetchSkillDetail(skill.name)}
                    disabled={isLoading}
                    title={skill.name}
                  >
                    {isLoading && <ButtonSpinner />}
                    <div className="skill-item-text">
                      <div className="skill-item-row">
                        <span className="skill-name">
                          {(skill.emoji ? `${skill.emoji} ` : '') + skill.name}
                        </span>
                        <span className={`skill-status-badge ${status.className}`}>{status.label}</span>
                      </div>
                      <div className="skill-description">{skill.description}</div>
                      <div className="skill-meta">
                        {skill.source && <span className="skill-meta-item">{skill.source}</span>}
                        {missingCount > 0 && <span className="skill-meta-item missing">{missingCount} missing</span>}
                      </div>
                    </div>
                  </button>
                )
              })}
            </div>

            <div className="skills-detail">
              {!selectedSkill ? (
                <div className="empty-state">
                  <p>Select a skill to view details</p>
                </div>
              ) : (
                <>
                  <div className="skills-detail-header">
                    <div className="skills-detail-title">
                      <h3>
                        {(selectedSkill.skill.emoji ? `${selectedSkill.skill.emoji} ` : '') + selectedSkill.skill.name}
                      </h3>
                      <div className="skills-detail-badges">
                        <span className={`skill-status-badge ${formatSkillStatus(selectedSkill.skill).className}`}>
                          {formatSkillStatus(selectedSkill.skill).label}
                        </span>
                        {selectedSkill.truncated && <span className="skill-badge">SKILL.md truncated</span>}
                      </div>
                    </div>
                    <div className="skills-detail-actions">
                      <button
                        className={`btn btn-sm ${selectedSkill.skill.disabled ? 'btn-success' : 'btn-danger'}`}
                        onClick={() => handleSetSkillEnabled(selectedSkill.skill.disabled)}
                        disabled={skillToggleLoading || selectedSkill.skill.blockedByAllowlist}
                        title={
                          selectedSkill.skill.blockedByAllowlist
                            ? 'Blocked by allowlist (update skills.allowBundled in config)'
                            : undefined
                        }
                      >
                        {skillToggleLoading && <ButtonSpinner />}
                        {selectedSkill.skill.disabled ? 'Enable' : 'Disable'}
                      </button>
                    </div>
                  </div>

                  <div className="skills-detail-body">
                    <div className="skills-meta-block">
                      <div className="subheading">Details</div>
                      <div className="skill-details">
                        <div className="detail-row">
                          <span className="label">Source:</span>
                          <span className="value">{selectedSkill.skill.source || '—'}</span>
                        </div>
                        <div className="detail-row">
                          <span className="label">Skill key:</span>
                          <span className="value">{selectedSkill.skill.skillKey || selectedSkill.skill.name}</span>
                        </div>
                        {selectedSkill.skill.primaryEnv && (
                          <div className="detail-row">
                            <span className="label">Primary env:</span>
                            <span className="value">
                              <code>{selectedSkill.skill.primaryEnv}</code>
                            </span>
                          </div>
                        )}
                        {selectedSkill.skill.homepage && (
                          <div className="detail-row">
                            <span className="label">Homepage:</span>
                            <span className="value">
                              <a href={selectedSkill.skill.homepage} target="_blank" rel="noopener noreferrer">
                                {selectedSkill.skill.homepage}
                              </a>
                            </span>
                          </div>
                        )}
                        {selectedSkill.skill.baseDir && (
                          <div className="detail-row">
                            <span className="label">Base dir:</span>
                            <span className="value">
                              <code>{selectedSkill.skill.baseDir}</code>
                            </span>
                          </div>
                        )}
                        {selectedSkill.skill.filePath && (
                          <div className="detail-row">
                            <span className="label">SKILL.md:</span>
                            <span className="value">
                              <code>{selectedSkill.skill.filePath}</code>
                            </span>
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="skills-meta-block">
                      <div className="subheading">Requirements</div>
                      {selectedSkill.skill.eligible ? (
                        <p className="hint">All requirements satisfied.</p>
                      ) : selectedSkill.skill.disabled ? (
                        <p className="hint">This skill is disabled in config.</p>
                      ) : selectedSkill.skill.blockedByAllowlist ? (
                        <p className="hint">
                          This bundled skill is blocked by allowlist. Update <code>skills.allowBundled</code> in config to allow it.
                        </p>
                      ) : (
                        <div className="skill-missing-list">
                          {selectedSkill.skill.missing.bins.length > 0 && (
                            <div className="skill-missing-row">
                              <span className="skill-missing-label">bins</span>
                              <span className="skill-missing-value">
                                {selectedSkill.skill.missing.bins.map((b) => (
                                  <code key={b}>{b}</code>
                                ))}
                              </span>
                            </div>
                          )}
                          {selectedSkill.skill.missing.anyBins.length > 0 && (
                            <div className="skill-missing-row">
                              <span className="skill-missing-label">anyBins</span>
                              <span className="skill-missing-value">
                                {selectedSkill.skill.missing.anyBins.map((b) => (
                                  <code key={b}>{b}</code>
                                ))}
                              </span>
                            </div>
                          )}
                          {selectedSkill.skill.missing.env.length > 0 && (
                            <div className="skill-missing-row">
                              <span className="skill-missing-label">env</span>
                              <span className="skill-missing-value">
                                {selectedSkill.skill.missing.env.map((e) => (
                                  <code key={e}>{e}</code>
                                ))}
                              </span>
                            </div>
                          )}
                          {selectedSkill.skill.missing.config.length > 0 && (
                            <div className="skill-missing-row">
                              <span className="skill-missing-label">config</span>
                              <span className="skill-missing-value">
                                {selectedSkill.skill.missing.config.map((p) => (
                                  <code key={p}>{p}</code>
                                ))}
                              </span>
                            </div>
                          )}
                          {selectedSkill.skill.missing.os.length > 0 && (
                            <div className="skill-missing-row">
                              <span className="skill-missing-label">os</span>
                              <span className="skill-missing-value">
                                {selectedSkill.skill.missing.os.map((os) => (
                                  <code key={os}>{os}</code>
                                ))}
                              </span>
                            </div>
                          )}
                          {countMissing(selectedSkill.skill.missing) === 0 && (
                            <p className="hint">Missing requirements are not available for this skill.</p>
                          )}
                        </div>
                      )}
                    </div>

                    <div className="skills-doc">
                      <div className="subheading">SKILL.md</div>
                      {selectedSkill.skillMd ? (
                        <pre className="skill-md">{selectedSkill.skillMd}</pre>
                      ) : (
                        <p className="hint">No SKILL.md content found for this skill.</p>
                      )}
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </section>

      <section className="devices-section memory-section">
        <div className="section-header">
          <div className="skills-header-title">
            <h2>Memory</h2>
            <span className="skills-count">
              {memoryLoading && memoryFiles.length === 0 ? 'Loading…' : `${memoryFiles.length} file(s)`}
            </span>
          </div>
          <div className="header-actions">
            <button className="btn btn-secondary" onClick={fetchMemoryFiles} disabled={memoryLoading}>
              {memoryLoading ? 'Refreshing…' : 'Refresh'}
            </button>
            <button className="btn btn-secondary" onClick={handleNewMemoryFile} disabled={memorySaveLoading}>
              {memorySaveLoading ? 'Creating…' : 'New file'}
            </button>
            <select
              className="memory-import-mode"
              value={memoryImportMode}
              onChange={(e) => setMemoryImportMode(e.target.value as 'overwrite' | 'merge')}
              disabled={memoryImportLoading}
              title="Import mode"
            >
              <option value="overwrite">Overwrite</option>
              <option value="merge">Merge</option>
            </select>
            <label className={`btn btn-secondary ${memoryImportLoading ? 'disabled' : ''}`}>
              {memoryImportLoading ? 'Importing…' : 'Import JSON'}
              <input
                type="file"
                accept="application/json"
                className="memory-import-input"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  // Allow selecting the same file again after import.
                  e.target.value = ''
                  if (f) handleImportMemory(f)
                }}
                disabled={memoryImportLoading}
              />
            </label>
            <a className="btn btn-secondary" href="/api/admin/memory/export" target="_blank" rel="noopener noreferrer">
              Export JSON
            </a>
          </div>
        </div>
        <p className="hint">
          Browse workspace memory files (<code>MEMORY.md</code> and <code>memory/**/*.md</code>). This is a view layer; editing the files
          changes what the memory index reads.
        </p>
        {memoryReport && (
          <p className="hint">
            Workspace: <code>{memoryReport.workspaceDir}</code> • Memory dir: <code>{memoryReport.memoryDir}</code>
          </p>
        )}

        {memoryError && <p className="memory-error">{memoryError}</p>}

        {memoryLoading && memoryFiles.length === 0 ? (
          <div className="loading">
            <div className="spinner"></div>
            <p>Loading memory files…</p>
          </div>
        ) : memoryFiles.length === 0 ? (
          <div className="empty-state">
            <p>No memory files found</p>
            <p className="hint">
              Expected in workspace: <code>MEMORY.md</code> or <code>memory/</code>.
            </p>
          </div>
        ) : (
          <div className="memory-layout">
            <div className="memory-list">
              <div className="memory-list-controls">
                <input
                  className="memory-filter"
                  value={memoryFilter}
                  onChange={(e) => setMemoryFilter(e.target.value)}
                  placeholder="Filter files…"
                />
              </div>

                  {filteredMemoryFiles.length === 0 ? (
                    <div className="empty-state">
                      <p>No matching files</p>
                    </div>
                  ) : (
                    filteredMemoryFiles.map((f) => {
                      const isActive = selectedMemoryPath === f.path
                      const isLoading = memoryFileLoading && isActive
                      return (
                        <button
                          key={f.path}
                          className={`memory-item ${isActive ? 'active' : ''}`}
                          onClick={() => {
                            if (memoryDirty && f.path !== selectedMemoryPath) {
                              if (!confirm('You have unsaved changes. Continue and discard them?')) return
                            }
                            fetchMemoryFile(f.path)
                          }}
                          disabled={isLoading}
                          title={f.path}
                        >
                      {isLoading && <ButtonSpinner />}
                      <div className="memory-item-text">
                        <div className="memory-item-row">
                          <span className="memory-path">{f.path}</span>
                          <span className="memory-meta">{formatBytes(f.bytes)}</span>
                        </div>
                        <div className="memory-meta">Updated {formatTimeAgo(f.mtimeMs)}</div>
                      </div>
                    </button>
                  )
                })
              )}
            </div>

            <div className="memory-viewer">
              {!selectedMemoryPath ? (
                <div className="empty-state">
                  <p>Select a file to view</p>
                </div>
              ) : memoryFileLoading && !selectedMemoryFile ? (
                <div className="loading">
                  <div className="spinner"></div>
                  <p>Loading file…</p>
                </div>
              ) : selectedMemoryFile ? (
                <>
                  <div className="memory-viewer-header">
                    <div className="memory-viewer-title">
                      <h3>
                        {selectedMemoryFile.path}
                        {memoryDirty ? ' *' : ''}
                      </h3>
                      <span className="skills-count">
                        {formatBytes(selectedMemoryFile.bytes)} • Updated {formatTimeAgo(selectedMemoryFile.mtimeMs)}
                      </span>
                    </div>
                    <div className="header-actions">
                      <a
                        className="btn btn-secondary btn-sm"
                        href={`/api/admin/memory/file/raw?path=${encodeURIComponent(selectedMemoryFile.path)}`}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Open raw
                      </a>
                      <button
                        className="btn btn-primary btn-sm"
                        onClick={handleSaveMemory}
                        disabled={!memoryDirty || memorySaveLoading || memoryFileLoading}
                      >
                        {memorySaveLoading && <ButtonSpinner />}
                        {memorySaveLoading ? 'Saving…' : 'Save'}
                      </button>
                      <button
                        className="btn btn-danger btn-sm"
                        onClick={handleDeleteMemory}
                        disabled={!selectedMemoryPath.startsWith('memory/') || memoryDeleteLoading || memorySaveLoading}
                        title={selectedMemoryPath.startsWith('memory/') ? 'Delete file' : 'MEMORY.md cannot be deleted from the UI'}
                      >
                        {memoryDeleteLoading && <ButtonSpinner />}
                        {memoryDeleteLoading ? 'Deleting…' : 'Delete'}
                      </button>
                    </div>
                  </div>
                  {selectedMemoryFile.truncated && (
                    <p className="hint">
                      Preview truncated (file is {formatBytes(selectedMemoryFile.bytes)}). Use “Open raw” for the full file.
                    </p>
                  )}
                  <textarea
                    className="memory-editor"
                    value={memoryDraft}
                    onChange={(e) => {
                      setMemoryDraft(e.target.value)
                      setMemoryDirty(true)
                    }}
                    spellCheck={false}
                  />
                </>
              ) : (
                <div className="empty-state">
                  <p>Unable to load file</p>
                </div>
              )}
            </div>
          </div>
        )}
      </section>

      {loading ? (
        <div className="loading">
          <div className="spinner"></div>
          <p>Loading devices...</p>
        </div>
      ) : (
        <>
          <section className="devices-section">
            <div className="section-header">
              <h2>Channel DM Pairing</h2>
              <div className="header-actions">
                <button className="btn btn-secondary" onClick={fetchPairing} disabled={pairingLoading}>
                  {pairingLoading ? 'Refreshing...' : 'Refresh'}
                </button>
              </div>
            </div>
            <p className="hint">
              This is for channel DM access (the pairing code you see in Telegram/Discord). It is different from “Devices” pairing.
            </p>

            <div className="gateway-controls">
              <div className="control-row">
                <label className="label" htmlFor="pairing-channel">Channel</label>
                <select
                  id="pairing-channel"
                  value={pairingChannel}
                  onChange={(e) => setPairingChannel(e.target.value)}
                  disabled={pairingLoading}
                >
                  <option value="telegram">Telegram</option>
                  <option value="discord">Discord</option>
                  <option value="slack">Slack</option>
                </select>
              </div>
              <div className="control-row">
                <label className="label" htmlFor="pairing-code">Pairing code</label>
                <input
                  id="pairing-code"
                  value={pairingCode}
                  onChange={(e) => setPairingCode(e.target.value)}
                  placeholder="e.g. 123456"
                />
              </div>
              <div className="control-row">
                <label className="label">
                  <input
                    type="checkbox"
                    checked={pairingNotify}
                    onChange={(e) => setPairingNotify(e.target.checked)}
                  />{' '}
                  Notify requester
                </label>
                <button
                  className="btn btn-primary"
                  onClick={() => handleApprovePairing(pairingCode)}
                  disabled={!pairingCode.trim() || actionInProgress?.startsWith('pairing:')}
                >
                  {actionInProgress?.startsWith('pairing:') && <ButtonSpinner />}
                  Approve
                </button>
              </div>
            </div>

            {pairingRequests.length === 0 ? (
              <div className="empty-state">
                <p>No pending pairing requests</p>
                <p className="hint">
                  Send a DM to the bot on the channel first; it will respond with a pairing code.
                </p>
              </div>
            ) : (
              <div className="devices-grid">
                {pairingRequests.map((r) => (
                  <div key={`${r.id}:${r.code}`} className="device-card pending">
                    <div className="device-header">
                      <span className="device-name">{r.id}</span>
                      <span className="device-badge pending">Pending</span>
                    </div>
                    <div className="device-details">
                      <div className="detail-row">
                        <span className="label">Code:</span>
                        <span className="value">{r.code}</span>
                      </div>
                      {r.createdAt && (
                        <div className="detail-row">
                          <span className="label">Requested:</span>
                          <span className="value">{r.createdAt}</span>
                        </div>
                      )}
                    </div>
                    <div className="device-actions">
                      <button
                        className="btn btn-primary"
                        onClick={() => handleApprovePairing(r.code)}
                        disabled={actionInProgress !== null}
                      >
                        {actionInProgress === `pairing:${r.code}` && <ButtonSpinner />}
                        {actionInProgress === `pairing:${r.code}` ? 'Approving...' : 'Approve'}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="devices-section">
        <div className="section-header">
          <h2>Pending Pairing Requests</h2>
          <div className="header-actions">
            {pending.length > 0 && (
              <button
                className="btn btn-primary"
                onClick={handleApproveAll}
                disabled={actionInProgress !== null}
              >
                {actionInProgress === 'all' && <ButtonSpinner />}
                {actionInProgress === 'all' ? 'Approving...' : `Approve All (${pending.length})`}
              </button>
            )}
            <button className="btn btn-secondary" onClick={fetchDevices} disabled={loading}>
              Refresh
            </button>
          </div>
        </div>

        {pending.length === 0 ? (
          <div className="empty-state">
            <p>No pending pairing requests</p>
            <p className="hint">
              Devices will appear here when they attempt to connect without being paired.
            </p>
          </div>
        ) : (
          <div className="devices-grid">
            {pending.map((device) => (
              <div key={device.requestId} className="device-card pending">
                <div className="device-header">
                  <span className="device-name">
                    {device.displayName || device.deviceId || 'Unknown Device'}
                  </span>
                  <span className="device-badge pending">Pending</span>
                </div>
                <div className="device-details">
                  {device.platform && (
                    <div className="detail-row">
                      <span className="label">Platform:</span>
                      <span className="value">{device.platform}</span>
                    </div>
                  )}
                  {device.clientId && (
                    <div className="detail-row">
                      <span className="label">Client:</span>
                      <span className="value">{device.clientId}</span>
                    </div>
                  )}
                  {device.clientMode && (
                    <div className="detail-row">
                      <span className="label">Mode:</span>
                      <span className="value">{device.clientMode}</span>
                    </div>
                  )}
                  {device.role && (
                    <div className="detail-row">
                      <span className="label">Role:</span>
                      <span className="value">{device.role}</span>
                    </div>
                  )}
                  {device.remoteIp && (
                    <div className="detail-row">
                      <span className="label">IP:</span>
                      <span className="value">{device.remoteIp}</span>
                    </div>
                  )}
                  <div className="detail-row">
                    <span className="label">Requested:</span>
                    <span className="value" title={formatTimestamp(device.ts)}>
                      {formatTimeAgo(device.ts)}
                    </span>
                  </div>
                </div>
                <div className="device-actions">
                  <button
                    className="btn btn-success"
                    onClick={() => handleApprove(device.requestId)}
                    disabled={actionInProgress !== null}
                  >
                    {actionInProgress === device.requestId && <ButtonSpinner />}
                    {actionInProgress === device.requestId ? 'Approving...' : 'Approve'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="devices-section">
        <div className="section-header">
          <h2>Paired Devices</h2>
        </div>

        {paired.length === 0 ? (
          <div className="empty-state">
            <p>No paired devices</p>
          </div>
        ) : (
          <div className="devices-grid">
            {paired.map((device, index) => (
              <div key={device.deviceId || index} className="device-card paired">
                <div className="device-header">
                  <span className="device-name">
                    {device.displayName || device.deviceId || 'Unknown Device'}
                  </span>
                  <span className="device-badge paired">Paired</span>
                </div>
                <div className="device-details">
                  {device.platform && (
                    <div className="detail-row">
                      <span className="label">Platform:</span>
                      <span className="value">{device.platform}</span>
                    </div>
                  )}
                  {device.clientId && (
                    <div className="detail-row">
                      <span className="label">Client:</span>
                      <span className="value">{device.clientId}</span>
                    </div>
                  )}
                  {device.clientMode && (
                    <div className="detail-row">
                      <span className="label">Mode:</span>
                      <span className="value">{device.clientMode}</span>
                    </div>
                  )}
                  {device.role && (
                    <div className="detail-row">
                      <span className="label">Role:</span>
                      <span className="value">{device.role}</span>
                    </div>
                  )}
                  <div className="detail-row">
                    <span className="label">Paired:</span>
                    <span className="value" title={formatTimestamp(device.approvedAtMs)}>
                      {formatTimeAgo(device.approvedAtMs)}
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
        </>
      )}
    </div>
  )
}
