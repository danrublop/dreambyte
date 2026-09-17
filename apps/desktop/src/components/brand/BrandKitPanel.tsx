'use client'

import { useState } from 'react'
import { Plus, X, Wand2, Check } from 'lucide-react'
import { useVideoStore } from '@/lib/store'
import type { BrandKit, ProjectAsset } from '@/lib/types/media'
import FontPicker from '@/components/FontPicker'

const DEFAULT_KIT: BrandKit = {
  brandName: null,
  logoAssetIds: [],
  palette: [],
  fontPrimary: null,
  fontSecondary: null,
  guidelines: null,
}

function ColorSwatch({
  color,
  onRemove,
  onChange,
}: {
  color: string
  onRemove: () => void
  onChange: (c: string) => void
}) {
  return (
    <div className="relative group">
      <input
        type="color"
        value={color}
        onChange={(e) => onChange(e.target.value)}
        className="w-7 h-7 rounded-md border border-white/10 cursor-pointer p-0 block"
        style={{ background: color }}
      />
      <span
        onClick={onRemove}
        className="absolute -top-1 -right-1 w-3.5 h-3.5 rounded-full bg-red-500 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 cursor-pointer transition-opacity"
        style={{ fontSize: 8, lineHeight: 1 }}
      >
        <X size={8} />
      </span>
    </div>
  )
}

function LogoTile({ asset, onRemove }: { asset: ProjectAsset; onRemove: () => void }) {
  return (
    <div className="relative group w-14 h-14 rounded-lg border border-white/10 overflow-hidden bg-white/5 flex items-center justify-center">
      <img
        src={asset.thumbnailUrl || asset.publicUrl}
        alt={asset.name}
        className="max-w-full max-h-full object-contain"
      />
      <span
        onClick={onRemove}
        className="absolute top-0.5 right-0.5 w-4 h-4 rounded-full bg-red-500/80 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 cursor-pointer transition-opacity"
      >
        <X size={9} />
      </span>
      {asset.extractedColors.length > 0 && (
        <div className="absolute bottom-0 left-0 right-0 flex gap-px">
          {asset.extractedColors.slice(0, 4).map((c, i) => (
            <div key={i} className="flex-1 h-1.5" style={{ background: c }} />
          ))}
        </div>
      )}
    </div>
  )
}

export default function BrandKitPanel() {
  const brandKit = useVideoStore((s) => s.brandKit) ?? DEFAULT_KIT
  const updateBrandKit = useVideoStore((s) => s.updateBrandKit)
  const applyBrandToStyle = useVideoStore((s) => s.applyBrandToStyle)
  const projectAssets = useVideoStore((s) => s.projectAssets)
  const [showAssetPicker, setShowAssetPicker] = useState(false)

  const logoAssets = brandKit.logoAssetIds
    .map((id) => projectAssets.find((a) => a.id === id))
    .filter(Boolean) as ProjectAsset[]

  const eligibleAssets = projectAssets.filter(
    (a) => (a.type === 'svg' || a.type === 'image') && !brandKit.logoAssetIds.includes(a.id),
  )

  const addLogo = (assetId: string) => {
    updateBrandKit({ logoAssetIds: [...brandKit.logoAssetIds, assetId] })
    setShowAssetPicker(false)
  }

  const removeLogo = (assetId: string) => {
    updateBrandKit({ logoAssetIds: brandKit.logoAssetIds.filter((id) => id !== assetId) })
  }

  const pullColorsFromLogos = () => {
    const allColors: string[] = []
    for (const asset of logoAssets) {
      for (const c of asset.extractedColors) {
        if (!allColors.includes(c)) allColors.push(c)
      }
    }
    updateBrandKit({ palette: allColors.slice(0, 8) })
  }

  const updatePaletteColor = (idx: number, color: string) => {
    const next = [...brandKit.palette]
    next[idx] = color
    updateBrandKit({ palette: next })
  }

  const removePaletteColor = (idx: number) => {
    updateBrandKit({ palette: brandKit.palette.filter((_, i) => i !== idx) })
  }

  const addPaletteColor = () => {
    if (brandKit.palette.length < 8) {
      updateBrandKit({ palette: [...brandKit.palette, '#888888'] })
    }
  }

  return (
    <div className="space-y-3 px-3 py-2">
      {/* Brand Name */}
      <div>
        <label className="text-[#6b6b7a] text-[10px] uppercase tracking-wider block mb-1">Brand Name</label>
        <input
          type="text"
          value={brandKit.brandName ?? ''}
          onChange={(e) => updateBrandKit({ brandName: e.target.value || null })}
          placeholder="My Brand"
          className="w-full px-2 py-1.5 rounded-md bg-white/5 border border-white/10 text-[12px] text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)]"
        />
      </div>

      {/* Logos */}
      <div>
        <label className="text-[#6b6b7a] text-[10px] uppercase tracking-wider block mb-1">Logos</label>
        <div className="flex flex-wrap gap-2">
          {logoAssets.map((asset) => (
            <LogoTile key={asset.id} asset={asset} onRemove={() => removeLogo(asset.id)} />
          ))}
          <span
            onClick={() => setShowAssetPicker(!showAssetPicker)}
            className="w-14 h-14 rounded-lg border border-dashed border-white/20 flex items-center justify-center cursor-pointer hover:border-white/40 transition-colors"
          >
            <Plus size={16} className="text-[var(--color-text-muted)]" />
          </span>
        </div>

        {showAssetPicker && (
          <div className="mt-2 max-h-32 overflow-y-auto rounded-md border border-white/10 bg-[var(--color-bg-secondary)]">
            {eligibleAssets.length === 0 ? (
              <div className="px-3 py-2 text-[11px] text-[var(--color-text-muted)]">
                No SVG or image assets. Upload in Media Library first.
              </div>
            ) : (
              eligibleAssets.map((a) => (
                <div
                  key={a.id}
                  onClick={() => addLogo(a.id)}
                  className="flex items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-white/5 transition-colors"
                >
                  <img src={a.thumbnailUrl || a.publicUrl} className="w-6 h-6 object-contain rounded" alt="" />
                  <span className="text-[11px] text-[var(--color-text-primary)] truncate">{a.name}</span>
                  <span className="text-[9px] text-[var(--color-text-muted)] ml-auto uppercase">{a.type}</span>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* Palette */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <label className="text-[#6b6b7a] text-[10px] uppercase tracking-wider">Palette</label>
          {logoAssets.some((a) => a.extractedColors.length > 0) && (
            <span
              onClick={pullColorsFromLogos}
              className="text-[10px] text-[#c678dd] cursor-pointer hover:underline flex items-center gap-1"
            >
              <Wand2 size={10} /> Pull from logos
            </span>
          )}
        </div>
        <div className="flex flex-wrap gap-1.5 items-center">
          {brandKit.palette.map((color, i) => (
            <ColorSwatch
              key={i}
              color={color}
              onChange={(c) => updatePaletteColor(i, c)}
              onRemove={() => removePaletteColor(i)}
            />
          ))}
          {brandKit.palette.length < 8 && (
            <span
              onClick={addPaletteColor}
              className="w-7 h-7 rounded-md border border-dashed border-white/20 flex items-center justify-center cursor-pointer hover:border-white/40"
            >
              <Plus size={12} className="text-[var(--color-text-muted)]" />
            </span>
          )}
        </div>
      </div>

      {/* Fonts */}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-[#6b6b7a] text-[10px] uppercase tracking-wider block mb-1">Primary Font</label>
          <FontPicker
            value={brandKit.fontPrimary}
            presetFont={null}
            onChange={(f) => updateBrandKit({ fontPrimary: f })}
          />
        </div>
        <div>
          <label className="text-[#6b6b7a] text-[10px] uppercase tracking-wider block mb-1">Secondary Font</label>
          <FontPicker
            value={brandKit.fontSecondary}
            presetFont={null}
            onChange={(f) => updateBrandKit({ fontSecondary: f })}
          />
        </div>
      </div>

      {/* Guidelines */}
      <div>
        <label className="text-[#6b6b7a] text-[10px] uppercase tracking-wider block mb-1">Brand Guidelines</label>
        <textarea
          value={brandKit.guidelines ?? ''}
          onChange={(e) => updateBrandKit({ guidelines: e.target.value || null })}
          placeholder="Notes for the AI agent (tone, dos/don'ts, etc.)"
          rows={2}
          className="w-full px-2 py-1.5 rounded-md bg-white/5 border border-white/10 text-[11px] text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] resize-none"
        />
      </div>

      {/* Apply Button */}
      <span
        onClick={applyBrandToStyle}
        className="flex items-center justify-center gap-1.5 w-full py-1.5 rounded-md text-[11px] font-medium cursor-pointer transition-colors"
        style={{ background: '#c678dd20', color: '#c678dd' }}
      >
        <Check size={12} /> Apply to Project Style
      </span>
    </div>
  )
}
