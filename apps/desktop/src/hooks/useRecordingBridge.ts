'use client'

import { useEffect, useRef, useCallback } from 'react'
import { useVideoStore } from '@/lib/store'
import { useScreenRecorder } from './useScreenRecorder'
import type { RecordingConfig } from '@/types/electron'

/**
 * Bridges the Zustand store's declarative recording commands to the imperative
 * useScreenRecorder hook. Mount this once in the Editor component.
 *
 * Flow: store.recordingCommand changes → this hook executes the command on
 * useScreenRecorder → syncs state/results back to store.
 */
export function useRecordingBridge() {
  const recordingCommandNonce = useVideoStore((s) => s.recordingCommandNonce)
  const setRecordingState = useVideoStore((s) => s.setRecordingState)
  const setRecordingResult = useVideoStore((s) => s.setRecordingResult)
  const setRecordingError = useVideoStore((s) => s.setRecordingError)
  const setRecordingElapsed = useVideoStore((s) => s.setRecordingElapsed)

  // Use a ref to always read latest config at execution time (avoids stale closure)
  const configRef = useRef<RecordingConfig>(useVideoStore.getState().recordingConfig)
  useEffect(() => {
    return useVideoStore.subscribe((s) => { configRef.current = s.recordingConfig })
  }, [])

  const recorder = useScreenRecorder({
    micEnabled: configRef.current.micEnabled,
    micDeviceId: configRef.current.micDeviceId,
    systemAudioEnabled: configRef.current.systemAudioEnabled,
    webcamEnabled: configRef.current.webcamEnabled,
    webcamDeviceId: configRef.current.webcamDeviceId,
  })

  // Keep a ref to recorder methods so effects don't need recorder as a dep
  const recorderRef = useRef(recorder)
  recorderRef.current = recorder

  // Sync recorder state → store
  const prevState = useRef(recorder.state)
  useEffect(() => {
    if (recorder.state !== prevState.current) {
      prevState.current = recorder.state
      setRecordingState(recorder.state)
    }
  }, [recorder.state, setRecordingState])

  useEffect(() => {
    setRecordingElapsed(recorder.elapsed)
  }, [recorder.elapsed, setRecordingElapsed])

  useEffect(() => {
    if (recorder.error) setRecordingError(recorder.error)
  }, [recorder.error, setRecordingError])

  // Execution lock — prevents parallel command execution
  const executingRef = useRef(false)

  // Command executor — reads all state from store at execution time
  const executeCommand = useCallback(async () => {
    if (executingRef.current) return
    const store = useVideoStore.getState()
    const cmd = store.recordingCommand
    if (!cmd) return

    executingRef.current = true
    // Clear previous error on new command
    setRecordingError(null)

    try {
      switch (cmd) {
        case 'start': {
          // Clear stale result from previous recording
          setRecordingResult(null)
          await recorderRef.current.start()
          break
        }
        case 'stop': {
          const manifest = await recorderRef.current.stop()
          if (manifest) {
            setRecordingResult(manifest)
            // Auto-attach to scene if configured
            const attachSceneId = useVideoStore.getState().recordingAttachSceneId
            if (attachSceneId && manifest.screenVideoUrl) {
              const { updateScene, saveSceneHTML } = useVideoStore.getState()
              updateScene(attachSceneId, {
                videoLayer: {
                  src: manifest.screenVideoUrl,
                  enabled: true,
                  opacity: 1,
                  trimStart: 0,
                  trimEnd: null,
                },
              })
              try { await saveSceneHTML(attachSceneId) } catch {}
              useVideoStore.getState().setRecordingAttachSceneId(null)
            }
          }
          break
        }
        case 'pause':
          recorderRef.current.pause()
          break
        case 'resume':
          recorderRef.current.resume()
          break
        case 'cancel':
          recorderRef.current.cancel()
          useVideoStore.getState().setRecordingAttachSceneId(null)
          break
      }
    } finally {
      executingRef.current = false
      // Consume command AFTER execution completes (not before)
      // Use raw set to avoid nonce increment — we're just clearing
      useVideoStore.setState({ recordingCommand: null })
    }
  }, [setRecordingError, setRecordingResult, setRecordingState])

  // Watch for commands (keyed on nonce so same command can be re-issued)
  const processedNonce = useRef(0)
  useEffect(() => {
    if (recordingCommandNonce <= processedNonce.current) return
    processedNonce.current = recordingCommandNonce
    executeCommand()
  }, [recordingCommandNonce, executeCommand])

  return recorder
}
