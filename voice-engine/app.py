"""Voise voice engine — Gradio Space (free CPU): speak text in a consenting person's voice.

Exposed as one Gradio API function (api name "predict"), called over the REST API:

  POST {url}/gradio_api/call/predict   {"data": [text, ref_b64, ref_text, language, secret]}
  GET  {url}/gradio_api/call/predict/{event_id}            (SSE) -> data: ["<json string>"]

The reference audio is passed base64-encoded (no file upload). The result is a JSON string
{"audio_b64": "<ogg/opus base64>", "format": "ogg/opus", "seconds": N}. Every call must pass
`secret` equal to the ENGINE_SECRET Space secret; without it the call is refused. Nothing is
stored: audio lives in a per-request temp dir only.

Models (downloaded at startup, pinned to exact revisions):
  - oddadmix/lahgtna-omnivoice-v2  (no licence stated → private use only until its author permits more)
  - eustlb/higgs-audio-v2-tokenizer (Boson licence)   — part of the TTS model
  - openai/whisper-large-v3-turbo  (MIT)               — transcribes the reference clip
Code: OmniVoice (Apache-2.0).

Docker Spaces require a paid plan, so this runs as a Gradio Space (free). omnivoice is installed
without its heavy demo dependencies at startup (pip --no-deps), which a plain requirements.txt
cannot express.
"""
import base64
import hashlib
import hmac
import json
import os
import subprocess
import sys
import tempfile
import threading
import time

# omnivoice pulls conflicting demo deps, so install it WITHOUT deps before importing it.
try:
    import omnivoice  # noqa: F401
except Exception:
    subprocess.run([sys.executable, "-m", "pip", "install", "--no-deps", "omnivoice==0.2.1"], check=True)

import numpy as np
import soundfile as sf
import torch
import gradio as gr
from huggingface_hub import snapshot_download

MODELS = os.environ.get("MODELS_DIR", os.path.join(os.path.expanduser("~"), "models"))
SECRET = os.environ.get("ENGINE_SECRET", "")
MAX_TEXT = 400
MAX_REF_S = 15.0
SR = 16000

torch.set_num_threads(max(1, os.cpu_count() or 1))

_PINS = [
    ("oddadmix/lahgtna-omnivoice-v2", "55c38a613e31", "lahgtna-omnivoice-v2", ["*.json", "*.safetensors", "*.jinja"]),
    ("eustlb/higgs-audio-v2-tokenizer", "528e871c2a26", "lahgtna-omnivoice-v2/audio_tokenizer", ["*.json", "*.safetensors"]),
    ("openai/whisper-large-v3-turbo", "41f01f3fe87f", "whisper-large-v3-turbo", ["*.json", "*.safetensors", "*.txt"]),
]


def _ensure_models():
    for repo, rev, sub, patterns in _PINS:
        snapshot_download(repo, revision=rev, local_dir=os.path.join(MODELS, sub), allow_patterns=patterns)


_models = {}
_ref_text_cache = {}
_lock = threading.Lock()


def _load():
    if not _models:
        from omnivoice.models.omnivoice import OmniVoice
        from transformers import pipeline
        _models["tts"] = OmniVoice.from_pretrained(f"{MODELS}/lahgtna-omnivoice-v2", device_map="cpu")
        _models["asr"] = pipeline("automatic-speech-recognition", model=f"{MODELS}/whisper-large-v3-turbo",
                                  torch_dtype=torch.float32, device="cpu")
        from silero_vad import load_silero_vad
        _models["vad"] = load_silero_vad()
    return _models


def _decode(data, path):
    """Any container/codec (ogg/opus from Telegram, mp3, m4a, wav) -> 16 kHz mono float32 via ffmpeg."""
    src = path + ".in"
    open(src, "wb").write(data)
    out = path + ".wav"
    r = subprocess.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-i", src, "-ac", "1", "-ar", str(SR), out],
                       capture_output=True, timeout=120)
    if r.returncode != 0:
        raise gr.Error("could not decode audio")
    y, _ = sf.read(out, dtype="float32")
    return y


def _speech_only(y, max_s):
    from silero_vad import get_speech_timestamps
    ts = get_speech_timestamps(torch.as_tensor(y), _models["vad"], sampling_rate=SR, min_silence_duration_ms=300,
                               speech_pad_ms=80)
    if not ts:
        raise gr.Error("no speech found in the reference")
    y = np.concatenate([y[t["start"]:t["end"]] for t in ts])[: int(max_s * SR)]
    return y / max(1e-6, float(np.abs(y).max())) * 0.9


def _asr(y):
    out = _models["asr"]({"raw": y, "sampling_rate": SR}, generate_kwargs={"language": "ar", "task": "transcribe"})
    return out["text"].strip()


def _to_ogg(y, sr, tmp):
    wav, ogg = tmp + ".out.wav", tmp + ".out.ogg"
    sf.write(wav, y, sr, subtype="PCM_16")
    subprocess.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-i", wav, "-c:a", "libopus", "-b:a", "48k", ogg],
                   check=True, timeout=120)
    return base64.b64encode(open(ogg, "rb").read()).decode()


def _speak(text, ref_bytes, ref_text, language, tmp):
    ref = _speech_only(_decode(ref_bytes, tmp + "_ref"), MAX_REF_S)
    ref_wav = tmp + "_ref.clean.wav"
    sf.write(ref_wav, ref, SR, subtype="PCM_16")
    key = hashlib.sha256(ref.tobytes()).hexdigest()
    if not ref_text:
        ref_text = _ref_text_cache.get(key) or _asr(ref)
        _ref_text_cache[key] = ref_text
    tts = _models["tts"]
    y = tts.generate(text=text, language=language, ref_audio=ref_wav, ref_text=ref_text)
    y = np.asarray(y[0] if isinstance(y, list) else y, dtype=np.float32).squeeze()
    sr = getattr(tts, "sampling_rate", None) or 24000
    return _to_ogg(y / max(1e-6, float(np.abs(y).max())) * 0.9, sr, tmp), len(y) / sr


def predict(text, ref_b64, ref_text="", language="apc", secret=""):
    """The API function. Returns a JSON string so the caller gets audio + metadata in one field."""
    if not SECRET:
        raise gr.Error("ENGINE_SECRET is not configured")
    if not secret or not hmac.compare_digest(str(secret).encode(), SECRET.encode()):
        raise gr.Error("bad secret")
    text = (text or "").strip()
    if not text or len(text) > MAX_TEXT:
        raise gr.Error(f"text must be 1-{MAX_TEXT} characters")
    if not ref_b64:
        raise gr.Error("missing reference audio")
    try:
        ref_bytes = base64.b64decode(ref_b64)
    except Exception:
        raise gr.Error("reference audio is not valid base64")
    with _lock, tempfile.TemporaryDirectory() as d:
        t0 = time.time()
        _load()
        audio, secs = _speak(text, ref_bytes, (ref_text or "").strip(), language or "apc", os.path.join(d, "j"))
        return json.dumps({"audio_b64": audio, "format": "ogg/opus", "seconds": round(secs, 1),
                           "took": round(time.time() - t0, 1)})


print("voise-engine: downloading models…", flush=True)
_ensure_models()
print("voise-engine: models ready", flush=True)

demo = gr.Interface(
    fn=predict,
    inputs=[
        gr.Textbox(label="text"),
        gr.Textbox(label="ref_b64"),
        gr.Textbox(label="ref_text", value=""),
        gr.Textbox(label="language", value="apc"),
        gr.Textbox(label="secret", type="password"),
    ],
    outputs=gr.Textbox(label="result"),
    title="voise-engine",
    description="Consent-gated voice cloning. API only — every call needs the engine secret.",
    allow_flagging="never",
)

if __name__ == "__main__":
    demo.queue(max_size=8).launch(server_name="0.0.0.0", server_port=int(os.environ.get("PORT", 7860)))
