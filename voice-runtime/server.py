"""Local-only Kokoro HTTP adapter used by software-factory."""
import io
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import soundfile as sf
from kokoro_onnx import Kokoro

HOST = "127.0.0.1"
PORT = int(os.environ.get("SF_KOKORO_PORT", "49637"))
MODEL = os.environ["SF_KOKORO_MODEL_PATH"]
VOICES = os.environ["SF_KOKORO_VOICES_PATH"]
DEFAULT_VOICE = os.environ.get("SF_KOKORO_VOICE", "af_heart")

kokoro = Kokoro(MODEL, VOICES)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, _format, *_args):
        return

    def send_json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/healthz":
            self.send_json(200, {"ok": True})
        else:
            self.send_json(404, {"error": "not found"})

    def do_POST(self):
        if self.path == "/shutdown":
            self.send_json(200, {"ok": True})
            threading.Thread(target=self.server.shutdown, daemon=True).start()
            return
        if self.path != "/v1/audio/speech":
            self.send_json(404, {"error": "not found"})
            return
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if size > 64 * 1024:
                self.send_json(413, {"error": "request too large"})
                return
            request = json.loads(self.rfile.read(size))
            text = str(request.get("input", "")).strip()
            if not text or len(text) > 20_000:
                self.send_json(400, {"error": "input must contain 1-20000 characters"})
                return
            samples, sample_rate = kokoro.create(
                text,
                voice=str(request.get("voice", DEFAULT_VOICE)),
                speed=float(request.get("speed", 1.0)),
                lang=str(request.get("lang", "en-us")),
            )
            audio = io.BytesIO()
            sf.write(audio, samples, sample_rate, format="WAV", subtype="PCM_16")
            body = audio.getvalue()
            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except Exception as error:
            self.send_json(500, {"error": str(error)[:500]})


ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
