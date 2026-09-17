/**
 * Compact entity ids for agent-facing text.
 *
 * Full UUIDs are 36 characters and appear many times in every read-tool dump,
 * which burns tokens. Here we shorten each known id to the shortest prefix
 * (never below ID_PREFIX_FLOOR) that no other id in the same set shares, and
 * expand such prefixes back to full ids when the agent passes them into a tool.
 *
 * Invariant: shorten and expand must use the SAME id set. A prefix that is
 * unique among scenes alone can collide with a layer or clip id, so callers
 * build the set with collectIdUniverse over the whole world.
 */

/** Emitted prefixes are never shorter than this, and shorter refs never expand. */
export const ID_PREFIX_FLOOR = 8

/** Matches canonical 8-4-4-4-12 hex UUIDs anywhere in a string (global, any case). */
export const UUID_REGEX = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g

const WHOLE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function commonPrefixLength(a: string, b: string): number {
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++
  return i
}

/**
 * Map each id to its shortest prefix (>= ID_PREFIX_FLOOR chars) that is not a
 * prefix of any other id in the set.
 *
 * After sorting, the id sharing the longest prefix with any given id is always
 * one of its two neighbours, so one pass over adjacent pairs is enough:
 * O(n log n) for the sort plus O(n * idLength) for the comparisons.
 */
export function shortIdMap(ids: Iterable<string>): Map<string, string> {
  const sorted = [...new Set(ids)].sort()
  // shared[i] = common prefix length of sorted[i] and sorted[i + 1]
  const shared: number[] = []
  for (let i = 0; i + 1 < sorted.length; i++) shared.push(commonPrefixLength(sorted[i], sorted[i + 1]))

  const out = new Map<string, string>()
  sorted.forEach((id, i) => {
    const longestShared = Math.max(i > 0 ? shared[i - 1] : 0, i < shared.length ? shared[i] : 0)
    const len = Math.min(id.length, Math.max(ID_PREFIX_FLOOR, longestShared + 1))
    out.set(id, id.slice(0, len))
  })
  return out
}

function replaceKnownUuids(text: string, map: Map<string, string>): string {
  return text.replace(UUID_REGEX, (match) => map.get(match) ?? match)
}

/** Replace every UUID in `text` that belongs to `universe` with its short prefix. */
export function shortenIdsInText(text: string, universe: Iterable<string>): string {
  const map = shortIdMap(universe)
  return map.size === 0 ? text : replaceKnownUuids(text, map)
}

/** Thrown when an id prefix matches more than one id in the universe. */
export class AmbiguousIdError extends Error {
  readonly prefix: string
  readonly matchCount: number

  constructor(prefix: string, matchCount: number) {
    super(
      `Ambiguous id "${prefix}": it is the start of ${matchCount} different ids. ` +
        `Re-read the current ids and pass a longer prefix (or the full id).`,
    )
    this.name = 'AmbiguousIdError'
    this.prefix = prefix
    this.matchCount = matchCount
  }
}

/**
 * Resolve a possibly-shortened id against `universe`.
 * - exact member → returned as-is
 * - prefix of exactly one member → that member
 * - prefix of several members → throws AmbiguousIdError
 * - anything else (unknown, or shorter than the floor) → returned unchanged,
 *   so the calling tool reports its own not-found error.
 */
export function expandIdPrefix(ref: string, universe: Set<string>): string {
  if (universe.has(ref) || ref.length < ID_PREFIX_FLOOR) return ref
  let match: string | undefined
  let count = 0
  for (const id of universe) {
    if (id.startsWith(ref)) {
      match = id
      count++
    }
  }
  if (count > 1) throw new AmbiguousIdError(ref, count)
  return match ?? ref
}

type WithId = { id?: string | null }
type IdList = readonly WithId[] | null | undefined

/** Structural view of the parts of a world that carry agent-addressable ids. */
interface IdUniverseWorld {
  scenes?:
    | readonly (WithId & {
        aiLayers?: IdList
        textOverlays?: IdList
        svgObjects?: IdList
        interactions?: IdList
        chartLayers?: IdList
      })[]
    | null
  timeline?: {
    tracks?: readonly (WithId & { clips?: IdList })[] | null
    markers?: IdList
  } | null
  checkpoints?: IdList
}

/**
 * Every UUID-shaped id the agent can name: scenes and their layer collections
 * (AI layers, text overlays, SVG objects, interactions, charts), timeline
 * tracks, clips and markers, and named checkpoints. Non-UUID (legacy) ids are
 * left out so they are never shortened.
 */
export function collectIdUniverse(world: IdUniverseWorld): Set<string> {
  const ids = new Set<string>()
  const add = (item: WithId | null | undefined) => {
    const id = item?.id
    if (typeof id === 'string' && WHOLE_UUID.test(id)) ids.add(id)
  }
  const addAll = (list: IdList) => list?.forEach(add)

  for (const scene of world.scenes ?? []) {
    add(scene)
    addAll(scene.aiLayers)
    addAll(scene.textOverlays)
    addAll(scene.svgObjects)
    addAll(scene.interactions)
    addAll(scene.chartLayers)
  }
  for (const track of world.timeline?.tracks ?? []) {
    add(track)
    addAll(track.clips)
  }
  addAll(world.timeline?.markers)
  addAll(world.checkpoints)
  return ids
}

/**
 * Keys whose string values are code or markup that gets copied back verbatim
 * (e.g. via patch tools). A UUID inside them must never be shortened, or the
 * copied-back code would reference an id that doesn't exist. Pass as
 * `skipKeys` to shortenIdsDeep. Kept in sync with the type-checked list in
 * short-id.test.ts.
 */
export const CODE_BEARING_KEYS: ReadonlySet<string> = new Set([
  // Scene
  'svgContent',
  'canvasCode',
  'canvasBackgroundCode',
  'sceneCode',
  'reactCode',
  'sceneHTML',
  'sceneStyles',
  'lottieSource',
  // SceneLayer
  'generatedCode',
  // AI layers (content panel / avatar)
  'html',
  'script',
  // Published scene
  'htmlContent',
  // Reveal interaction
  'revealedContent',
  // Generic code/markup keys (embeds, tool payloads). Over-inclusive on purpose:
  // skipping a non-code field only forfeits id-shrinking; missing a code field corrupts it.
  'styles',
  'css',
  'code',
  'markup',
])

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * Return a copy of `value` with known UUIDs shortened inside every string,
 * recursing through arrays and plain objects. The input is not mutated.
 * Values under any key in `skipKeys` are carried over untouched; non-plain
 * objects (Date, Map, class instances) are carried over by reference.
 */
export function shortenIdsDeep<T>(value: T, universe: Iterable<string>, opts?: { skipKeys?: ReadonlySet<string> }): T {
  const map = shortIdMap(universe)
  if (map.size === 0) return value
  const skip = opts?.skipKeys

  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return replaceKnownUuids(v, map)
    if (Array.isArray(v)) return v.map(walk)
    if (!isPlainObject(v)) return v
    const out: Record<string, unknown> = {}
    for (const [k, child] of Object.entries(v)) out[k] = skip?.has(k) ? child : walk(child)
    return out
  }
  return walk(value) as T
}
