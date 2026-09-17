#!/usr/bin/env python3
"""
MusicGen sidecar HTTP server — local, $0, text-prompt -> music.

The neural counterpart to Dreambyte's compose_music (template + instrument knobs).
Loads MusicGen ONCE and serves generations over HTTP, so the app talks to it the
same way it talks to pocket-tts: a self-managed local server reached via MUSICGEN_URL.
Weights are fetched locally on first run (cached to ~/.cache/huggingface) — never shipped.

  GET  /health           -> {"ok": true, "model": ..., "device": ...}
  POST /generate {prompt, duration}  -> WAV bytes (header x-sample-rate)

Run via the venv created by setup.sh:
  ~/.dreambyte/sidecar/musicgen/venv/bin/python server.py --port 8090
Stdlib http.server only (no Flask) to keep the venv minimal.
"""
import argparse
import io
import json
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import scipy.io.wavfile

MODEL_NAME = os.environ.get("MUSICGEN_MODEL", "facebook/musicgen-small")
# MusicGen's autoregressive loop thrashes on MPS (missing-op CPU fallbacks make it
# SLOWER than CPU), so default to CPU. Override with MUSICGEN_DEVICE=mps to experiment.
DEVICE = os.environ.get("MUSICGEN_DEVICE", "cpu")
MAX_DURATION = 30.0

_model = None
_processor = None
_torch = None


def log(msg: str) -> None:
    print(f"[musicgen] {msg}", file=sys.stderr, flush=True)


def load_model() -> None:
    global _model, _processor, _torch
    if _model is not None:
        return
    import torch
    from transformers import AutoProcessor, MusicgenForConditionalGeneration

    _torch = torch
    log(f"loading {MODEL_NAME} (first run downloads ~2GB)...")
    t0 = time.time()
    _processor = AutoProcessor.from_pretrained(MODEL_NAME)
    _model = MusicgenForConditionalGeneration.from_pretrained(MODEL_NAME).to(DEVICE)
    log(f"ready in {time.time() - t0:.1f}s on {DEVICE}")


def generate_wav(prompt: str, duration: float) -> tuple[bytes, int, float]:
    load_model()
    import numpy as np

    seconds = max(1.0, min(duration, MAX_DURATION))
    inputs = _processor(text=[prompt], padding=True, return_tensors="pt").to(DEVICE)
    max_new_tokens = int(seconds * 50)  # MusicGen runs at 50 Hz
    t0 = time.time()
    with _torch.no_grad():
        audio = _model.generate(**inputs, do_sample=True, guidance_scale=3.0, max_new_tokens=max_new_tokens)
    sr = _model.config.audio_encoder.sampling_rate
    wav = audio[0, 0].cpu().numpy()
    # MusicGen emits float32 in [-1, 1]; write STANDARD 16-bit PCM (half the size,
    # universally readable, and the app's WAV-duration math assumes 16-bit).
    pcm = np.clip(wav, -1.0, 1.0)
    pcm = (pcm * 32767.0).astype(np.int16)
    actual_seconds = len(pcm) / sr
    log(f'generated {actual_seconds:.1f}s for "{prompt[:48]}" in {time.time() - t0:.1f}s')
    buf = io.BytesIO()
    scipy.io.wavfile.write(buf, sr, pcm)
    return buf.getvalue(), sr, actual_seconds


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):  # silence default access logging
        pass

    def do_GET(self):
        if self.path.rstrip("/") == "/health":
            self._json(200, {"ok": True, "model": MODEL_NAME, "device": DEVICE, "loaded": _model is not None})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        if self.path.rstrip("/") != "/generate":
            self._json(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length) or b"{}")
            prompt = str(body.get("prompt", "")).strip()
            if not prompt:
                self._json(400, {"error": "prompt is required"})
                return
            duration = float(body.get("duration", 10))
            wav, sr, actual = generate_wav(prompt, duration)
            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("x-sample-rate", str(sr))
            self.send_header("x-duration", f"{actual:.3f}")
            self.send_header("Content-Length", str(len(wav)))
            self.end_headers()
            self.wfile.write(wav)
        except Exception as e:  # surface generation errors to the caller
            log(f"error: {e}")
            self._json(500, {"error": str(e)})

    def _json(self, code: int, obj: dict) -> None:
        data = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=int(os.environ.get("MUSICGEN_PORT", 8090)))
    ap.add_argument("--preload", action="store_true", help="load the model at startup, not on first request")
    args = ap.parse_args()
    if args.preload:
        load_model()
    log(f"serving on http://127.0.0.1:{args.port}  (model {MODEL_NAME}, device {DEVICE})")
    ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
