#!/usr/bin/env python3
"""
VoxCPM2 FastAPI server wrapper for Dreambyte.

Exposes VoxCPM2 as an HTTP API compatible with the Dreambyte TTS provider interface.

Requirements:
    pip install voxcpm fastapi uvicorn pydub

Usage:
    python sidecars/voxcpm/server.py
    # or with custom port:
    VOXCPM_PORT=8100 python sidecars/voxcpm/server.py

The server runs on http://localhost:8100 by default.
Set VOXCPM_URL=http://localhost:8100 in your .env.local file.
"""

import io
import os
import uuid
import logging
from typing import Optional

from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import Response, JSONResponse
import uvicorn

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("voxcpm-server")

app = FastAPI(title="VoxCPM2 Server", version="1.0.0")

# Lazy-load model to avoid import errors if voxcpm is not installed
_model = None


def get_model():
    global _model
    if _model is None:
        logger.info("Loading VoxCPM2 model...")
        from voxcpm import VoxCPM

        _model = VoxCPM.from_pretrained("openbmb/VoxCPM2")
        logger.info("VoxCPM2 model loaded.")
    return _model


# In-memory voice store for cloned/designed voices
_custom_voices: dict[str, dict] = {}


@app.get("/health")
async def health():
    return {"status": "ok", "model": "VoxCPM2"}


@app.get("/v1/voices")
async def list_voices():
    """List available voices (built-in + custom cloned/designed)."""
    voices = [
        {"voice_id": "default", "name": "Default", "language": "en"},
    ]
    for vid, vdata in _custom_voices.items():
        voices.append(
            {
                "voice_id": vid,
                "name": vdata.get("name", vid),
                "language": vdata.get("language", "en"),
            }
        )
    return voices


from pydantic import BaseModel


class SpeechRequest(BaseModel):
    text: str
    voice_id: str = "default"
    mode: str = "standard"
    language: str = "en"


@app.post("/v1/audio/speech")
async def generate_speech(body: SpeechRequest):
    """Generate speech from text (JSON body). Returns MP3 audio."""
    text = body.text
    voice_id = body.voice_id
    if not text:
        return JSONResponse({"error": "text is required"}, status_code=400)

    try:
        model = get_model()

        # Build generation kwargs based on mode
        kwargs = {"text": text}

        if voice_id != "default" and voice_id in _custom_voices:
            voice_data = _custom_voices[voice_id]
            if "audio_path" in voice_data:
                kwargs["reference_audio"] = voice_data["audio_path"]
                if voice_data.get("transcript"):
                    kwargs["reference_text"] = voice_data["transcript"]

        # Generate audio
        wav = model.generate(**kwargs)

        # Convert to MP3 using pydub
        from pydub import AudioSegment
        import numpy as np

        # wav is typically a numpy array at 48kHz
        sample_rate = 48000
        if hasattr(wav, "sample_rate"):
            sample_rate = wav.sample_rate
        if hasattr(wav, "numpy"):
            wav_data = wav.numpy()
        elif hasattr(wav, "cpu"):
            wav_data = wav.cpu().numpy()
        else:
            wav_data = wav

        # Normalize to int16
        if wav_data.dtype in (np.float32, np.float64):
            wav_data = (wav_data * 32767).astype(np.int16)

        audio_segment = AudioSegment(
            wav_data.tobytes(),
            frame_rate=sample_rate,
            sample_width=2,
            channels=1,
        )

        mp3_buffer = io.BytesIO()
        audio_segment.export(mp3_buffer, format="mp3", bitrate="128k")
        mp3_bytes = mp3_buffer.getvalue()

        return Response(content=mp3_bytes, media_type="audio/mpeg")

    except Exception as e:
        logger.error(f"Generation error: {e}")
        return JSONResponse({"error": str(e)}, status_code=500)


@app.post("/v1/voices/clone")
async def clone_voice(
    name: str = Form(...),
    audio: UploadFile = File(...),
    transcript: Optional[str] = Form(None),
    mode: str = Form("controllable"),
):
    """Clone a voice from a reference audio file."""
    try:
        voice_id = f"cloned-{uuid.uuid4().hex[:8]}"

        # Save the uploaded audio to a temp file
        import tempfile

        suffix = ".wav" if "wav" in (audio.content_type or "") else ".mp3"
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            content = await audio.read()
            tmp.write(content)
            tmp_path = tmp.name

        _custom_voices[voice_id] = {
            "name": name,
            "audio_path": tmp_path,
            "transcript": transcript,
            "mode": mode,
            "language": "en",
        }

        logger.info(f"Cloned voice '{name}' as {voice_id} (mode={mode})")
        return {"voice_id": voice_id, "name": name}

    except Exception as e:
        logger.error(f"Clone error: {e}")
        return JSONResponse({"error": str(e)}, status_code=500)


class DesignVoiceRequest(BaseModel):
    description: str
    sample_text: Optional[str] = None


@app.post("/v1/voices/design")
async def design_voice(body: DesignVoiceRequest):
    """Design a new voice from a natural language description (JSON body)."""
    description = body.description
    sample_text = body.sample_text
    if not description:
        return JSONResponse({"error": "description is required"}, status_code=400)

    try:
        model = get_model()
        voice_id = f"designed-{uuid.uuid4().hex[:8]}"

        # Use VoxCPM's voice design mode
        preview_text = sample_text or "Hello, this is a preview of the designed voice."

        # Generate a preview with the designed voice
        wav = model.generate(
            text=preview_text,
            voice_description=description,
        )

        # Save preview as MP3
        from pydub import AudioSegment
        import numpy as np
        import tempfile

        sample_rate = 48000
        if hasattr(wav, "numpy"):
            wav_data = wav.numpy()
        elif hasattr(wav, "cpu"):
            wav_data = wav.cpu().numpy()
        else:
            wav_data = wav

        if wav_data.dtype in (np.float32, np.float64):
            wav_data = (wav_data * 32767).astype(np.int16)

        audio_segment = AudioSegment(
            wav_data.tobytes(),
            frame_rate=sample_rate,
            sample_width=2,
            channels=1,
        )

        # Save preview file
        preview_path = tempfile.NamedTemporaryFile(
            delete=False, suffix=".mp3", prefix="voxcpm-preview-"
        ).name
        audio_segment.export(preview_path, format="mp3", bitrate="128k")

        _custom_voices[voice_id] = {
            "name": f"Designed: {description[:30]}",
            "description": description,
            "language": "en",
        }

        # Return preview URL relative to the server
        logger.info(f"Designed voice '{description[:50]}' as {voice_id}")
        return {
            "voice_id": voice_id,
            "name": f"Designed: {description[:30]}",
            "preview_url": f"/v1/preview/{voice_id}",
        }

    except Exception as e:
        logger.error(f"Design error: {e}")
        return JSONResponse({"error": str(e)}, status_code=500)


if __name__ == "__main__":
    port = int(os.environ.get("VOXCPM_PORT", "8100"))
    logger.info(f"Starting VoxCPM2 server on port {port}")
    uvicorn.run(app, host="0.0.0.0", port=port)
