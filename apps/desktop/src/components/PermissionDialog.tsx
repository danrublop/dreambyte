'use client'

import { useVideoStore } from '@/lib/store'
import { API_DISPLAY_NAMES } from '@/lib/permissions'
import { ShieldCheck, X, AlertTriangle } from 'lucide-react'
import { useState } from 'react'

/**
 * Permission prompt with Claude-Code-style 3-button UX:
 *   • Just once       — no rule saved
 *   • This session    — writes a session-scope rule (survives reload, cleared when conversation ends)
 *   • Always          — writes a user-scope rule (applies everywhere)
 *   • Deny            — blocks the call
 *
 * Rules persist via the store's createPermissionRule (IPC) and are evaluated
 * by src/lib/permissions/evaluator.ts in the main process. The in-memory
 * sessionPermissions map is also updated in place.
 */
export default function PermissionDialog() {
  const {
    pendingPermissionRequest,
    setPendingPermissionRequest,
    setSessionPermission,
    createPermissionRule,
    resolveSpendApproval,
    activeConversationId,
  } = useVideoStore()
  const [busy, setBusy] = useState(false)

  if (!pendingPermissionRequest) return null

  const req = pendingPermissionRequest
  const apiName = req.api as import('@/lib/types').APIName
  const displayName = API_DISPLAY_NAMES[apiName] ?? req.api

  async function close() {
    setPendingPermissionRequest(null)
    setBusy(false)
  }

  async function approve(scope: 'once' | 'session' | 'always') {
    if (busy) return
    setBusy(true)
    try {
      setSessionPermission(apiName, 'allow')
      if (scope === 'once') return

      const base = {
        decision: 'allow' as const,
        api: apiName,
        specifier: null,
        costCapUsd: null,
        expiresAt: null,
        createdBy: 'dialog' as const,
      }

      if (scope === 'session' && activeConversationId) {
        await createPermissionRule({
          ...base,
          scope: 'session',
          workspaceId: null,
          projectId: null,
          conversationId: activeConversationId,
          notes: 'Approved from dialog (session scope)',
        })
      } else if (scope === 'always') {
        await createPermissionRule({
          ...base,
          scope: 'user',
          workspaceId: null,
          projectId: null,
          conversationId: null,
          notes: 'Approved from dialog (user default)',
        })
      }
    } finally {
      // Settle the in-app gen-action awaiter (no-op for non-spend dialogs). Clears the request too.
      resolveSpendApproval({ decision: 'approved', scope })
      close()
    }
  }

  async function deny() {
    if (busy) return
    setSessionPermission(apiName, 'deny')
    resolveSpendApproval({ decision: 'denied' })
    close()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div
        className="rounded-lg shadow-2xl border max-w-md w-full mx-4"
        style={{
          backgroundColor: 'var(--color-panel-bg, #1e1e2e)',
          borderColor: 'var(--color-border, #2a2a3a)',
          color: 'var(--color-text-primary, #e0e0e0)',
        }}
      >
        {/* Header */}
        <div
          className="flex items-center gap-2 px-4 py-3 border-b"
          style={{ borderColor: 'var(--color-border, #2a2a3a)' }}
        >
          {req.costThresholdExceeded ? (
            <AlertTriangle size={18} className="text-amber-500" />
          ) : (
            <ShieldCheck size={18} className="text-amber-400" />
          )}
          <span className="font-medium text-sm">
            {req.costThresholdExceeded ? 'Expensive call — approval required' : 'Agent requesting API access'}
          </span>
          <button onClick={deny} className="ml-auto p-1 rounded hover:bg-white/10 transition-colors" aria-label="Deny">
            <X size={14} />
          </button>
        </div>

        {/* Body */}
        <div className="px-4 py-3 space-y-2 text-sm">
          <Row label="API" value={<span className="font-medium">{displayName}</span>} />
          <Row label="Reason" value={req.reason} />
          <Row
            label="Cost"
            value={
              <span className="font-medium text-amber-400">
                {req.estimatedCostUsd !== undefined
                  ? `~$${req.estimatedCostUsd.toFixed(2)} (${req.estimatedCost})`
                  : req.estimatedCost}
              </span>
            }
          />
          {req.details.prompt && (
            <Row
              label="Prompt"
              value={<span className="opacity-80 line-clamp-2">&ldquo;{req.details.prompt}&rdquo;</span>}
            />
          )}
          {req.details.model && <Row label="Model" value={req.details.model} />}
          {req.details.duration !== undefined && <Row label="Duration" value={`${req.details.duration}s`} />}
        </div>

        {/* Actions */}
        <div className="px-4 py-3 border-t space-y-2" style={{ borderColor: 'var(--color-border, #2a2a3a)' }}>
          <div className="grid grid-cols-3 gap-2">
            <ApproveBtn onClick={() => approve('once')} disabled={busy} primary label="Just once" />
            <ApproveBtn
              onClick={() => approve('session')}
              disabled={busy || !activeConversationId}
              label="This session"
              hint="Survives reload, clears when the chat ends"
            />
            <ApproveBtn
              onClick={() => approve('always')}
              disabled={busy}
              label="Always"
              hint="Adds a user-default rule"
            />
          </div>
          <button
            onClick={deny}
            disabled={busy}
            className="w-full px-3 py-2 text-sm font-medium rounded border transition-colors hover:bg-white/5 disabled:opacity-50"
            style={{ borderColor: 'var(--color-border, #2a2a3a)', color: '#ef4444' }}
          >
            Deny
          </button>
        </div>
      </div>
    </div>
  )
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <span className="text-[#6b6b7a] min-w-[60px]">{label}:</span>
      <span>{value}</span>
    </div>
  )
}

function ApproveBtn({
  onClick,
  disabled,
  label,
  hint,
  primary,
}: {
  onClick: () => void
  disabled?: boolean
  label: string
  hint?: string
  primary?: boolean
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={hint}
      className="px-3 py-2 text-sm font-medium rounded transition-colors disabled:opacity-50"
      style={
        primary
          ? { backgroundColor: '#22c55e', color: '#fff' }
          : { backgroundColor: 'transparent', border: '1px solid #22c55e', color: '#22c55e' }
      }
    >
      {label}
    </button>
  )
}
