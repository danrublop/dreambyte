/**
 * Native music composer — ML melody worker (ImprovRNN, chord-conditioned).
 *
 * Thin entry over the shared harness (magenta-worker-base.cjs): the harness
 * owns the isolated-process hacks + JSON protocol; this file only provides the
 * ImprovRNN handler. Runs in a child process via spawn() from ml-melody.ts.
 *
 *   request:  { checkpointDir, chords: string[], steps, temperature, seedPitch }
 *   response: { ok, notes: [{pitch, quantizedStartStep, quantizedEndStep}] }
 *
 * `@magenta/music/node/music_rnn` is required LAZILY inside the handler (after the
 * offline fetch shim is installed) and per-module (the full index throws on the
 * Node audio context).
 */
const { runWorker } = require('./magenta-worker-base.cjs')

runWorker(async (req) => {
  const { MusicRNN } = require('@magenta/music/node/music_rnn')
  const rnn = new MusicRNN('file://local/improv') // base ignored — the shim serves checkpointDir
  await rnn.initialize()

  const seed = {
    notes: [{ pitch: req.seedPitch || 60, quantizedStartStep: 0, quantizedEndStep: 2 }],
    quantizationInfo: { stepsPerQuarter: 4 },
    totalQuantizedSteps: 2,
  }
  const out = await rnn.continueSequence(seed, req.steps, req.temperature, req.chords)
  rnn.dispose()

  const notes = (out.notes || []).map((n) => ({
    pitch: n.pitch,
    quantizedStartStep: Number(n.quantizedStartStep || 0),
    quantizedEndStep: Number(n.quantizedEndStep || 0),
  }))
  return { notes }
})
