/**
 * Quality score computation for generation logs.
 * Combines implicit signals (user action, time, edit distance)
 * and explicit signals (rating, export success) into a 0–1 score.
 */

export interface ScorableLog {
  userAction?: string | null
  timeToActionMs?: number | null
  editDistance?: number | null
  generatedCodeLength?: number | null
  userRating?: number | null
  exportSucceeded?: boolean | null
}

export function computeQualityScore(log: ScorableLog): number {
  if (!log.userAction) return -1

  let score = 0.5

  // User action signals
  switch (log.userAction) {
    case 'kept':
      score += 0.3
      break
    case 'edited':
      score += 0.1
      break
    case 'regenerated':
      score -= 0.4
      break
    case 'deleted':
      score -= 0.5
      break
  }

  // Time to action — faster signals are stronger
  if (log.timeToActionMs != null) {
    if (log.userAction === 'regenerated' && log.timeToActionMs < 5000) {
      score -= 0.2 // immediate rejection
    }
    if (log.userAction === 'kept' && log.timeToActionMs > 30000) {
      score += 0.1 // reviewed and approved
    }
  }

  // Edit distance — high relative edit = more rework needed
  if (log.editDistance != null && log.generatedCodeLength) {
    const relativeEdit = log.editDistance / log.generatedCodeLength
    if (relativeEdit > 0.6)
      score -= 0.4 // changed >60% of code — heavy rework
    else if (relativeEdit > 0.3)
      score -= 0.2 // changed >30% — moderate rework
    else if (relativeEdit < 0.05) score += 0.1 // barely changed — good output
  }

  // Explicit rating
  if (log.userRating != null) {
    score += (log.userRating - 3) * 0.1
  }

  // Export success
  if (log.exportSucceeded === false) score -= 0.3
  if (log.exportSucceeded === true) score += 0.1

  return Math.max(0, Math.min(1, score))
}
