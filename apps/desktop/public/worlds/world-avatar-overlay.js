// Legacy avatar overlay for 3D worlds.
//
// World configs saved by older versions can still list avatars, but the local
// 3D avatar runtime and its sample models were removed. Each configured avatar
// now renders a static placeholder in the corner so the world still loads and
// the missing avatar is visible instead of silently disappearing.
//
// Contract (unchanged): createWorldAvatar(hostEl, avatarCfg, tl, { index? })
//   -> Promise<{ element, head: null, destroy } | null>

export async function createWorldAvatar(hostEl, avatarCfg, _tl, opts) {
  if (!hostEl || !avatarCfg) return null
  const index = opts && typeof opts.index === 'number' ? opts.index : 0

  const wrap = document.createElement('div')
  wrap.className = 'dreambyte-world-avatar dreambyte-removed-avatar'
  wrap.style.cssText = [
    'position:absolute',
    'bottom:24px',
    'right:' + (24 + index * 300) + 'px',
    'width:280px',
    'height:120px',
    'display:flex',
    'align-items:center',
    'justify-content:center',
    'padding:12px',
    'box-sizing:border-box',
    'text-align:center',
    'border-radius:12px',
    'background:rgba(20,20,28,0.85)',
    'color:#e5e5ea',
    'font:600 16px/1.3 system-ui,-apple-system,sans-serif',
    'pointer-events:none',
    'z-index:10',
  ].join(';')
  wrap.textContent = 'This avatar used a removed local avatar model'
  hostEl.appendChild(wrap)

  return {
    element: wrap,
    head: null,
    destroy: function () {
      wrap.remove()
    },
  }
}
