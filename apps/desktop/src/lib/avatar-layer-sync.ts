import type { AvatarLayer, NarrationScript } from './types'

export function defaultNarrationScript(over?: Partial<NarrationScript>): NarrationScript {
  return {
    mood: 'happy',
    view: 'upper',
    lipsyncHeadMovement: true,
    eyeContact: 0.7,
    position: 'pip_bottom_right',
    pipSize: 280,
    pipShape: 'circle',
    avatarScale: 1.15,
    containerEnabled: true,
    lines: [{ text: 'Hello.' }],
    ...over,
  }
}

/** Merge avatar layer updates, and deep-merge `narrationScript`. */
export function mergeAvatarLayerUpdates(prev: AvatarLayer, updates: Partial<AvatarLayer>): Partial<AvatarLayer> {
  const out: Partial<AvatarLayer> = { ...updates }

  if (updates.avatarSceneConfig && prev.avatarSceneConfig) {
    const asc = prev.avatarSceneConfig
    const u = updates.avatarSceneConfig
    out.avatarSceneConfig = {
      ...asc,
      ...u,
      contentPanels: u.contentPanels ?? asc.contentPanels,
      narrationScript: u.narrationScript
        ? { ...asc.narrationScript, ...u.narrationScript, lines: u.narrationScript.lines ?? asc.narrationScript.lines }
        : asc.narrationScript,
    }
  } else if (updates.avatarSceneConfig && !prev.avatarSceneConfig) {
    out.avatarSceneConfig = updates.avatarSceneConfig
  }

  if (updates.narrationScript) {
    const base = prev.narrationScript ?? defaultNarrationScript()
    out.narrationScript = {
      ...base,
      ...updates.narrationScript,
      lines: updates.narrationScript.lines !== undefined ? updates.narrationScript.lines : base.lines,
    }
  }

  const next: AvatarLayer = { ...prev, ...out }
  const pos = out.narrationScript?.position ?? next.narrationScript?.position
  if (pos) {
    out.avatarPlacement = pos
  }

  const mergedNs = out.narrationScript ?? next.narrationScript
  if (mergedNs && prev.avatarSceneConfig) {
    const asc = { ...prev.avatarSceneConfig, ...(out.avatarSceneConfig ?? {}) }
    out.avatarSceneConfig = {
      ...asc,
      narrationScript: mergedNs,
    }
  }

  return out
}
