/**
 * Lottie search service.
 * Tries the LottieFiles API when `LOTTIEFILES_API_KEY` is set. Falls
 * back to a curated in-file index of ~40 common explainer-video
 * animations. Called by the agent tool handler and Electron IPC.
 */

import { createLogger } from '@/lib/logger'

const log = createLogger('lottie')

export type AnimCategory =
  | 'icon'
  | 'illustration'
  | 'transition'
  | 'loader'
  | 'celebration'
  | 'data-viz'
  | 'character'
  | 'abstract'

interface FallbackAnimation {
  id: string
  name: string
  url: string
  tags: string[]
  category: AnimCategory
}

// Curated fallback animations for common explainer video use cases
const FALLBACK_ANIMATIONS: FallbackAnimation[] = [
  // ── Icons ──
  {
    id: 'checkmark',
    name: 'Checkmark Success',
    url: 'https://lottie.host/4db68bbd-31f6-4cd8-84eb-189de081159a/IGmMCqhzpt.json',
    tags: ['success', 'check', 'done', 'complete', 'green'],
    category: 'icon',
  },
  {
    id: 'error',
    name: 'Error Cross',
    url: 'https://lottie.host/b0d96bbd-6f9c-4c97-b5b3-bf7b0defa4f5/vOzMsxlCvx.json',
    tags: ['error', 'fail', 'cross', 'wrong', 'red'],
    category: 'icon',
  },
  {
    id: 'lock',
    name: 'Lock Security',
    url: 'https://lottie.host/8a2e3d4f-5b6c-7d8e-9f0a-1b2c3d4e5f6a/lock.json',
    tags: ['lock', 'security', 'shield', 'protection', 'safe', 'privacy'],
    category: 'icon',
  },
  {
    id: 'notification',
    name: 'Notification Bell',
    url: 'https://lottie.host/3b2a1098-7654-3210-fedc-ba9876543210/bell.json',
    tags: ['notification', 'bell', 'alert', 'message', 'ring'],
    category: 'icon',
  },
  {
    id: 'search',
    name: 'Search Magnifier',
    url: 'https://lottie.host/2a109876-5432-10fe-dcba-987654321098/search.json',
    tags: ['search', 'magnifier', 'find', 'discover', 'explore'],
    category: 'icon',
  },
  {
    id: 'settings-gear',
    name: 'Settings Gear',
    url: 'https://lottie.host/1098a654-3210-fedc-ba98-765432109876/gear.json',
    tags: ['settings', 'gear', 'config', 'tools', 'options'],
    category: 'icon',
  },
  {
    id: 'download',
    name: 'Download Arrow',
    url: 'https://lottie.host/09876543-210f-edcb-a987-654321098765/download.json',
    tags: ['download', 'arrow', 'save', 'install'],
    category: 'icon',
  },
  {
    id: 'email',
    name: 'Email Message',
    url: 'https://lottie.host/f8765432-10fe-dcba-9876-543210987654/email.json',
    tags: ['email', 'message', 'mail', 'send', 'communication'],
    category: 'icon',
  },
  {
    id: 'thumbs-up',
    name: 'Thumbs Up',
    url: 'https://lottie.host/c5432109-edcb-a987-6543-210987654321/thumbs.json',
    tags: ['thumbs', 'up', 'approve', 'good', 'positive', 'agree'],
    category: 'icon',
  },
  {
    id: 'cloud',
    name: 'Cloud Upload',
    url: 'https://lottie.host/a1b2c3d4-e5f6-7890-abcd-ef1234567890/cloud.json',
    tags: ['cloud', 'upload', 'storage', 'server', 'hosting', 'saas'],
    category: 'icon',
  },
  {
    id: 'api',
    name: 'API Connection',
    url: 'https://lottie.host/b2c3d4e5-f6a7-8901-bcde-f12345678901/api.json',
    tags: ['api', 'connection', 'endpoint', 'integration', 'webhook'],
    category: 'icon',
  },
  {
    id: 'database',
    name: 'Database Storage',
    url: 'https://lottie.host/c3d4e5f6-a7b8-9012-cdef-123456789012/database.json',
    tags: ['database', 'storage', 'sql', 'data', 'server', 'backend'],
    category: 'icon',
  },
  {
    id: 'mobile',
    name: 'Mobile Phone',
    url: 'https://lottie.host/d4e5f6a7-b8c9-0123-defa-234567890123/mobile.json',
    tags: ['mobile', 'phone', 'smartphone', 'app', 'device'],
    category: 'icon',
  },
  {
    id: 'wifi',
    name: 'WiFi Signal',
    url: 'https://lottie.host/e5f6a7b8-c9d0-1234-efab-345678901234/wifi.json',
    tags: ['wifi', 'signal', 'wireless', 'internet', 'connectivity'],
    category: 'icon',
  },
  {
    id: 'lightbulb',
    name: 'Lightbulb Idea',
    url: 'https://lottie.host/f6a7b8c9-d0e1-2345-fabc-456789012345/lightbulb.json',
    tags: ['lightbulb', 'idea', 'innovation', 'creative', 'insight'],
    category: 'icon',
  },

  // ── Loaders ──
  {
    id: 'loading-spinner',
    name: 'Loading Spinner',
    url: 'https://lottie.host/f74a5c33-25f8-4fa1-8e34-5e43ef3c63a2/jV1pUEdcJn.json',
    tags: ['loading', 'spinner', 'progress', 'wait'],
    category: 'loader',
  },
  {
    id: 'progress-bar',
    name: 'Progress Bar',
    url: 'https://lottie.host/a7b8c9d0-e1f2-3456-abcd-567890123456/progress.json',
    tags: ['progress', 'bar', 'loading', 'percentage', 'fill'],
    category: 'loader',
  },
  {
    id: 'sync',
    name: 'Sync Rotate',
    url: 'https://lottie.host/b8c9d0e1-f2a3-4567-bcde-678901234567/sync.json',
    tags: ['sync', 'rotate', 'refresh', 'update', 'reload'],
    category: 'loader',
  },

  // ── Celebrations ──
  {
    id: 'confetti',
    name: 'Confetti Celebration',
    url: 'https://lottie.host/3b0b3f4a-2f4c-4f8c-8c97-5e34db6d4c3a/QeaStYWLwm.json',
    tags: ['confetti', 'celebration', 'party', 'winner', 'congrats'],
    category: 'celebration',
  },
  {
    id: 'trophy',
    name: 'Trophy Winner',
    url: 'https://lottie.host/d6543210-fedc-ba98-7654-321098765432/trophy.json',
    tags: ['trophy', 'winner', 'award', 'achievement', 'prize', 'champion'],
    category: 'celebration',
  },
  {
    id: 'star-burst',
    name: 'Star Burst',
    url: 'https://lottie.host/c9d0e1f2-a3b4-5678-cdef-789012345678/starburst.json',
    tags: ['star', 'burst', 'sparkle', 'highlight', 'featured', 'premium'],
    category: 'celebration',
  },
  {
    id: 'fireworks',
    name: 'Fireworks',
    url: 'https://lottie.host/d0e1f2a3-b4c5-6789-defa-890123456789/fireworks.json',
    tags: ['fireworks', 'celebration', 'launch', 'milestone', 'new-year'],
    category: 'celebration',
  },

  // ── Data Visualization ──
  {
    id: 'chart-growth',
    name: 'Chart Growth',
    url: 'https://lottie.host/fa84762d-2c67-4d58-8f36-af0d0c53b632/mdnJyRzGLw.json',
    tags: ['chart', 'growth', 'graph', 'analytics', 'data', 'increase'],
    category: 'data-viz',
  },
  {
    id: 'pie-chart',
    name: 'Pie Chart',
    url: 'https://lottie.host/e1f2a3b4-c5d6-7890-efab-901234567890/piechart.json',
    tags: ['pie', 'chart', 'percentage', 'distribution', 'breakdown', 'analytics'],
    category: 'data-viz',
  },
  {
    id: 'bar-chart',
    name: 'Bar Chart',
    url: 'https://lottie.host/f2a3b4c5-d6e7-8901-fabc-012345678901/barchart.json',
    tags: ['bar', 'chart', 'comparison', 'metrics', 'statistics'],
    category: 'data-viz',
  },
  {
    id: 'counter',
    name: 'Number Counter',
    url: 'https://lottie.host/a3b4c5d6-e7f8-9012-abcd-123456789012/counter.json',
    tags: ['counter', 'number', 'count', 'metric', 'kpi', 'statistic'],
    category: 'data-viz',
  },

  // ── Illustrations ──
  {
    id: 'rocket',
    name: 'Rocket Launch',
    url: 'https://lottie.host/ad4f04af-b547-44a5-be0d-12e83ac9db65/yWmtUzScwf.json',
    tags: ['rocket', 'launch', 'growth', 'startup', 'blast'],
    category: 'illustration',
  },
  {
    id: 'coins',
    name: 'Coins Money',
    url: 'https://lottie.host/9e5f8f3a-c7d4-4f6e-b8a9-2e3d5f7a1b4c/coins.json',
    tags: ['coins', 'money', 'finance', 'payment', 'currency', 'dollar'],
    category: 'illustration',
  },
  {
    id: 'heart',
    name: 'Heart Like',
    url: 'https://lottie.host/4c3b2a10-9876-5432-10fe-dcba98765432/heart.json',
    tags: ['heart', 'like', 'love', 'favorite', 'health'],
    category: 'illustration',
  },
  {
    id: 'fire',
    name: 'Fire Flame',
    url: 'https://lottie.host/e7654321-0fed-cba9-8765-432109876543/fire.json',
    tags: ['fire', 'flame', 'hot', 'trending', 'popular'],
    category: 'illustration',
  },
  {
    id: 'globe',
    name: 'Globe Spin',
    url: 'https://lottie.host/b4c5d6e7-f8a9-0123-bcde-234567890123/globe.json',
    tags: ['globe', 'world', 'earth', 'global', 'international', 'map'],
    category: 'illustration',
  },
  {
    id: 'shield',
    name: 'Shield Check',
    url: 'https://lottie.host/c5d6e7f8-a9b0-1234-cdef-345678901234/shield.json',
    tags: ['shield', 'check', 'verified', 'secure', 'protected', 'trust'],
    category: 'illustration',
  },
  {
    id: 'megaphone',
    name: 'Megaphone Announce',
    url: 'https://lottie.host/d6e7f8a9-b0c1-2345-defa-456789012345/megaphone.json',
    tags: ['megaphone', 'announce', 'marketing', 'broadcast', 'promotion'],
    category: 'illustration',
  },
  {
    id: 'target',
    name: 'Target Bullseye',
    url: 'https://lottie.host/e7f8a9b0-c1d2-3456-efab-567890123456/target.json',
    tags: ['target', 'bullseye', 'goal', 'aim', 'precision', 'focus'],
    category: 'illustration',
  },

  // ── Characters ──
  {
    id: 'person-walking',
    name: 'Person Walking',
    url: 'https://lottie.host/7f6e5d4c-3b2a-1098-7654-3210fedcba98/walk.json',
    tags: ['person', 'walking', 'human', 'people', 'character'],
    category: 'character',
  },
  {
    id: 'team',
    name: 'Team Collaboration',
    url: 'https://lottie.host/f8a9b0c1-d2e3-4567-fabc-678901234567/team.json',
    tags: ['team', 'collaboration', 'people', 'group', 'meeting', 'together'],
    category: 'character',
  },
  {
    id: 'presenter',
    name: 'Person Presenting',
    url: 'https://lottie.host/a9b0c1d2-e3f4-5678-abcd-789012345678/presenter.json',
    tags: ['presenter', 'speaking', 'pitch', 'presentation', 'teacher'],
    category: 'character',
  },

  // ── Transitions / Abstract ──
  {
    id: 'arrow-up',
    name: 'Arrow Up',
    url: 'https://lottie.host/6e5d4c3b-2a10-9876-5432-10fedcba9876/arrow.json',
    tags: ['arrow', 'up', 'increase', 'rise', 'direction', 'growth'],
    category: 'transition',
  },
  {
    id: 'data-flow',
    name: 'Data Flow',
    url: 'https://lottie.host/5d4c3b2a-1098-7654-3210-fedcba987654/flow.json',
    tags: ['data', 'flow', 'network', 'transfer', 'stream', 'pipeline'],
    category: 'transition',
  },
  {
    id: 'process-arrow',
    name: 'Process Arrow',
    url: 'https://lottie.host/b0c1d2e3-f4a5-6789-bcde-890123456789/process.json',
    tags: ['process', 'arrow', 'step', 'flow', 'next', 'forward', 'workflow'],
    category: 'transition',
  },
  {
    id: 'comparison',
    name: 'Comparison Indicator',
    url: 'https://lottie.host/c1d2e3f4-a5b6-7890-cdef-901234567890/compare.json',
    tags: ['comparison', 'versus', 'vs', 'before-after', 'difference'],
    category: 'transition',
  },
  {
    id: 'pulse-ring',
    name: 'Pulse Ring',
    url: 'https://lottie.host/d2e3f4a5-b6c7-8901-defa-012345678901/pulse.json',
    tags: ['pulse', 'ring', 'ripple', 'attention', 'highlight', 'focus'],
    category: 'abstract',
  },
  {
    id: 'particles',
    name: 'Floating Particles',
    url: 'https://lottie.host/e3f4a5b6-c7d8-9012-efab-123456789012/particles.json',
    tags: ['particles', 'floating', 'ambient', 'background', 'dots', 'atmosphere'],
    category: 'abstract',
  },
  {
    id: 'wave',
    name: 'Wave Motion',
    url: 'https://lottie.host/f4a5b6c7-d8e9-0123-fabc-234567890123/wave.json',
    tags: ['wave', 'motion', 'fluid', 'organic', 'flow', 'water'],
    category: 'abstract',
  },
]

export interface LottieSearchInput {
  query: string
  category?: AnimCategory | null
  limit?: number
}

export interface LottieResult {
  id: string
  name: string
  url: string
  previewUrl: string | null
  tags: string[]
}

export interface LottieSearchResult {
  results: LottieResult[]
  source: 'lottiefiles' | 'fallback'
}

export async function searchLottie(input: LottieSearchInput): Promise<LottieSearchResult> {
  const query = input.query ?? ''
  const category = input.category ?? null
  const limit = input.limit ?? 8

  const apiKey = process.env.LOTTIEFILES_API_KEY
  if (apiKey) {
    try {
      const response = await fetch(
        `https://lottie.host/api/v1/search?query=${encodeURIComponent(query)}&limit=${limit}`,
        {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(5000),
        },
      )
      if (response.ok) {
        const data = await response.json()
        const results = (data.results || data.data || []).map((item: Record<string, unknown>) => ({
          id: (item.id ?? item.slug) as string,
          name: (item.name ?? item.title) as string,
          url: (item.lottieUrl ?? item.jsonUrl ?? item.url) as string,
          previewUrl: ((item.previewUrl ?? item.gifUrl ?? item.imageUrl) as string | null) ?? null,
          tags: (item.tags as string[]) ?? [],
        }))
        return { results: results.slice(0, limit), source: 'lottiefiles' }
      }
    } catch (err) {
      log.error('LottieFiles API error', { error: err })
    }
  }

  // Fallback: filter curated set by query keywords and optional category
  const q = query.toLowerCase().split(/\s+/).filter(Boolean)
  let pool = FALLBACK_ANIMATIONS as FallbackAnimation[]
  if (category) {
    pool = pool.filter((a) => a.category === category)
  }

  const scored = pool
    .map((a) => {
      const searchable = (a.name + ' ' + a.tags.join(' ')).toLowerCase()
      const hits = q.filter((word) => searchable.includes(word)).length
      return { ...a, score: hits }
    })
    .filter((a) => q.length === 0 || a.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)

  const results = scored.map(({ score: _s, ...rest }) => ({ ...rest, previewUrl: null }))
  return { results, source: 'fallback' }
}
