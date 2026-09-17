'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BarChart2, ChevronRight } from 'lucide-react'
import { useVideoStore } from '@/lib/store'
import { Segmented, SettingsEmptyState } from './shared'

interface UsageBreakdown {
  inputTokens: number
  outputTokens: number
  costUsd: number
  count: number
}

interface UsageRun {
  runId: string
  parentRunId: string | null
  agentType: string
  costUsd: number
  outcome: string | null
  durationMs: number
}

interface UsageSummary {
  totalInputTokens: number
  totalOutputTokens: number
  totalCostUsd: number
  totalApiCalls: number
  totalToolCalls: number
  totalCacheCreationTokens: number
  totalCacheReadTokens: number
  /** Runs that reported cache figures at all — the columns are nullable and an
   *  unreported run is NULL, not 0. Denominator for "measured on N runs". */
  cacheReportingRuns: number
  totalRuns: number
  errorRuns: number
  byAgent: Record<string, UsageBreakdown>
  byProvider: Record<string, UsageBreakdown>
  byModel: Record<string, UsageBreakdown>
  byMonth: Array<UsageBreakdown & { month: string }>
  runs: UsageRun[]
}

type RangeDays = 0 | 7 | 30 | 90 // 0 = all time
type Dimension = 'agent' | 'provider' | 'model'

const RANGE_OPTIONS: readonly { value: RangeDays; label: string }[] = [
  { value: 7, label: '7d' },
  { value: 30, label: '30d' },
  { value: 90, label: '90d' },
  { value: 0, label: 'All' },
]

const DIMENSION_OPTIONS: readonly { value: Dimension; label: string }[] = [
  { value: 'agent', label: 'Agent' },
  { value: 'provider', label: 'Provider' },
  { value: 'model', label: 'Model' },
]

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function formatNumber(n: number): string {
  return n.toLocaleString('en-US')
}

function formatCost(usd: number): string {
  return `$${usd.toFixed(2)}`
}

/** 'YYYY-MM' → 'Mon YYYY' (e.g. '2026-05' → 'May 2026'). Falls back to raw on parse failure. */
function formatMonth(month: string): string {
  const [year, mon] = month.split('-')
  const idx = Number(mon) - 1
  return MONTH_NAMES[idx] ? `${MONTH_NAMES[idx]} ${year}` : month
}

/** Label/runs/tokens/cost table — drives the Agent | Provider | Model breakdown. */
function BreakdownTable({
  labelHeader,
  rows,
}: {
  labelHeader: string
  rows: Array<{ label: string; stats: UsageBreakdown }>
}) {
  return (
    <div className="overflow-hidden rounded-[var(--radius-md)] border" style={{ borderColor: 'var(--hairline)' }}>
      <table className="w-full text-[12px]">
        <thead>
          <tr style={{ backgroundColor: 'var(--panel)' }}>
            <th className="px-2 py-1 text-left font-normal text-[var(--mute)]">{labelHeader}</th>
            <th className="px-2 py-1 text-right font-normal text-[var(--mute)]">Runs</th>
            <th className="px-2 py-1 text-right font-normal text-[var(--mute)]">Tokens</th>
            <th className="px-2 py-1 text-right font-normal text-[var(--mute)]">Cost</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr style={{ borderTop: '1px solid var(--hairline)' }}>
              <td className="px-2 py-2 text-center text-[var(--mute)]" colSpan={4}>
                No data in this range
              </td>
            </tr>
          ) : (
            rows.map(({ label, stats }, i) => (
              <tr key={label} style={{ borderTop: i > 0 ? '1px solid var(--hairline)' : undefined }}>
                <td className="px-2 py-1 text-[var(--ink)]">{label}</td>
                <td className="px-2 py-1 text-right tabular-nums text-[var(--mute)]">{formatNumber(stats.count)}</td>
                <td className="px-2 py-1 text-right tabular-nums text-[var(--mute)]">
                  {formatNumber(stats.inputTokens + stats.outputTokens)}
                </td>
                <td className="px-2 py-1 text-right tabular-nums text-[var(--mute)]">{formatCost(stats.costUsd)}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  )
}

const CHART_BAR_AREA = 72 // px of vertical room the bars grow into

/** Monthly cost bars (oldest→newest left→right) in the data-viz --chart-1 color.
 *  Always renders the frame — an empty/zero range shows a baseline placeholder
 *  rather than disappearing, so switching time ranges never blanks the chart. */
function MonthlyCostChart({ months }: { months: UsageSummary['byMonth'] }) {
  const [hover, setHover] = useState<number | null>(null)
  // byMonth is newest-first; show the most recent 12, oldest on the left.
  const ordered = useMemo(() => months.slice(0, 12).reverse(), [months])
  const maxCost = Math.max(...ordered.map((m) => m.costUsd), 0)
  // When the visible bars span more than one calendar year, a bare "May" / "Nov"
  // axis is ambiguous — append a 2-digit year so adjacent same-month bars differ.
  const spansYears = new Set(ordered.map((m) => m.month.split('-')[0])).size > 1
  const isEmpty = ordered.length === 0 || maxCost === 0

  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="text-[11px] font-medium tracking-wide text-[var(--mute)]">Monthly cost</span>
        {!isEmpty && <span className="text-[10px] tabular-nums text-[var(--mute)]">peak {formatCost(maxCost)}</span>}
      </div>
      <div
        className="relative rounded-[var(--radius-md)] border px-3 pb-5 pt-3"
        style={{ borderColor: 'var(--hairline)', height: CHART_BAR_AREA + 44 }}
        role="img"
        aria-label={
          isEmpty
            ? 'No usage cost in the selected range.'
            : `Monthly cost across ${ordered.length} month(s); peak ${formatCost(maxCost)}. See the breakdown table for exact values.`
        }
      >
        {/* baseline */}
        <div className="absolute inset-x-3 bottom-5 h-px" style={{ background: 'var(--hairline)' }} />
        {isEmpty ? (
          <div className="flex h-full items-center justify-center text-[11px] text-[var(--mute)]">
            No usage cost in this range
          </div>
        ) : (
          <div className="flex h-full items-end gap-1.5">
            {ordered.map((m, i) => {
              const h = m.costUsd > 0 ? Math.max(3, Math.round((m.costUsd / maxCost) * CHART_BAR_AREA)) : 0
              const isHover = hover === i
              return (
                <div
                  key={m.month}
                  className="relative flex flex-1 flex-col items-center justify-end"
                  style={{ minWidth: 8 }}
                  onMouseEnter={() => setHover(i)}
                  onMouseLeave={() => setHover(null)}
                >
                  {isHover && (
                    <div
                      className="absolute -top-1 whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] tabular-nums"
                      style={{ background: 'var(--card)', color: 'var(--ink)', border: '1px solid var(--hairline)' }}
                    >
                      {formatCost(m.costUsd)} · {formatNumber(m.count)} runs
                    </div>
                  )}
                  <div
                    title={`${formatMonth(m.month)} · ${formatCost(m.costUsd)} · ${formatNumber(m.count)} runs`}
                    style={{
                      width: '100%',
                      maxWidth: 30,
                      height: h,
                      background: 'var(--chart-1)',
                      opacity: hover === null || isHover ? 1 : 0.5,
                      borderRadius: '3px 3px 0 0',
                      transition: 'opacity 120ms',
                    }}
                  />
                  <div className="absolute -bottom-5 text-[9px] tabular-nums text-[var(--mute)]">
                    {MONTH_NAMES[Number(m.month.split('-')[1]) - 1] ?? ''}
                    {spansYears ? ` '${m.month.split('-')[0].slice(2)}` : ''}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

/** Sub-agent run drill-down: top-level runs, each expandable to its sub-agent runs. */
function RunsDrillDown({ runs }: { runs: UsageRun[] }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const { tops, childrenOf } = useMemo(() => {
    const ids = new Set(runs.map((r) => r.runId))
    const childrenOf = new Map<string, UsageRun[]>()
    const tops: UsageRun[] = []
    for (const r of runs) {
      if (r.parentRunId && ids.has(r.parentRunId)) {
        const arr = childrenOf.get(r.parentRunId) ?? []
        arr.push(r)
        childrenOf.set(r.parentRunId, arr)
      } else {
        tops.push(r)
      }
    }
    return { tops, childrenOf }
  }, [runs])

  if (runs.length === 0) return null

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const Row = ({ run, depth, seen }: { run: UsageRun; depth: number; seen: Set<string> }) => {
    // Cycle guard: a corrupt parentRunId chain (only reachable via raw inserts,
    // never through logAgentUsage) would otherwise infinite-loop the render thread.
    if (seen.has(run.runId) || depth > 16) return null
    const kids = childrenOf.get(run.runId) ?? []
    const isOpen = expanded.has(run.runId)
    const hasKids = kids.length > 0
    const childSeen = new Set(seen).add(run.runId)
    return (
      <>
        <div
          className="flex items-center gap-2 px-2 py-1 text-[12px]"
          style={{ paddingLeft: 8 + depth * 16, borderTop: '1px solid var(--hairline)' }}
        >
          {hasKids ? (
            <button
              onClick={() => toggle(run.runId)}
              aria-expanded={isOpen}
              aria-label={isOpen ? 'Collapse sub-agent runs' : 'Expand sub-agent runs'}
              className="no-style flex items-center"
              style={{ color: 'var(--mute)' }}
            >
              <ChevronRight
                size={13}
                style={{ transform: isOpen ? 'rotate(90deg)' : 'none', transition: 'transform 120ms' }}
              />
            </button>
          ) : (
            <span style={{ width: 13 }} />
          )}
          <span className="flex-1 truncate text-[var(--ink)]">{run.agentType}</span>
          {run.outcome === 'error' && <span className="text-[11px] text-[var(--danger)]">failed</span>}
          <span className="tabular-nums text-[var(--mute)]">{formatCost(run.costUsd)}</span>
        </div>
        {isOpen && kids.map((k) => <Row key={k.runId} run={k} depth={depth + 1} seen={childSeen} />)}
      </>
    )
  }

  return (
    <div>
      <div className="mb-1.5 text-[11px] font-medium tracking-wide text-[var(--mute)]">Runs</div>
      <div className="overflow-hidden rounded-[var(--radius-md)] border" style={{ borderColor: 'var(--hairline)' }}>
        {tops.map((r) => (
          <Row key={r.runId} run={r} depth={0} seen={new Set()} />
        ))}
      </div>
    </div>
  )
}

export default function UsageSection() {
  const projectList = useVideoStore((s) => s.projectList)
  const fetchProjectList = useVideoStore((s) => s.fetchProjectList)

  const [data, setData] = useState<UsageSummary | null>(null)
  const [loading, setLoading] = useState(true) // first load only
  const [refetching, setRefetching] = useState(false) // filter-driven reloads
  const [error, setError] = useState<string | null>(null)

  const [projectId, setProjectId] = useState<string>('all')
  const [rangeDays, setRangeDays] = useState<RangeDays>(0)
  const [dimension, setDimension] = useState<Dimension>('agent')

  // Monotonic request id: filters can fire overlapping fetches, and the heavier
  // "all time / all projects" query can resolve after a lighter one. Only the
  // latest request is allowed to write state, so a stale response never clobbers
  // the active scope with the wrong numbers.
  const reqIdRef = useRef(0)

  const filtersActive = projectId !== 'all' || rangeDays !== 0

  useEffect(() => {
    if (projectList.length === 0) void fetchProjectList()
  }, [projectList.length, fetchProjectList])

  const load = useCallback(
    async (isFirst: boolean) => {
      const ipc = typeof window !== 'undefined' ? window.dreambyteApi?.usage : undefined
      if (!ipc?.getSummary) {
        setError('usage requires the desktop runtime (window.dreambyteApi.usage unavailable).')
        setLoading(false)
        return
      }
      if (isFirst) setLoading(true)
      else setRefetching(true)
      const reqId = ++reqIdRef.current
      try {
        const summary = (await ipc.getSummary(
          projectId === 'all' ? undefined : projectId,
          rangeDays === 0 ? undefined : { days: rangeDays },
        )) as unknown as UsageSummary
        if (reqId !== reqIdRef.current) return // a newer request superseded this one
        setData(summary)
        setError(null)
      } catch (e) {
        if (reqId !== reqIdRef.current) return
        setError(String(e))
      } finally {
        if (reqId === reqIdRef.current) {
          setLoading(false)
          setRefetching(false)
        }
      }
    },
    [projectId, rangeDays],
  )

  useEffect(() => {
    void load(data === null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, rangeDays])

  if (loading) {
    return <div className="py-1 text-sm text-[var(--mute)]">Loading usage data…</div>
  }
  if (error) {
    return <div className="py-1 text-sm text-[var(--danger)]">Failed to load usage data.</div>
  }

  const totalTokens = (data?.totalInputTokens ?? 0) + (data?.totalOutputTokens ?? 0)
  // totalRuns guards the case where a run failed before logging any tokens/API
  // calls — it still counts as usage and must not read as an empty dashboard.
  const hasData = !!data && (totalTokens > 0 || data.totalApiCalls > 0 || data.totalRuns > 0)

  const Filters = (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <select
        value={projectId}
        onChange={(e) => setProjectId(e.target.value)}
        aria-label="Filter usage by project"
        className="h-[28px] rounded-[var(--radius-md)] border px-2 text-[12px] text-[var(--ink)]"
        style={{ borderColor: 'var(--border-input)', background: 'var(--input-bg)' }}
      >
        <option value="all">All projects</option>
        {projectList.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <Segmented options={RANGE_OPTIONS} value={rangeDays} onChange={setRangeDays} />
    </div>
  )

  // True first-run only (no filters AND nothing ever logged): warm onboarding.
  // When a filter merely yields nothing, we fall through and render the full
  // scaffold with empty charts/tables — switching time ranges never blanks it.
  if (!data || (!hasData && !filtersActive)) {
    return (
      <SettingsEmptyState
        icon={<BarChart2 size={26} strokeWidth={1.5} />}
        title="No usage yet"
        description="Token and cost usage shows up here once your agent runs."
      />
    )
  }

  const summary = data
  const byCost = (a: { stats: UsageBreakdown }, b: { stats: UsageBreakdown }) => b.stats.costUsd - a.stats.costUsd
  const dimRecord =
    dimension === 'agent' ? summary.byAgent : dimension === 'provider' ? summary.byProvider : summary.byModel
  const dimRows = Object.entries(dimRecord ?? {})
    .map(([label, stats]) => ({ label, stats }))
    .sort(byCost)
  const errorRate = summary.totalRuns > 0 ? (summary.errorRuns / summary.totalRuns) * 100 : 0
  // Prompt-cache effectiveness (#388/#402 made the agent cache history; this is
  // where you see whether it worked). Read ÷ (read + write) = share of cacheable
  // prompt tokens served from cache. Shown ONLY when some run actually reported
  // cache figures — the columns are NULL when unreported, and rendering "0%" for
  // a provider that never said anything would be a lie, not a bad score.
  const cacheTotal = (summary.totalCacheReadTokens ?? 0) + (summary.totalCacheCreationTokens ?? 0)
  const cacheHitRate = cacheTotal > 0 ? ((summary.totalCacheReadTokens ?? 0) / cacheTotal) * 100 : null

  return (
    <div className="space-y-4" style={{ opacity: refetching ? 0.5 : 1, transition: 'opacity 120ms' }}>
      {/* Filters scope everything below; disabled during refetch so numbers don't flicker. */}
      <fieldset disabled={refetching} style={{ border: 0, padding: 0, margin: 0 }}>
        {Filters}
      </fieldset>

      {/* Headline totals */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-2">
        {[
          { label: 'Total tokens', value: formatNumber(totalTokens) },
          { label: 'Total cost', value: formatCost(summary.totalCostUsd) },
          { label: 'API calls', value: formatNumber(summary.totalApiCalls) },
          { label: 'Tool calls', value: formatNumber(summary.totalToolCalls) },
        ].map((s) => (
          <div key={s.label}>
            <div className="mb-0.5 text-[11px] font-medium tracking-wide text-[var(--mute)]">{s.label}</div>
            <div className="text-sm font-medium tabular-nums text-[var(--ink)]">{s.value}</div>
          </div>
        ))}
      </div>

      {/* Run / error rate */}
      <div className="text-[12px] text-[var(--mute)]">
        <span className="tabular-nums text-[var(--ink)]">{formatNumber(summary.totalRuns)}</span> runs
        {summary.errorRuns > 0 && (
          <span className="ml-1.5 text-[var(--danger)]">
            · {summary.errorRuns} failed ({errorRate.toFixed(0)}%)
          </span>
        )}
      </div>

      {/* Prompt cache */}
      {cacheHitRate !== null && (
        <div className="text-[12px] text-[var(--mute)]">
          Prompt cache <span className="tabular-nums text-[var(--ink)]">{cacheHitRate.toFixed(0)}%</span> hit ·{' '}
          <span className="tabular-nums">{formatNumber(summary.totalCacheReadTokens)}</span> read /{' '}
          <span className="tabular-nums">{formatNumber(summary.totalCacheCreationTokens)}</span> written
          <span className="ml-1.5">(reported by {formatNumber(summary.cacheReportingRuns)} runs)</span>
        </div>
      )}

      {/* Monthly cost trend */}
      <MonthlyCostChart months={summary.byMonth ?? []} />

      {/* Breakdown with dimension toggle */}
      <div className="space-y-1.5">
        <Segmented options={DIMENSION_OPTIONS} value={dimension} onChange={setDimension} />
        <BreakdownTable
          labelHeader={dimension === 'agent' ? 'Agent' : dimension === 'provider' ? 'Provider' : 'Model'}
          rows={dimRows}
        />
      </div>

      {/* Sub-agent run drill-down */}
      <RunsDrillDown runs={summary.runs ?? []} />
    </div>
  )
}
