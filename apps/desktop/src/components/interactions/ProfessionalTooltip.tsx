'use client'

import * as React from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { cn } from '@/lib/utils'

export type ProfessionalTooltipPosition = 'top' | 'bottom' | 'left' | 'right'

interface ProfessionalTooltipProps {
  content: React.ReactNode
  children: React.ReactNode
  className?: string
  /** Panel + content max width (CSS value, e.g. 280 or 'min(320px,90vw)') */
  contentMaxWidth?: number | string
  position?: ProfessionalTooltipPosition
  /** When set, visibility is controlled (e.g. sync trigger hover styles). */
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

const panelBase =
  'absolute z-50 box-border px-3.5 py-2.5 text-left text-sm font-bold text-white bg-slate-900 rounded-lg shadow-xl break-words [overflow-wrap:anywhere]'

const positionPanel: Record<ProfessionalTooltipPosition, string> = {
  top: '-top-2 left-1/2 -translate-x-1/2 -translate-y-full',
  bottom: 'top-full left-1/2 -translate-x-1/2 mt-2',
  left: 'right-full top-1/2 -translate-y-1/2 mr-2',
  right: 'left-full top-1/2 -translate-y-1/2 ml-2',
}

const positionArrow: Record<ProfessionalTooltipPosition, string> = {
  top: 'absolute border-8 border-transparent border-t-slate-900 -bottom-4 left-1/2 -translate-x-1/2',
  bottom: 'absolute border-8 border-transparent border-b-slate-900 -top-4 left-1/2 -translate-x-1/2',
  left: 'absolute border-8 border-transparent border-l-slate-900 top-1/2 -translate-y-1/2 -right-4',
  right: 'absolute border-8 border-transparent border-r-slate-900 top-1/2 -translate-y-1/2 -left-4',
}

function motionOffset(pos: ProfessionalTooltipPosition): { initial: object; exit: object } {
  switch (pos) {
    case 'top':
      return { initial: { opacity: 0, y: 8, scale: 0.95 }, exit: { opacity: 0, y: 8, scale: 0.95 } }
    case 'bottom':
      return { initial: { opacity: 0, y: -8, scale: 0.95 }, exit: { opacity: 0, y: -8, scale: 0.95 } }
    case 'left':
      return { initial: { opacity: 0, x: 8, scale: 0.95 }, exit: { opacity: 0, x: 8, scale: 0.95 } }
    case 'right':
      return { initial: { opacity: 0, x: -8, scale: 0.95 }, exit: { opacity: 0, x: -8, scale: 0.95 } }
  }
}

export function ProfessionalTooltip({
  content,
  children,
  className,
  contentMaxWidth,
  position = 'top',
  open: openControlled,
  onOpenChange,
}: ProfessionalTooltipProps) {
  const [internalOpen, setInternalOpen] = React.useState(false)
  const controlled = openControlled !== undefined
  const isVisible = controlled ? openControlled : internalOpen

  const setOpen = React.useCallback(
    (next: boolean) => {
      if (!controlled) setInternalOpen(next)
      onOpenChange?.(next)
    },
    [controlled, onOpenChange],
  )

  const off = motionOffset(position)

  const capPx: number =
    contentMaxWidth === undefined ? 320 : typeof contentMaxWidth === 'number' ? Math.max(248, contentMaxWidth) : 320

  const panelStyle: React.CSSProperties =
    typeof contentMaxWidth === 'string'
      ? {
          width: contentMaxWidth,
          minWidth: 'min(260px, calc(100vw - 32px))',
          maxWidth: contentMaxWidth,
        }
      : {
          width: `min(${capPx}px, calc(100vw - 32px))`,
          minWidth: `min(${Math.min(capPx, 280)}px, calc(100vw - 32px))`,
          maxWidth: `min(${capPx}px, calc(100vw - 32px))`,
        }

  return (
    <div
      className="relative h-full w-full"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocusCapture={() => setOpen(true)}
      onBlurCapture={(e) => {
        const next = e.relatedTarget as Node | null
        if (!next || !e.currentTarget.contains(next)) setOpen(false)
      }}
    >
      {children}
      <AnimatePresence>
        {isVisible && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95, ...off.initial }}
            animate={{ opacity: 1, x: 0, y: 0, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95, ...off.exit }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
            style={panelStyle}
            className={cn(panelBase, positionPanel[position], 'whitespace-normal', className)}
          >
            {content}
            <div className={positionArrow[position]} aria-hidden />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
