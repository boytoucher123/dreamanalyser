"""
Dream Analyser speech-to-text worker (OpenAI Whisper).

Started by the Electron main process (src/main/transcriber.js). It loads the
Whisper model once, then transcribes audio files on request, so the model is
not reloaded for every dictation.

Protocol: one JSON object per line.
  stdin  <- {"id": "...", "path": "C:/.../dream.m4a", "language": "en" | null}
  stdout -> {"type": "ready", "model": "medium", "device": "cuda"}
            {"type": "result", "id": "...", "text": "...", "language": "en"}
            {"type": "error", "id": "...", "message": "..."}
Progress bars and any other output go to stderr.

FFmpeg must be on PATH (Whisper uses it to decode m4a/webm/mp3/...). The app
adds the "FFmpeg folder" from Settings to PATH before starting this script.
"""
import argparse
import json
import os
import shutil
import sys


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="medium")
    args = parser.parse_args()

    # Keep a private handle on the real stdout for the protocol, then point
    # everything else (Whisper's "Detected language" prints, library output,
    # even C-level writes to fd 1) at stderr so it can't corrupt the stream.
    proto = os.fdopen(os.dup(1), "w", encoding="utf-8", newline="\n")
    os.dup2(2, 1)
    sys.stdout = sys.stderr

    def send(obj):
        proto.write(json.dumps(obj, ensure_ascii=False) + "\n")
        proto.flush()

    try:
        import whisper
        import torch
    except ImportError as e:
        send({"type": "fatal", "message": f"Python could not import Whisper ({e}). Install it with: pip install -U openai-whisper"})
        return 1

    if not shutil.which("ffmpeg"):
        send({"type": "fatal", "message": "FFmpeg was not found. Set the FFmpeg folder (the one containing ffmpeg.exe, e.g. C:\\ffmpeg\\bin) in Settings."})
        return 1

    try:
        model = whisper.load_model(args.model)
    except Exception as e:  # noqa: BLE001 - report anything to the app
        send({"type": "fatal", "message": f"Could not load Whisper model '{args.model}': {e}"})
        return 1

    device = str(model.device)
    send({"type": "ready", "model": args.model, "device": device})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            job = json.loads(line)
        except json.JSONDecodeError:
            continue
        job_id = job.get("id")
        try:
            result = model.transcribe(
                job["path"],
                language=job.get("language") or None,
                fp16=device.startswith("cuda"),
                verbose=False,  # shows a progress bar on stderr, which the app reads
                condition_on_previous_text=False,  # less prone to repetition loops on rambling speech
            )
            send({"type": "result", "id": job_id, "text": (result.get("text") or "").strip(), "language": result.get("language")})
        except Exception as e:  # noqa: BLE001
            send({"type": "error", "id": job_id, "message": str(e) or e.__class__.__name__})
    return 0


if __name__ == "__main__":
    sys.exit(main())
