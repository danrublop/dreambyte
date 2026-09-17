# MusicGen sidecar — local text-prompt → music ($0)

The **neural** counterpart to Dreambyte's `compose_music`. Where `compose_music` is a
template + instrument sequencer (instant, pure-JS, bundled), this takes a **free-text
description** — _"warm lo-fi piano with vinyl crackle"_ — and generates audio with
[MusicGen](https://github.com/facebookresearch/audiocraft). It runs as a self-managed
local server the app talks to over HTTP, exactly like the pocket-tts sidecar.

## Why a sidecar (not bundled)

The ML runtime (PyTorch + transformers) is heavy and platform-specific, so it stays
**out of the Electron app**. The user/agent runs this server locally; the app reaches it
via `MUSICGEN_URL`. **Dreambyte never ships the model weights** — they're fetched on
first generation (cached to `~/.cache/huggingface`). This is the same "you supply the
model" posture as Cursor pointing at an API.

## Setup (one time)

```bash
npm run music-sidecar:setup      # creates ~/.dreambyte/sidecar/musicgen/venv + installs torch/transformers
npm run music-sidecar:start      # starts the server on http://127.0.0.1:8090 (downloads ~2GB on first gen)
```

Then point the app at it:

```bash
export MUSICGEN_URL=http://127.0.0.1:8090
```

When `MUSICGEN_URL` is set, `generate_music` auto-prefers the local sidecar (free) over
the paid cloud providers, and it shows up in the audio provider list.

## API

- `GET /health` → `{ ok, model, device, loaded }`
- `POST /generate {prompt, duration}` → 16-bit PCM WAV (headers: `x-sample-rate`, `x-duration`)

## Performance

~0.2–0.25× realtime on CPU (a 10s clip ≈ ~40s). MPS/Metal is **slower** for MusicGen
(its autoregressive loop thrashes on Metal), so the server defaults to CPU. Treat it as a
**background job**, not the instant template composer. `MUSICGEN_MODEL=facebook/musicgen-medium`
(set in the server env) trades ~2× the time for noticeably better quality.

## License (read before shipping commercially)

This integration ships **no weights** — it's plumbing for a model the user fetches and
runs. The MusicGen **weights are CC-BY-NC** (non-commercial): fine for personal/eval use,
but if videos are sold, swap `MUSICGEN_MODEL` to an Apache-licensed model (e.g. ACE-Step)
or a cleanly-licensed cloud provider. The Dreambyte code here is unaffected by that choice.
