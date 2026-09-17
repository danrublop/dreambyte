'use client'

import { useEffect, useState } from 'react'

/** Animated "..." ellipsis used in live agent status lines. */
export function ThinkingDots() {
  const [frame, setFrame] = useState(0)
  const patterns = ['.', '..', '...', '..', '.', '']
  useEffect(() => {
    const id = setInterval(() => setFrame((f) => (f + 1) % patterns.length), 400)
    return () => clearInterval(id)
  }, [])
  return <span className="inline-block w-[1.2em] text-left">{patterns[frame]}</span>
}
