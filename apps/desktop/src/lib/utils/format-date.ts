/**
 * Human-readable relative date for project "last updated" timestamps.
 * Bins: <1m → "just now", <1h → "Xm ago", <24h → "Xh ago", <7d → "Xd ago",
 * otherwise → locale short date.
 */
export function formatDate(dateStr: string, now = new Date()): string {
  const d = new Date(dateStr)
  const diffMs = now.getTime() - d.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  if (diffMins < 1) return 'just now'
  if (diffMins < 60) return `${diffMins}m ago`
  const diffHrs = Math.floor(diffMins / 60)
  if (diffHrs < 24) return `${diffHrs}h ago`
  const diffDays = Math.floor(diffHrs / 24)
  if (diffDays < 7) return `${diffDays}d ago`
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
