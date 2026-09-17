/**
 * CSS border-radius for interactive tooltip *trigger* hit areas.
 * Circle is the default product choice; other shapes stay available.
 */
export type TooltipTriggerShape = 'circle' | 'pill' | 'rounded' | 'square' | 'rectangle'

export function cssBorderRadiusForTooltipTrigger(shape: string | undefined, styleBorderRadius: number): string {
  const br = Math.max(0, Number(styleBorderRadius) || 0)
  switch (shape) {
    case 'circle':
      return '50%'
    case 'pill':
      return '9999px'
    case 'rounded':
      return `${Math.max(Math.round(br / 2), 8)}px`
    case 'square':
      return '0'
    case 'rectangle':
    default:
      return `${Math.max(Math.round(br / 2), 6)}px`
  }
}
