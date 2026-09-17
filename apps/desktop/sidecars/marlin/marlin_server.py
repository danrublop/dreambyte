#!/usr/bin/env python3
"""
Marlin-2B sidecar for Dreambyte (premium video understanding).

Persistent stdio JSON-RPC server. The Electron host (src/electron/marlin-sidecar-host.ts)
spawns this once and sends newline-delimited JSON requests on stdin:

    {"id": 1, "op": "caption", "source": "/path/to/video.mp4"}
    {"id": 2, "op": "find", "source": "/path/to/video.mp4", "event": "a person enters"}

Responses are newline-delimited JSON on stdout:

    {"id": 1, "ok": true, "result": {"scene": "...", "events": [{"start": 1.2, "end": 3.4, "description": "..."}]}}
    {"id": 2, "ok": true, "result": {"span": [14.3, 18.2]}}
    {"id": N, "ok": false, "error": "..."}

CUDA-only. Requires the packages in requirements.txt (next to this file).
The model (~4GB) downloads to the HF cache on first load. Anything that fails
(no CUDA, missing deps, model download) is reported as an error response so the
host degrades gracefully rather than hanging.

Lazy load: the model is loaded on the first request, not at startup, so spawn is
cheap and load failures surface as a per-request error.
"""

import os
import sys
import json

MODEL_ID = "NemoStation/Marlin-2B"

# The JSON-RPC channel is the ORIGINAL stdout. torch / transformers /
# trust_remote_code model code prints progress bars + warnings to stdout, which
# would interleave with and corrupt our protocol lines. Dup the real stdout for
# protocol use, then point sys.stdout at stderr so all library noise stays off
# the channel.
_protocol_out = os.fdopen(os.dup(sys.stdout.fileno()), "w")
sys.stdout = sys.stderr

_marlin = None  # cached model handle


def _load_model():
    global _marlin
    if _marlin is not None:
        return _marlin
    import torch  # noqa: WPS433 (lazy import: keep startup cheap, surface load errors per-request)
    from transformers import AutoModelForCausalLM

    if not torch.cuda.is_available():
        raise RuntimeError("CUDA not available; Marlin-2B requires an NVIDIA GPU")

    _marlin = AutoModelForCausalLM.from_pretrained(
        MODEL_ID,
        trust_remote_code=True,
        dtype=torch.bfloat16,
        device_map={"": "cuda"},
    )
    return _marlin


def _handle_caption(source: str) -> dict:
    marlin = _load_model()
    result = marlin.caption(source)
    events = [
        {"start": float(ev["start"]), "end": float(ev["end"]), "description": str(ev["description"])}
        for ev in result.get("events", [])
    ]
    return {"scene": result.get("scene", ""), "events": events}


def _handle_find(source: str, event: str) -> dict:
    marlin = _load_model()
    result = marlin.find(source, event=event)
    span = result.get("span")
    return {"span": list(span) if span else None, "format_ok": bool(result.get("format_ok"))}


def _respond(obj: dict) -> None:
    _protocol_out.write(json.dumps(obj) + "\n")
    _protocol_out.flush()


def main() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            continue
        req_id = req.get("id")
        try:
            op = req.get("op")
            if op == "caption":
                result = _handle_caption(req["source"])
            elif op == "find":
                result = _handle_find(req["source"], req.get("event", ""))
            else:
                raise ValueError(f"unknown op: {op}")
            _respond({"id": req_id, "ok": True, "result": result})
        except Exception as exc:  # noqa: BLE001 — report any failure to the host
            _respond({"id": req_id, "ok": False, "error": f"{type(exc).__name__}: {exc}"})


if __name__ == "__main__":
    main()
