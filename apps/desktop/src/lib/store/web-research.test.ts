/**
 * Web-research store flags: the three switches that replaced the single researchEnabled
 * master toggle. Defaults are ON (native, on-by-default) — this is the D10 "default-on for
 * all on upgrade" intent: a fresh store has web research enabled without any opt-in.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useVideoStore } from './index'

describe('web-research store flags', () => {
  beforeEach(() => {
    // Reset to defaults between assertions that mutate.
    useVideoStore.getState().setWebSearchEnabled(true)
    useVideoStore.getState().setWebFetchEnabled(true)
    useVideoStore.getState().setAutoAcceptWebSearch(true)
  })

  it('all three flags default to ON', () => {
    const s = useVideoStore.getState()
    expect(s.webSearchEnabled).toBe(true)
    expect(s.webFetchEnabled).toBe(true)
    expect(s.autoAcceptWebSearch).toBe(true)
  })

  it('the legacy researchEnabled flag is gone', () => {
    expect((useVideoStore.getState() as unknown as Record<string, unknown>).researchEnabled).toBeUndefined()
  })

  it('setters flip each flag independently', () => {
    const st = useVideoStore.getState()
    st.setWebSearchEnabled(false)
    expect(useVideoStore.getState().webSearchEnabled).toBe(false)
    expect(useVideoStore.getState().webFetchEnabled).toBe(true) // unaffected
    expect(useVideoStore.getState().autoAcceptWebSearch).toBe(true)

    st.setWebFetchEnabled(false)
    expect(useVideoStore.getState().webFetchEnabled).toBe(false)

    st.setAutoAcceptWebSearch(false)
    expect(useVideoStore.getState().autoAcceptWebSearch).toBe(false)
    expect(useVideoStore.getState().webSearchEnabled).toBe(false)
  })
})
