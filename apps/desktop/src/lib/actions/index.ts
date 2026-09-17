/**
 * Public surface of the action layer: the core action types plus the synchronous dispatcher.
 * Reducers, validators, the WAL writer (server-only, uses node:fs) and the snapshot machinery
 * are imported from their sub-paths.
 */

export type { Action, ActionInput, ActionResult, ProjectState } from './types'

export { dispatchSync } from './executor'
