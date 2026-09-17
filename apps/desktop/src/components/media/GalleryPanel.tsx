'use client'

import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { useVideoStore } from '@/lib/store'
import type { ProjectAsset, AssetType } from '@/lib/types'
import {
  Paperclip,
  Folder,
  MoreVertical,
  Plus,
  X,
  Film,
  Image as ImageIcon,
  FileCode,
  ChevronLeft,
  Search,
  ListFilter,
} from 'lucide-react'
import { MenuSurface, MenuGroup, MenuRow } from '@/components/ui/MenuDropdown'
import { useViewportMenuPosition } from '@/components/ui/useViewportMenuPosition'
import { SfxLibraryPanel } from '@/components/audio/SfxLibraryPanel'
import { ZZFX_SFX_CATEGORIES } from '@/lib/audio/sfx-zzfx-presets'
import { addAssetToTimeline, ASSET_DRAG_MIME } from '@/lib/utils/add-asset-to-timeline'

// ── Bins are a UI-only convention on top of asset.tags ───────────────────────
// A tag like `bin:Heroes` puts the asset in the "Heroes" bin. This avoids a
// schema/IPC change while giving us bin-style folders.
const BIN_PREFIX = 'bin:'

const binNameFromTag = (tag: string) => (tag.startsWith(BIN_PREFIX) ? tag.slice(BIN_PREFIX.length) : null)
const tagForBin = (name: string) => `${BIN_PREFIX}${name.trim()}`

function deriveBins(assets: ProjectAsset[]): string[] {
  const set = new Set<string>()
  for (const a of assets) {
    for (const t of a.tags) {
      const n = binNameFromTag(t)
      if (n) set.add(n)
    }
  }
  return [...set].sort((a, b) => a.localeCompare(b))
}

type SortMode = 'newest' | 'oldest' | 'name' | 'size'

const TYPE_FILTERS: { value: AssetType | 'all'; label: string }[] = [
  { value: 'all', label: 'All types' },
  { value: 'image', label: 'Images' },
  { value: 'video', label: 'Videos' },
  { value: 'svg', label: 'SVG' },
]

const SORT_OPTIONS: { value: SortMode; label: string }[] = [
  { value: 'newest', label: 'Newest' },
  { value: 'oldest', label: 'Oldest' },
  { value: 'name', label: 'Name' },
  { value: 'size', label: 'Size' },
]

function AssetThumb({ asset }: { asset: ProjectAsset }) {
  const fallback =
    asset.type === 'video' ? (
      <Film size={20} />
    ) : asset.type === 'svg' ? (
      <FileCode size={20} />
    ) : (
      <ImageIcon size={20} />
    )
  if (!asset.thumbnailUrl) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-[var(--surface-cool)] text-[var(--mute)]">
        {fallback}
      </div>
    )
  }
  if (asset.type === 'svg') {
    return <img src={asset.thumbnailUrl} alt={asset.name} className="max-h-full max-w-full object-contain p-2" />
  }
  return <img src={asset.thumbnailUrl} alt={asset.name} className="h-full w-full object-cover" />
}

interface CardProps {
  asset: ProjectAsset
  onOpenMenu: (asset: ProjectAsset, x: number, y: number) => void
  onAddToTimeline: (asset: ProjectAsset) => void
}

function AssetCard({ asset, onOpenMenu, onAddToTimeline }: CardProps) {
  const handleDragStart = useCallback(
    (e: React.DragEvent) => {
      e.dataTransfer.effectAllowed = 'copy'
      e.dataTransfer.setData(ASSET_DRAG_MIME, JSON.stringify(asset))
      // Keep a fallback text payload so debugging in DevTools is easier — not used by the drop handler.
      e.dataTransfer.setData('text/plain', asset.name)
    },
    [asset],
  )

  return (
    // macOS Finder icon-view cell: thumbnail on top, name label below.
    <div
      draggable
      onDragStart={handleDragStart}
      onDoubleClick={() => onAddToTimeline(asset)}
      className="group flex cursor-grab flex-col items-center gap-1.5 active:cursor-grabbing"
      title={asset.prompt ? `"${asset.prompt.slice(0, 120)}"` : asset.name}
    >
      <div className="relative aspect-video w-full overflow-hidden rounded-[var(--radius-md)] bg-[var(--surface-cool)] ring-1 ring-[var(--hairline)] transition-shadow group-hover:ring-[var(--hairline-strong)]">
        <AssetThumb asset={asset} />

        {/* duration pill for videos */}
        {asset.type === 'video' && asset.durationSeconds != null && (
          <div className="absolute right-1.5 top-1.5 rounded bg-black/65 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-white/90">
            {Math.floor(asset.durationSeconds / 60)}:{String(Math.floor(asset.durationSeconds % 60)).padStart(2, '0')}
          </div>
        )}

        {/* menu affordance — top-left, opposite the duration pill */}
        <span
          className="pointer-events-auto absolute left-1.5 top-1.5 flex h-6 w-6 cursor-pointer items-center justify-center rounded-[var(--radius-sm)] bg-black/45 text-white/70 opacity-0 transition-opacity hover:bg-black/65 hover:text-white group-hover:opacity-100"
          onClick={(e) => {
            e.stopPropagation()
            onOpenMenu(asset, e.clientX, e.clientY)
          }}
        >
          <MoreVertical size={13} />
        </span>
      </div>

      <span className="line-clamp-2 w-full px-1 text-center text-[11.5px] leading-tight text-[var(--ink-soft)]">
        {asset.name}
      </span>
    </div>
  )
}

interface ContextMenuProps {
  asset: ProjectAsset
  x: number
  y: number
  bins: string[]
  onClose: () => void
  onRename: (asset: ProjectAsset) => void
  onDelete: (asset: ProjectAsset) => void
  onAddToBin: (asset: ProjectAsset, binName: string) => void
  onRemoveFromBin: (asset: ProjectAsset, binName: string) => void
  onRegenerate: (asset: ProjectAsset) => void
  onExtrude3D: (asset: ProjectAsset) => void
  onAddToTimeline: (asset: ProjectAsset) => void
}

function AssetContextMenu(props: ContextMenuProps) {
  const { asset, x, y, bins, onClose } = props
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [onClose])

  const { style: menuPosStyle, maxHeight: menuMaxHeight } = useViewportMenuPosition(x, y, ref)

  const assetBins = asset.tags.map(binNameFromTag).filter((n): n is string => n != null)

  return (
    <div ref={ref} className="fixed z-[1000]" style={menuPosStyle}>
      <MenuSurface className="min-w-[184px]" style={{ maxHeight: menuMaxHeight, overflowY: 'auto' }}>
        <MenuGroup>
          <MenuRow
            name="Add to timeline"
            onClick={() => {
              props.onAddToTimeline(asset)
              onClose()
            }}
          />
          <MenuRow
            name="Rename…"
            onClick={() => {
              props.onRename(asset)
              onClose()
            }}
          />
          {asset.source === 'generated' && (
            <MenuRow
              name="Regenerate"
              onClick={() => {
                props.onRegenerate(asset)
                onClose()
              }}
            />
          )}
          {asset.type === 'svg' && (
            <MenuRow
              name="Extrude to 3D scene"
              onClick={() => {
                props.onExtrude3D(asset)
                onClose()
              }}
            />
          )}
        </MenuGroup>
        <MenuGroup label="Bins" divider>
          {bins.length === 0 && <MenuRow name="No bins yet" muted onClick={onClose} />}
          {bins.map((b) => {
            const inBin = assetBins.includes(b)
            return (
              <MenuRow
                key={b}
                name={b}
                selected={inBin}
                onClick={() => {
                  if (inBin) props.onRemoveFromBin(asset, b)
                  else props.onAddToBin(asset, b)
                  onClose()
                }}
              />
            )
          })}
        </MenuGroup>
        <MenuGroup divider>
          <MenuRow
            name="Delete"
            destructive
            onClick={() => {
              props.onDelete(asset)
              onClose()
            }}
          />
        </MenuGroup>
      </MenuSurface>
    </div>
  )
}

export default function GalleryPanel() {
  const {
    project,
    projectAssets,
    assetsLoading,
    addProjectAsset,
    removeProjectAsset,
    updateProjectAsset,
    scenes,
    selectedSceneId,
    addSFXToScene,
  } = useVideoStore()
  // The bundled SFX library lives as a folder INSIDE the normal library grid:
  // `inSfx` = the user opened the SFX folder; `sfxCategory` = a category folder
  // within it.
  const [inSfx, setInSfx] = useState(false)
  const [sfxCategory, setSfxCategory] = useState<string | null>(null)
  const activeScene = useMemo(
    () => scenes.find((s) => s.id === selectedSceneId) ?? scenes[0] ?? null,
    [scenes, selectedSceneId],
  )
  const [typeFilter, setTypeFilter] = useState<AssetType | 'all'>('all')
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<SortMode>('newest')
  const [activeBin, setActiveBin] = useState<string | null>(null)
  const [filterOpen, setFilterOpen] = useState(false)
  const [uploading, setUploading] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [isDragOver, setIsDragOver] = useState(false)
  const [menu, setMenu] = useState<{ asset: ProjectAsset; x: number; y: number } | null>(null)
  const [newBinOpen, setNewBinOpen] = useState(false)
  const [newBinName, setNewBinName] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)

  const ipc = typeof window !== 'undefined' ? window.dreambyteApi?.projects : undefined

  const bins = useMemo(() => deriveBins(projectAssets), [projectAssets])

  const filteredAssets = useMemo(() => {
    // 'doc' assets are chat reference files (md/pdf/…), not composable media —
    // never surface them in the media library.
    let xs = projectAssets.filter((a) => a.type !== 'doc')
    if (typeFilter !== 'all') xs = xs.filter((a) => a.type === typeFilter)
    if (activeBin != null) xs = xs.filter((a) => a.tags.includes(tagForBin(activeBin)))
    const q = search.trim().toLowerCase()
    if (q) xs = xs.filter((a) => a.name.toLowerCase().includes(q) || (a.prompt ?? '').toLowerCase().includes(q))
    const ts = (v: ProjectAsset['createdAt']) => new Date(v as unknown as string | number | Date).getTime() || 0
    const sorted = [...xs]
    if (sort === 'newest') sorted.sort((a, b) => ts(b.createdAt) - ts(a.createdAt))
    else if (sort === 'oldest') sorted.sort((a, b) => ts(a.createdAt) - ts(b.createdAt))
    else if (sort === 'name') sorted.sort((a, b) => a.name.localeCompare(b.name))
    else if (sort === 'size') sorted.sort((a, b) => b.sizeBytes - a.sizeBytes)
    return sorted
  }, [projectAssets, typeFilter, activeBin, search, sort])

  const uploadFile = useCallback(
    async (file: File) => {
      setError(null)
      setUploading((n) => n + 1)
      try {
        if (!ipc?.uploadAsset) throw new Error('Asset upload requires the desktop runtime.')
        // Prefer streaming from disk (no IPC payload — large footage works);
        // fall back to bytes for path-less Files (e.g. pasted blobs).
        const filePath = ipc.getPathForFile?.(file) || ''
        const result = await ipc.uploadAsset({
          projectId: project.id,
          ...(filePath ? { filePath } : { data: await file.arrayBuffer() }),
          mimeType: file.type || 'application/octet-stream',
          originalName: file.name,
        })
        let asset = result.asset as unknown as ProjectAsset
        // Newly uploaded assets land in the currently-selected bin (if any)
        if (activeBin && !asset.tags.includes(tagForBin(activeBin))) {
          const tags = [...asset.tags, tagForBin(activeBin)]
          try {
            const patched = await ipc.patchAsset({ projectId: project.id, assetId: asset.id, tags })
            asset = patched.asset as unknown as ProjectAsset
          } catch {
            /* non-fatal */
          }
        }
        addProjectAsset(asset)
      } catch (e: any) {
        setError(e?.message ?? 'Upload failed')
      } finally {
        setUploading((n) => Math.max(0, n - 1))
      }
    },
    [project.id, addProjectAsset, ipc, activeBin],
  )

  const handleFiles = useCallback((files: FileList | File[]) => Array.from(files).forEach(uploadFile), [uploadFile])

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setIsDragOver(false)
      if (e.dataTransfer.files.length > 0) handleFiles(e.dataTransfer.files)
    },
    [handleFiles],
  )

  // ── Asset actions (rename / delete / regen / bins / extrude) ───────────────

  const patchAsset = useCallback(
    async (asset: ProjectAsset, patch: { name?: string; tags?: string[] }) => {
      if (!ipc) return
      try {
        const { asset: updated } = await ipc.patchAsset({
          projectId: project.id,
          assetId: asset.id,
          ...patch,
        })
        updateProjectAsset(asset.id, updated as unknown as ProjectAsset)
      } catch (e: any) {
        setError(e?.message ?? 'Update failed')
      }
    },
    [project.id, ipc, updateProjectAsset],
  )

  const handleRename = useCallback(
    (asset: ProjectAsset) => {
      const next = window.prompt('Rename asset', asset.name)
      if (next && next.trim() && next.trim() !== asset.name) patchAsset(asset, { name: next.trim() })
    },
    [patchAsset],
  )

  const handleDelete = useCallback(
    async (asset: ProjectAsset) => {
      if (!ipc) return
      if (!window.confirm(`Delete "${asset.name}"?`)) return
      try {
        await ipc.deleteAsset({ projectId: project.id, assetId: asset.id })
        removeProjectAsset(asset.id)
      } catch (e: any) {
        setError(e?.message ?? 'Delete failed')
      }
    },
    [project.id, ipc, removeProjectAsset],
  )

  const handleAddToBin = useCallback(
    (asset: ProjectAsset, binName: string) => {
      const tag = tagForBin(binName)
      if (asset.tags.includes(tag)) return
      patchAsset(asset, { tags: [...asset.tags, tag] })
    },
    [patchAsset],
  )

  const handleRemoveFromBin = useCallback(
    (asset: ProjectAsset, binName: string) => {
      const tag = tagForBin(binName)
      patchAsset(asset, { tags: asset.tags.filter((t) => t !== tag) })
    },
    [patchAsset],
  )

  const handleRegenerate = useCallback(
    async (asset: ProjectAsset) => {
      if (!ipc) return
      try {
        const { asset: newAsset } = await ipc.regenerateAsset({ projectId: project.id, assetId: asset.id })
        addProjectAsset(newAsset as unknown as ProjectAsset)
      } catch (e: any) {
        setError(e?.message ?? 'Regeneration failed')
      }
    },
    [project.id, ipc, addProjectAsset],
  )

  const handleExtrude3D = useCallback((asset: ProjectAsset) => {
    const store = useVideoStore.getState()
    const sceneId = store.addScene(`3D: ${asset.name}`)
    // publicUrl is absolute in the packaged app (dreambyte://uploads/... via
    // DREAMBYTE_UPLOADS_URL_BASE) but RELATIVE in dev (/uploads/...). Always prefixing
    // window.location.origin would double-prefix the packaged absolute URL into
    // `dreambyte://appdreambyte://...` (blank scene). Prefix ONLY when relative, so dev (needs the origin to reach the Next server)
    // and packaged (already absolute) both produce a fetchable URL.
    const svgUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(asset.publicUrl)
      ? asset.publicUrl
      : `${window.location.origin}${asset.publicUrl}`
    const sceneCode = buildExtrudeSceneCode(svgUrl)
    store.updateScene(sceneId, { sceneType: 'three', sceneCode, name: `3D: ${asset.name}` })
    store.selectScene(sceneId)
    store.saveSceneHTML(sceneId)
  }, [])

  const handleAddToTimeline = useCallback(async (asset: ProjectAsset) => {
    try {
      const r = await addAssetToTimeline(asset)
      if (!r.ok && r.error) setError(r.error)
    } catch (e: any) {
      setError(e?.message ?? 'Could not add asset to timeline')
    }
  }, [])

  const createBin = useCallback(() => {
    const name = newBinName.trim()
    if (!name) {
      setNewBinOpen(false)
      return
    }
    // An "empty" bin doesn't exist on its own — bins are derived from tags.
    // Switching to the bin makes new uploads land in it; otherwise we drop a
    // hidden placeholder tag onto the first asset so the bin appears in the list.
    if (!bins.includes(name) && projectAssets.length > 0) {
      patchAsset(projectAssets[0], { tags: [...projectAssets[0].tags, tagForBin(name)] })
    }
    setActiveBin(name)
    setNewBinName('')
    setNewBinOpen(false)
  }, [newBinName, bins, projectAssets, patchAsset])

  return (
    <div
      className="flex h-full flex-col bg-[var(--panel)]"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault()
          setIsDragOver(true)
        }
      }}
      onDragLeave={() => setIsDragOver(false)}
      onDrop={handleDrop}
    >
      {inSfx ? (
        // SFX is a folder INSIDE the normal library: open it to see the sorted
        // category folders, open a category to see its sounds.
        !activeScene ? (
          <div className="flex flex-1 items-center justify-center px-6 text-center text-[12px] text-[var(--mute)]">
            Select or create a scene to add sound effects.
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            {/* Breadcrumb: All media / SFX [/ Category] */}
            <div className="flex items-center gap-1.5 px-5 py-2 text-[12px]">
              <span
                onClick={() => {
                  setInSfx(false)
                  setSfxCategory(null)
                }}
                className="flex cursor-pointer items-center gap-0.5 text-[var(--graphite)] hover:text-[var(--ink)]"
              >
                <ChevronLeft size={12} /> All media
              </span>
              <span className="text-[var(--mute)]">/</span>
              {sfxCategory ? (
                <>
                  <span
                    onClick={() => setSfxCategory(null)}
                    className="cursor-pointer font-medium text-[var(--graphite)] hover:text-[var(--ink)]"
                  >
                    SFX
                  </span>
                  <span className="text-[var(--mute)]">/</span>
                  <span className="flex items-center gap-1 font-medium text-[var(--ink)]">
                    <Folder size={12} /> {ZZFX_SFX_CATEGORIES.find((c) => c.id === sfxCategory)?.label ?? sfxCategory}
                  </span>
                </>
              ) : (
                <span className="flex items-center gap-1 font-medium text-[var(--ink)]">
                  <Folder size={12} /> SFX
                </span>
              )}
            </div>
            {sfxCategory ? (
              <div className="min-h-0 flex-1">
                <SfxLibraryPanel
                  lockedCategory={sfxCategory}
                  onSelect={(r, at) =>
                    addSFXToScene(activeScene.id, {
                      id: r.id,
                      name: r.name,
                      provider: (r.provider ?? 'freesound') as never,
                      src: r.previewUrl ?? r.audioUrl ?? '',
                      triggerAt: at,
                      volume: 1,
                      duration: r.duration ?? null,
                      license: r.license ?? null,
                    })
                  }
                />
              </div>
            ) : (
              // Category folders inside the SFX folder.
              <div className="relative flex-1 overflow-y-auto px-5 py-4">
                <div className="mx-auto grid w-full max-w-[1400px] grid-cols-[repeat(auto-fill,minmax(172px,1fr))] gap-3">
                  {ZZFX_SFX_CATEGORIES.map((c) => (
                    <BinTile key={c.id} name={c.label} count={c.presets.length} onOpen={() => setSfxCategory(c.id)} />
                  ))}
                </div>
              </div>
            )}
          </div>
        )
      ) : (
        <>
          {/* ── Minimal toolbar: search line · filter+sort menu · upload ──────── */}
          <div className="flex items-center gap-3 px-5 py-3">
            {/* Search — just a line you write on */}
            <div className="flex min-w-0 max-w-[260px] flex-1 items-center gap-2 border-b border-[var(--hairline-strong)] pb-1 transition-colors focus-within:border-[var(--accent)]">
              <Search size={13} className="shrink-0 text-[var(--mute)]" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search"
                className="min-w-0 flex-1 bg-transparent text-[12.5px] text-[var(--ink)] outline-none placeholder:text-[var(--mute)]"
              />
            </div>

            <div className="flex-1" />

            {/* Active filter pill — clears back to All */}
            {typeFilter !== 'all' && (
              <span className="inline-flex items-center gap-1 rounded-[var(--radius-pill)] border border-[var(--hairline-strong)] bg-[var(--card)] py-1 pl-2.5 pr-1 text-[12px] text-[var(--ink)]">
                {TYPE_FILTERS.find((f) => f.value === typeFilter)?.label}
                <button
                  onClick={() => setTypeFilter('all')}
                  className="no-style grid h-4 w-4 place-items-center rounded-full text-[var(--graphite)] transition-colors hover:text-[var(--ink)]"
                  aria-label="Clear filter"
                >
                  <X size={12} />
                </button>
              </span>
            )}

            {/* Filter + sort — one menu (type filters and sort order together) */}
            <div className="relative">
              <button
                onClick={() => setFilterOpen((o) => !o)}
                className={`no-style grid h-8 w-8 place-items-center rounded-[var(--radius-md)] transition-colors hover:bg-[var(--card)] hover:text-[var(--ink)] ${
                  typeFilter !== 'all' || filterOpen ? 'text-[var(--ink)]' : 'text-[var(--graphite)]'
                }`}
                title="Filter and sort"
                aria-label="Filter and sort"
              >
                <ListFilter size={16} />
              </button>
              {filterOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setFilterOpen(false)} aria-hidden="true" />
                  <MenuSurface className="absolute right-0 top-full z-50 mt-1 min-w-[160px]">
                    <MenuGroup label="Type">
                      {TYPE_FILTERS.map((f) => (
                        <MenuRow
                          key={f.value}
                          name={f.label}
                          selected={typeFilter === f.value}
                          onClick={() => setTypeFilter(f.value)}
                        />
                      ))}
                    </MenuGroup>
                    <MenuGroup label="Sort" divider>
                      {SORT_OPTIONS.map((s) => (
                        <MenuRow
                          key={s.value}
                          name={s.label}
                          selected={sort === s.value}
                          onClick={() => setSort(s.value)}
                        />
                      ))}
                    </MenuGroup>
                  </MenuSurface>
                </>
              )}
            </div>

            {/* Upload — paperclip only */}
            <span
              onClick={() => fileInputRef.current?.click()}
              className="no-style grid h-8 w-8 cursor-pointer place-items-center rounded-[var(--radius-md)] text-[var(--graphite)] transition-colors hover:bg-[var(--card)] hover:text-[var(--ink)]"
              data-tooltip="Upload"
              data-tooltip-pos="bottom"
            >
              <Paperclip size={15} />
            </span>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/jpeg,image/png,image/webp,image/gif,image/svg+xml,video/mp4,video/quicktime,video/webm,audio/mpeg,audio/wav,audio/mp4,audio/aac,audio/ogg,audio/flac,.mp3,.wav,.m4a,.aac,.ogg,.flac"
              className="hidden"
              onChange={(e) => {
                if (e.target.files) handleFiles(e.target.files)
                e.target.value = ''
              }}
            />
          </div>

          {/* ── Breadcrumb (only shown when inside a bin) ────────────────────── */}
          {activeBin != null && (
            <div className="flex items-center gap-1.5 px-5 py-2 text-[12px]">
              <span
                onClick={() => setActiveBin(null)}
                className="flex cursor-pointer items-center gap-0.5 text-[var(--graphite)] hover:text-[var(--ink)]"
              >
                <ChevronLeft size={12} /> All media
              </span>
              <span className="text-[var(--mute)]">/</span>
              <span className="flex items-center gap-1 font-medium text-[var(--ink)]">
                <Folder size={12} /> {activeBin}
              </span>
            </div>
          )}

          {error && (
            <div className="mx-5 mt-3 flex items-center gap-2 rounded-[var(--radius-md)] border border-[var(--danger)]/30 bg-[var(--danger)]/10 px-2.5 py-1.5 text-[12px] text-[var(--danger)]">
              <span className="flex-1">{error}</span>
              <span onClick={() => setError(null)} className="cursor-pointer">
                <X size={12} />
              </span>
            </div>
          )}

          {uploading > 0 && (
            <div className="px-5 pt-3 text-[12px] text-[var(--graphite)]">
              Uploading {uploading} file{uploading === 1 ? '' : 's'}…
            </div>
          )}

          {/* ── Gallery grid ─────────────────────────────────────────────────── */}
          <div className="relative flex-1 overflow-y-auto px-5 py-4">
            {assetsLoading ? (
              <div className="animate-pulse py-12 text-center text-[12.5px] text-[var(--mute)]">Loading…</div>
            ) : (
              <div className="mx-auto grid w-full max-w-[1400px] grid-cols-[repeat(auto-fill,minmax(172px,1fr))] gap-3">
                {/* "+ New bin" cell is always first in the top-level "All" view */}
                {activeBin == null &&
                  (newBinOpen ? (
                    <div className="flex flex-col items-center gap-1.5">
                      <div className="grid aspect-video w-full place-items-center rounded-[var(--radius-md)] border border-dashed border-[var(--accent)] bg-[var(--accent-soft)]">
                        <Folder size={34} strokeWidth={1.25} className="text-[var(--accent)]" />
                      </div>
                      <input
                        autoFocus
                        value={newBinName}
                        onChange={(e) => setNewBinName(e.target.value)}
                        onBlur={createBin}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') createBin()
                          if (e.key === 'Escape') {
                            setNewBinName('')
                            setNewBinOpen(false)
                          }
                        }}
                        placeholder="Bin name"
                        className="w-full rounded-[var(--radius-sm)] border border-[var(--border-input)] bg-[var(--input-bg)] px-2 py-1 text-center text-[12px] text-[var(--ink)] outline-none focus:border-[var(--accent)]"
                      />
                    </div>
                  ) : (
                    <button
                      onClick={() => setNewBinOpen(true)}
                      className="no-style group flex cursor-pointer flex-col items-center gap-1.5"
                    >
                      <div className="grid aspect-video w-full place-items-center rounded-[var(--radius-md)] border border-dashed border-[var(--hairline-strong)] text-[var(--mute)] transition-colors group-hover:border-[var(--graphite)] group-hover:text-[var(--ink)]">
                        <Plus size={20} />
                      </div>
                      <span className="text-[11.5px] text-[var(--mute)] transition-colors group-hover:text-[var(--ink)]">
                        New bin
                      </span>
                    </button>
                  ))}
                {activeBin == null &&
                  bins.map((b) => (
                    <BinTile
                      key={b}
                      name={b}
                      count={projectAssets.filter((a) => a.tags.includes(tagForBin(b))).length}
                      onOpen={() => setActiveBin(b)}
                      onDropAsset={(asset) => handleAddToBin(asset, b)}
                    />
                  ))}
                {/* Bundled SFX library — a built-in folder of sorted sound categories */}
                {activeBin == null && (
                  <BinTile
                    name="SFX"
                    count={ZZFX_SFX_CATEGORIES.reduce((n, c) => n + c.presets.length, 0)}
                    onOpen={() => setInSfx(true)}
                  />
                )}
                {filteredAssets.map((asset) => (
                  <AssetCard
                    key={asset.id}
                    asset={asset}
                    onOpenMenu={(a, x, y) => setMenu({ asset: a, x, y })}
                    onAddToTimeline={handleAddToTimeline}
                  />
                ))}
                {filteredAssets.length === 0 && bins.length === 0 && activeBin == null && (
                  <div className="col-span-full flex flex-col items-center gap-1 py-16 text-center">
                    <p className="text-[13px] text-[var(--graphite)]">No media yet</p>
                    <p className="text-[12px] text-[var(--mute)]">Drag files in, or use Upload above.</p>
                  </div>
                )}
                {filteredAssets.length === 0 && activeBin != null && (
                  <div className="col-span-full py-16 text-center text-[12.5px] text-[var(--mute)]">Empty bin.</div>
                )}
              </div>
            )}

            {/* Drag feedback: a soft solid-accent ring around the panel — no
              dashed box. The library has no insertion position, so a subtle
              highlight is enough to signal it accepts the drop. */}
            {isDragOver && (
              <div className="pointer-events-none absolute inset-0 z-10 rounded-[var(--radius-lg)] ring-2 ring-inset ring-[var(--accent)]" />
            )}
          </div>

          {menu && (
            <AssetContextMenu
              asset={menu.asset}
              x={menu.x}
              y={menu.y}
              bins={bins}
              onClose={() => setMenu(null)}
              onRename={handleRename}
              onDelete={handleDelete}
              onAddToBin={handleAddToBin}
              onRemoveFromBin={handleRemoveFromBin}
              onRegenerate={handleRegenerate}
              onExtrude3D={handleExtrude3D}
              onAddToTimeline={handleAddToTimeline}
            />
          )}
        </>
      )}
    </div>
  )
}

function BinTile({
  name,
  count,
  onOpen,
  onDropAsset,
}: {
  name: string
  count: number
  onOpen: () => void
  /** Optional — media bins accept asset drops; SFX category bins don't. */
  onDropAsset?: (asset: ProjectAsset) => void
}) {
  const [isOver, setIsOver] = useState(false)

  const handleDragOver = (e: React.DragEvent) => {
    if (!onDropAsset || !e.dataTransfer.types.includes(ASSET_DRAG_MIME)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setIsOver(true)
  }
  const handleDragLeave = () => setIsOver(false)
  const handleDrop = (e: React.DragEvent) => {
    if (!onDropAsset || !e.dataTransfer.types.includes(ASSET_DRAG_MIME)) return
    e.preventDefault()
    e.stopPropagation()
    setIsOver(false)
    try {
      const payload = e.dataTransfer.getData(ASSET_DRAG_MIME)
      if (!payload) return
      const asset = JSON.parse(payload) as ProjectAsset
      onDropAsset(asset)
    } catch {
      /* ignore malformed payload */
    }
  }

  return (
    // macOS Finder folder: a folder glyph on top, name label below.
    <div
      onClick={onOpen}
      onDoubleClick={onOpen}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className="group flex cursor-pointer flex-col items-center gap-1.5"
      title={`Open bin: ${name}`}
    >
      <div
        className={`relative grid aspect-video w-full place-items-center rounded-[var(--radius-md)] transition-colors ${
          isOver ? 'bg-[var(--accent-soft)] ring-1 ring-[var(--accent)]' : 'group-hover:bg-[var(--card)]'
        }`}
      >
        <Folder
          size={40}
          strokeWidth={1.25}
          className={isOver ? 'text-[var(--accent)]' : 'text-[var(--graphite)] group-hover:text-[var(--ink)]'}
        />
        <span className="absolute right-1.5 top-1.5 rounded-[var(--radius-sm)] bg-[var(--surface-cool)] px-1.5 py-0.5 text-[10px] text-[var(--graphite)]">
          {count}
        </span>
      </div>
      <span className="line-clamp-2 w-full px-1 text-center text-[11.5px] font-medium leading-tight text-[var(--ink-soft)]">
        {name}
      </span>
    </div>
  )
}

// ── Extrusion template kept verbatim from the prior implementation ───────────
function buildExtrudeSceneCode(svgUrl: string): string {
  return `import * as THREE from 'three';
import { SVGLoader } from 'three/addons/loaders/SVGLoader.js';

const { WIDTH, HEIGHT, PALETTE, DURATION, MATERIALS, mulberry32, setupEnvironment } = window;

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setSize(WIDTH, HEIGHT);
renderer.setClearColor(PALETTE[3] || '#1a1a2e');
renderer.shadowMap.enabled = true;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.2;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, WIDTH / HEIGHT, 0.1, 1000);
camera.position.set(0, 0, 8);

window.THREE = THREE;
window.scene = scene;
window.camera = camera;
window.renderer = renderer;

setupEnvironment(scene, renderer);

scene.add(new THREE.AmbientLight(0xffffff, 0.4));
const key = new THREE.DirectionalLight(0xffffff, 1.5);
key.position.set(5, 8, 5);
key.castShadow = true;
key.shadow.mapSize.set(1024, 1024);
scene.add(key);
const fill = new THREE.DirectionalLight(0xffffff, 0.4);
fill.position.set(-4, 3, -2);
scene.add(fill);
scene.add(Object.assign(new THREE.DirectionalLight(0xffffff, 0.6), {})).position.set(0, -2, -5);

const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(30, 30),
  new THREE.MeshStandardMaterial({ color: PALETTE[3] || '#1a1a2e', roughness: 0.3, metalness: 0.6 })
);
floor.rotation.x = -Math.PI / 2;
floor.position.y = -3.5;
floor.receiveShadow = true;
scene.add(floor);

const pivot = new THREE.Group();
scene.add(pivot);

fetch('${svgUrl}').then(r => r.text()).then(text => {
  const inner = new THREE.Group();
  const data = new SVGLoader().parse(text);
  let i = 0;
  for (const path of data.paths) {
    const shapes = SVGLoader.createShapes(path);
    for (const shape of shapes) {
      const geo = new THREE.ExtrudeGeometry(shape, {
        depth: 20, bevelEnabled: true, bevelThickness: 2, bevelSize: 1.5,
        bevelSegments: 8, curveSegments: 24
      });
      const mat = new THREE.MeshPhysicalMaterial({
        color: PALETTE[i % PALETTE.length],
        metalness: 0.75, roughness: 0.15,
        clearcoat: 0.4, clearcoatRoughness: 0.1, envMapIntensity: 1.5,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      inner.add(mesh);
      i++;
    }
  }
  const box = new THREE.Box3().setFromObject(inner);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  inner.position.set(-center.x, -center.y, -center.z);
  const maxDim = Math.max(size.x, size.y, size.z);
  const s = 4 / maxDim;
  pivot.scale.set(s, -s, s);
  pivot.add(inner);
}).catch((err) => {
  console.error('[extrude-3d] failed to load SVG:', '${svgUrl}', err);
});

const state = { t: 0 };
window.__tl.add(state, {
  t: [0, DURATION],
  duration: DURATION,
  ease: 'linear',
  onUpdate() {
    const elapsed = state.t;
    pivot.rotation.y = elapsed * 0.3;
    renderer.render(scene, camera);
  }
}, 0);
`
}
