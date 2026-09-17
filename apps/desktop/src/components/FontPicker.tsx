'use client'

import { useState, useRef, useEffect } from 'react'
import { ChevronDown, Star, Search } from 'lucide-react'
import { FONT_CATALOG, CATEGORY_LABELS, type FontCategory } from '@/lib/fonts/catalog'
import { useVideoStore } from '@/lib/store'

const CATEGORY_ORDER: FontCategory[] = ['sans-serif', 'serif', 'handwritten', 'monospace', 'display', 'system']

interface Props {
  value: string | null // current fontOverride (null = preset default)
  presetFont: string | null // font from the active preset (null = no preset active)
  onChange: (family: string | null) => void
  /** Omit the “Default (preset)” row (e.g. Settings → General UI font). */
  hidePresetOption?: boolean
  /** Hide the small “(override)” label next to the current family. */
  hideOverrideHint?: boolean
}

export default function FontPicker({ value, presetFont, onChange, hidePresetOption, hideOverrideHint }: Props) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  const { favoriteFonts, toggleFavoriteFont } = useVideoStore()

  const activeFont = value ?? presetFont ?? 'Nunito'

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const filtered = search.trim()
    ? FONT_CATALOG.filter((f) => f.family.toLowerCase().includes(search.toLowerCase()))
    : FONT_CATALOG

  const favorites = filtered.filter((f) => favoriteFonts.includes(f.family))

  return (
    <div className="relative" ref={ref}>
      {/* Trigger */}
      <div className="flex items-center justify-between">
        <span className="text-[var(--color-text-muted)] text-[11px] uppercase tracking-wider">Font</span>
        <span
          onClick={() => setOpen(!open)}
          className="inline-flex items-center gap-1 cursor-pointer text-sm text-[var(--color-text-primary)] hover:text-[var(--color-accent)] transition-colors"
          style={{ fontFamily: `'${activeFont}', sans-serif` }}
        >
          {activeFont}
          {value && !hideOverrideHint && (
            <span className="text-[8px] text-[var(--color-text-muted)] ml-0.5">(override)</span>
          )}
          <ChevronDown
            size={11}
            className={`text-[var(--color-text-muted)] transition-transform ${open ? 'rotate-180' : ''}`}
          />
        </span>
      </div>

      {/* Dropdown */}
      {open && (
        <div
          className="absolute left-0 right-0 top-[calc(100%+4px)] z-50 rounded-lg shadow-xl overflow-hidden"
          style={{
            background: 'var(--color-panel)',
            border: '1px solid var(--color-border)',
            maxHeight: 380,
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          {/* Search */}
          <div
            className="flex items-center gap-1.5 px-2.5 py-2 border-b"
            style={{ borderColor: 'var(--color-border)' }}
          >
            <Search size={12} className="text-[var(--color-text-muted)] flex-shrink-0" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search fonts..."
              autoFocus
              className="flex-1 bg-transparent text-sm text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-muted)]"
            />
          </div>

          {/* Scrollable list */}
          <div className="overflow-y-auto flex-1" style={{ maxHeight: 340 }}>
            {/* Default (preset) option */}
            {!hidePresetOption && (
              <FontRow
                family={presetFont ?? 'Nunito'}
                label={presetFont ? `Default (${presetFont})` : 'Default'}
                isActive={value === null}
                isFavorite={false}
                onSelect={() => {
                  onChange(null)
                  setOpen(false)
                }}
              />
            )}

            {/* Favorites section */}
            {favorites.length > 0 && (
              <>
                <div className="px-2.5 pt-2 pb-1">
                  <span className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)] flex items-center gap-1">
                    <Star size={9} className="fill-amber-400 text-amber-400" /> Favorites
                  </span>
                </div>
                {favorites.map((f) => (
                  <FontRow
                    key={`fav-${f.id}`}
                    family={f.family}
                    isActive={activeFont === f.family}
                    isFavorite={true}
                    onSelect={() => {
                      onChange(f.family)
                      setOpen(false)
                    }}
                    onToggleFavorite={() => toggleFavoriteFont(f.family)}
                  />
                ))}
              </>
            )}

            {/* Categories */}
            {CATEGORY_ORDER.map((cat) => {
              const fonts = filtered.filter((f) => f.category === cat)
              if (fonts.length === 0) return null
              return (
                <div key={cat}>
                  <div className="px-2.5 pt-2 pb-1">
                    <span className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
                      {CATEGORY_LABELS[cat]}
                    </span>
                  </div>
                  {fonts.map((f) => (
                    <FontRow
                      key={f.id}
                      family={f.family}
                      isActive={activeFont === f.family}
                      isFavorite={favoriteFonts.includes(f.family)}
                      onSelect={() => {
                        onChange(f.family)
                        setOpen(false)
                      }}
                      onToggleFavorite={() => toggleFavoriteFont(f.family)}
                    />
                  ))}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

function FontRow({
  family,
  label,
  isActive,
  isFavorite,
  onSelect,
  onToggleFavorite,
}: {
  family: string
  label?: string
  isActive: boolean
  isFavorite: boolean
  onSelect: () => void
  onToggleFavorite?: () => void
}) {
  return (
    <div
      className="flex items-center gap-1 hover:bg-white/10 transition-colors group"
      style={{
        padding: '5px 10px',
        cursor: 'pointer',
        color: isActive ? 'var(--color-accent)' : 'var(--color-text-primary)',
      }}
    >
      <span
        onClick={onSelect}
        className="flex-1 truncate"
        style={{ fontFamily: `'${family}', sans-serif`, fontSize: 12 }}
      >
        {label ?? family}
      </span>
      {onToggleFavorite && (
        <span
          onClick={(e) => {
            e.stopPropagation()
            onToggleFavorite()
          }}
          className="flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
          style={{ opacity: isFavorite ? 1 : undefined }}
        >
          <Star size={11} className={isFavorite ? 'fill-amber-400 text-amber-400' : 'text-[var(--color-text-muted)]'} />
        </span>
      )}
    </div>
  )
}
