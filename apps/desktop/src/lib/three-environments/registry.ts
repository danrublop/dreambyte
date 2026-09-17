/**
 * Named Three.js stage environments — runtime is bundled in `inlined-runtimes.ts` and injected in generateThreeHTML.
 * Use these IDs with applyDreambyteThreeEnvironment(envId, scene, renderer, camera).
 */
export interface DreambyteThreeEnvironmentMeta {
  id: string
  name: string
  description: string
  tags: string[]
}

export const DREAMBYTE_STUDIO_ENV_IDS = [
  'track_rolling_topdown',
  'studio_white',
  'cinematic_fog',
  'iso_playful',
  'tech_grid',
  'nature_sunset',
  'data_lab',
] as const

export type DreambyteStudioEnvId = (typeof DREAMBYTE_STUDIO_ENV_IDS)[number]

export const DREAMBYTE_THREE_ENVIRONMENTS: DreambyteThreeEnvironmentMeta[] = [
  {
    id: 'studio_white',
    name: 'Studio white',
    description: 'White cyclorama + circular floor + soft hemisphere key/fill. Product, SaaS, corporate.',
    tags: ['studio', 'white', 'cyclorama', 'product', 'corporate'],
  },
  {
    id: 'cinematic_fog',
    name: 'Cinematic fog',
    description: 'Dark fogged backdrop, reflective floor, warm spot key + cool rim. Premium reveals, film.',
    tags: ['dark', 'cinematic', 'fog', 'dramatic', 'premium'],
  },
  {
    id: 'iso_playful',
    name: 'Playful pastel',
    description: 'Warm pastel background + hemisphere + sun-warm key. Tutorials, kids, casual.',
    tags: ['pastel', 'playful', 'tutorial', 'kids'],
  },
  {
    id: 'tech_grid',
    name: 'Tech grid',
    description: 'Cyan shader grid floor + magenta rim + starfield on deep blue. Cyberpunk, AI, data.',
    tags: ['cyberpunk', 'neon', 'grid', 'tech', 'data', 'ai'],
  },
  {
    id: 'nature_sunset',
    name: 'Nature sunset',
    description: 'Gradient sunset sky, green ground, warm sun. Wellness, environment.',
    tags: ['nature', 'sunset', 'outdoor', 'wellness'],
  },
  {
    id: 'data_lab',
    name: 'Data lab',
    description: 'White void + transparent shadow-catcher floor. Charts, infographics, minimal.',
    tags: ['data', 'white', 'shadow-catcher', 'chart', 'minimal'],
  },
  {
    id: 'track_rolling_topdown',
    name: 'Rolling track lanes',
    description: 'Top-down white surface, 4 lanes of rolling marbles. Diagrams, races.',
    tags: ['top-down', 'tracks', 'marbles', 'diagram'],
  },
]

/** Compact list for LLM system prompts */
export function formatThreeEnvironmentsForPrompt(): string {
  return DREAMBYTE_THREE_ENVIRONMENTS.map((e) => `- \`${e.id}\` — ${e.name}: ${e.description}`).join('\n')
}
