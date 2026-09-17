import { describe, it, expect } from 'vitest'
import {
  isExportClientAction,
  isVisualFeedbackClientAction,
  isPrimaryVisualFeedbackTool,
  reviewToolUnfulfillable,
  VISUAL_FEEDBACK_CLIENT_ACTIONS,
} from './client-action'

describe('reviewToolUnfulfillable (#honest-review-mcp)', () => {
  it('review_video is unfulfillable without the single-frame capture runner', () => {
    expect(reviewToolUnfulfillable('review_video', { capture: false, multiCapture: true })).toBe(true)
    expect(reviewToolUnfulfillable('review_video', { capture: true, multiCapture: false })).toBe(false)
  })
  it('review_scene_motion is unfulfillable without the multi-frame capture runner', () => {
    expect(reviewToolUnfulfillable('review_scene_motion', { capture: true, multiCapture: false })).toBe(true)
    expect(reviewToolUnfulfillable('review_scene_motion', { capture: true, multiCapture: true })).toBe(false)
  })
  it('non-review actions are never blamed', () => {
    expect(reviewToolUnfulfillable('capture_frame', { capture: false, multiCapture: false })).toBe(false)
    expect(reviewToolUnfulfillable('run_export', { capture: false, multiCapture: false })).toBe(false)
  })
})

describe('isExportClientAction (T3 / decision 6A)', () => {
  it('narrows a run_export payload', () => {
    const data: unknown = { clientAction: 'run_export', exportSettings: { resolution: '1080p', fps: 30 } }
    expect(isExportClientAction(data)).toBe(true)
    if (isExportClientAction(data)) {
      // Type-narrowed: these are typed here, not re-cast.
      expect(data.exportSettings?.resolution).toBe('1080p')
      expect(data.exportSettings?.fps).toBe(30)
    }
  })

  it('returns false for other clientAction values (scope: export only)', () => {
    expect(isExportClientAction({ clientAction: 'capture_frame' })).toBe(false)
    expect(isExportClientAction({ clientAction: 'review_video' })).toBe(false)
    expect(isExportClientAction({ clientAction: 'review_scene_motion' })).toBe(false)
  })

  it('returns false for non-objects and missing clientAction', () => {
    expect(isExportClientAction(null)).toBe(false)
    expect(isExportClientAction(undefined)).toBe(false)
    expect(isExportClientAction('run_export')).toBe(false)
    expect(isExportClientAction({})).toBe(false)
    expect(isExportClientAction({ action: 'open_export_modal' })).toBe(false)
  })
})

describe('isVisualFeedbackClientAction (MCP-parity Phase 0 honesty)', () => {
  it('narrows each visual-feedback action', () => {
    for (const action of VISUAL_FEEDBACK_CLIENT_ACTIONS) {
      const data: unknown = { clientAction: action }
      expect(isVisualFeedbackClientAction(data)).toBe(true)
      if (isVisualFeedbackClientAction(data)) {
        expect(data.clientAction).toBe(action)
      }
    }
  })

  it('returns false for the export action (kept distinct)', () => {
    expect(isVisualFeedbackClientAction({ clientAction: 'run_export' })).toBe(false)
  })

  it('returns false for non-objects, missing, or unknown clientAction', () => {
    expect(isVisualFeedbackClientAction(null)).toBe(false)
    expect(isVisualFeedbackClientAction(undefined)).toBe(false)
    expect(isVisualFeedbackClientAction('capture_frame')).toBe(false)
    expect(isVisualFeedbackClientAction({})).toBe(false)
    expect(isVisualFeedbackClientAction({ clientAction: 'something_else' })).toBe(false)
  })

  it('is mutually exclusive with isExportClientAction', () => {
    const exportData = { clientAction: 'run_export' }
    const captureData = { clientAction: 'capture_frame' }
    expect(isExportClientAction(exportData) && isVisualFeedbackClientAction(exportData)).toBe(false)
    expect(isExportClientAction(captureData) || isVisualFeedbackClientAction(captureData)).toBe(true)
  })
})

describe('isPrimaryVisualFeedbackTool (regression guard: keep MCP fulfilment keyed on TOOL, not clientAction value)', () => {
  it('is true ONLY for the primary visual-feedback tools (capture_frame + review)', () => {
    expect(isPrimaryVisualFeedbackTool('capture_frame')).toBe(true)
    // review(scope) merged review_video + review_scene_motion; it still EMITS both
    // clientAction values, which is why the tool list and the value list diverged.
    expect(isPrimaryVisualFeedbackTool('review')).toBe(true)
    expect(isPrimaryVisualFeedbackTool('review_video')).toBe(false)
  })

  it('is FALSE for verify_scene and the code-write tools that piggyback clientAction:capture_frame', () => {
    // These emit/attach clientAction:'capture_frame' but are NOT primary visual
    // tools. If mcp-handler keyed on the clientAction value it would hijack them:
    // verify_scene loses its report; the code-write tools lose their mutation
    // (return before persistence). This guards that exact regression.
    for (const t of ['verify_scene', 'write_scene_code', 'patch_layer_code', 'add_layer', 'regenerate_layer']) {
      expect(isPrimaryVisualFeedbackTool(t)).toBe(false)
    }
  })
})
