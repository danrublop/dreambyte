---
type: rule
title: Audio Craft Rules
description: How to wire audio tools — spine, mix dB targets, provider ladder. Read while planning, before any audio call.
tags: ["core", "audio"]
timestamp: 2026-06-19T00:00:00Z
---

# Audio Tools

Plan the audio spine alongside the visual plan. Do not bolt it on at the end.

Tools: `add_narration`, `add_music`, `add_sfx`, `set_audio_mix`, `set_master_volume`,
`clone_voice`, `dub_video`. `add_music` takes `source: 'library'|'generate'|'compose'`;
`add_sfx` takes `source: 'library'|'synthesize'`.

## Pick ONE spine before building

Tie to `brief.voiceDriver`. Do not stack competing leads.

| Spine | `voiceDriver` | When | Lead tool |
| --- | --- | --- | --- |
| Narration-led | `narration` | Explainers, tutorials, teaching | `add_narration` first; music ducks under |
| Music-led | `music` or none | Montages, brand films, hype reels | `add_music` first (source:compose/generate); cut to the beat |
| Diegetic-led | `footage` | Uploaded footage with real on-screen sound | Keep footage audio; add score only as a bed |

## Mix — set dB via `set_audio_mix`

Set explicit levels. Never leave balance to chance.

| Layer | Target |
| --- | --- |
| Vocals / narration | **-9 to -12 dB** — always intelligible, sits on top |
| Music under voice | **~-2 dB** ducked below voice; bed drops ~12 dB when VO present |
| Music, no voice | Bring up to lead level to carry the moment |
| SFX | Supporting accents; never louder than VO |

Gain ladder: voice ~1.0 > music bed ~0.12 (≈−18 dB) under voice > SFX ~0.35.

- Voice always wins. Duck the bed under speech, lift it in the gaps.
- Duck **per narration line**: down fast ~0.15s at the line start, back up ~0.4s in the gap. Not once for the whole track.
- Anchor a build/riser to its payoff: trigger at `climax_time − riser_duration` so it PEAKS on the hit.
- `set_master_volume`: set final overall level once at the end for consistent export loudness.
- Leave headroom. Peak just under clipping with voice on top; do not slam layers to 0 dB.

## Music — compose vs generate vs library vs upload

All music goes through `add_music({ source })`. Local-first: `source:'compose'` and the bundled library are $0 and controllable. Reach for them before paid generation.

| `source` | Use when |
| --- | --- |
| `compose` | Structured/controllable music — mood, tempo, key, intensity, length matched to cut. Local, $0. Default for music-led. |
| `generate` | Fast full-texture track from a text `prompt`, no beat-level control. PAID (spend-gated). Good for beds. |
| `library` | A pre-cleared royalty-free bed already fits — search by `query`, fastest. |
| (upload) | User supplied a track / licensing must be exact — always prefer the user's own track. |

Seat under the spine with `set_audio_mix`.

Generative-music model ladder (when you call `add_music({ source:'generate' })`):

| Model | Cost | Reach for it when |
| --- | --- | --- |
| `stable-audio` (FAL) | ~5¢ | cheapest generative bed |
| `lyria` (Google) | ~8¢ | cheap, decent general-purpose |
| `elevenlabs-music` | ~40¢ | cleanest commercial licensing for shipped/branded video |
| `musicgen` (local, opt-in) | $0 | neural text-prompt bed, no API cost |

## SFX

All SFX go through `add_sfx({ source })`. `source:'library'` for recorded clips (search by `query`); `source:'synthesize'` for procedural hits (ZzFX/jsfxr/nature/modal, $0, no key).

Use for: transition markers (whoosh on a cut/transform), on-screen actions (click, pop, count tick, impact), diegetic realism on footage.

Do not: give every element its own sound, sit SFX at voice level, loop/repeat mechanically.

A handful of well-placed accents beats a wall of sound. Prefer `source:'synthesize'` for clean UI/abstract hits; `source:'library'` for organic real-world sounds.

## Narration providers — `add_narration`

Use the cheapest voice that clears the brief.

| Provider | Cost | Use when |
| --- | --- | --- |
| pocket-tts (local) | $0 | Default. Local, fast, self-managed; pin `provider: 'pocket-tts'`. |
| gemini-tts / google-tts | ~1¢ | cheap cloud voice, step up from local |
| openai-tts | ~2¢ | style-instructable cloud voice |
| elevenlabs | ~6¢ | top-tier, expressive, broadcast-quality; shipped/hero VO |
| edge-tts / voxcpm (local) / web-speech | $0 | free fallbacks when a provider key is missing |
| user-upload | — | user recorded their own VO — use as-is, don't regenerate |

Write narration to be spoken: short sentences, natural cadence, room to breathe. After `add_narration`, duck the music bed via `set_audio_mix`.

## Voice cloning & dubbing

- `clone_voice` — match narration to a provided voice (series consistency, or the user's own). User consent + source required.
- `dub_video` — replace/translate spoken audio in uploaded footage for another language. Keep diegetic ambience underneath where possible.

## Before finishing audio

- [ ] Spine chosen, consistent with `brief.voiceDriver`.
- [ ] `set_audio_mix` applied: voice -9 to -12 dB, music ducked ~2 dB under voice, SFX supporting.
- [ ] SFX are accents, not a wall — voice never buried.
- [ ] `set_master_volume` calibrated once at the end.
- [ ] Narration provider matches the brief's cost need.
