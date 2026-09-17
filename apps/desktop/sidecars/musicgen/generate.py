#!/usr/bin/env python3
"""
Neural music sidecar — PROTOTYPE GATE.

Local text-prompt -> music via MusicGen Small (HF transformers). This is the
deferred Tier-2 ceiling-raiser: "describe any song in words -> audio", vs the
template composer's genre+instrument knobs. Weights are FETCHED locally on first
run (cached to ~/.cache/huggingface) — Dreambyte never ships them.

Usage:
  python generate.py --prompt "warm lo-fi piano with vinyl crackle" --duration 10 --out out.wav
"""
import argparse
import time
import sys

import scipy.io.wavfile


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--prompt", required=True)
    ap.add_argument("--duration", type=float, default=10.0, help="seconds")
    ap.add_argument("--out", required=True)
    ap.add_argument("--device", default="auto", choices=["auto", "cpu", "mps"])
    ap.add_argument("--model", default="facebook/musicgen-small")
    args = ap.parse_args()

    import torch
    from transformers import AutoProcessor, MusicgenForConditionalGeneration

    # MPS has had missing-op gaps for MusicGen; default to CPU for a reliable
    # prototype, but allow --device mps to try the faster Metal path.
    device = args.device
    if device == "auto":
        device = "cpu"

    log(f"loading {args.model} (first run downloads ~2GB)...")
    t0 = time.time()
    processor = AutoProcessor.from_pretrained(args.model)
    model = MusicgenForConditionalGeneration.from_pretrained(args.model).to(device)
    log(f"model loaded in {time.time() - t0:.1f}s on {device}")

    inputs = processor(text=[args.prompt], padding=True, return_tensors="pt").to(device)
    # MusicGen runs at a 50 Hz frame rate → tokens ≈ seconds × 50.
    max_new_tokens = int(args.duration * 50)

    log(f'generating {args.duration:.0f}s for: "{args.prompt}" ...')
    t1 = time.time()
    with torch.no_grad():
        audio = model.generate(
            **inputs,
            do_sample=True,
            guidance_scale=3.0,
            max_new_tokens=max_new_tokens,
        )
    gen_s = time.time() - t1

    sr = model.config.audio_encoder.sampling_rate  # 32000
    wav = audio[0, 0].cpu().numpy()
    scipy.io.wavfile.write(args.out, sr, wav)
    realtime_x = args.duration / gen_s if gen_s > 0 else 0
    log(f"done: {gen_s:.1f}s to generate {args.duration:.0f}s audio ({realtime_x:.2f}x realtime) -> {args.out}")
    # stdout = machine-readable result line (the server/agent path will parse this)
    print(f"OK {args.out} sr={sr} gen_s={gen_s:.1f}")


if __name__ == "__main__":
    main()
