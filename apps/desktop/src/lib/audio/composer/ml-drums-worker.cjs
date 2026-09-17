/**
 * Native music composer — GrooVAE drums worker (humanize).
 *
 * Thin entry over the shared harness (magenta-worker-base.cjs). GrooVAE is a
 * MusicVAE checkpoint whose GrooveConverter (config.json) is configured with
 * humanize:true — so it takes a flat rhythm grid and INVENTS the micro-timing +
 * velocity (a real drummer's feel) instead of the dead-flat step grid.
 *
 *   request:  { checkpointDir, segments: Array<Array<{step,pitch}>>, qpm }
 *             each segment = one 2-bar (32-step) drum grid; pitch ∈ {36,38,42}
 *   response: { ok, segments: Array<Array<{pitch,startTime,endTime,velocity}>> }
 *             startTime/endTime in SECONDS at qpm (GrooveConverter renders real time)
 *
 * `@magenta/music/node/music_vae` is required LAZILY inside the handler (after the
 * offline fetch shim is installed). With humanize:true the converter ignores input
 * velocity/offset and uses only the hit vector — so we pass plain on-grid hits.
 */
const { runWorker } = require('./magenta-worker-base.cjs')

runWorker(async (req) => {
  const { MusicVAE } = require('@magenta/music/node/music_vae')
  const mvae = new MusicVAE('file://local/groovae') // base ignored — the shim serves checkpointDir
  await mvae.initialize()

  // One quantized 32-step drum NoteSequence per segment.
  const sequences = req.segments.map((hits) => ({
    quantizationInfo: { stepsPerQuarter: 4 },
    totalQuantizedSteps: 32,
    timeSignatures: [{ time: 0, numerator: 4, denominator: 4 }],
    tempos: [{ time: 0, qpm: req.qpm }],
    notes: hits.map((h) => ({
      pitch: h.pitch,
      quantizedStartStep: h.step,
      quantizedEndStep: h.step + 1,
      isDrum: true,
    })),
  }))

  // Batched: encode all segments → z, decode back at our qpm (real-time output).
  const z = await mvae.encode(sequences)
  const outs = await mvae.decode(z, undefined, undefined, 4, req.qpm)
  z.dispose()
  mvae.dispose()

  const segments = outs.map((ns) =>
    (ns.notes || []).map((n) => ({
      pitch: n.pitch,
      startTime: Number(n.startTime || 0),
      endTime: Number(n.endTime || 0),
      velocity: Number(n.velocity || 80),
    })),
  )
  return { segments }
})
