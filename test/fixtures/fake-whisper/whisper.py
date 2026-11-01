"""Stand-in for openai-whisper so the worker protocol can be tested without the real model."""
import sys


class _Model:

    def __init__(self, name):
        self.name = name
        self.device = "cpu"

    def transcribe(self, path, **kwargs):
        if path.endswith(".broken"):
            raise RuntimeError("Failed to load audio")
        print("Detected language: English")  # real Whisper prints this to stdout
        sys.stderr.write("\r 50%|#####     | 1/2 [00:00<00:00]\r100%|##########| 2/2 [00:00<00:00]\n")
        with open(path, encoding="utf-8") as f:
            return {"text": " " + f.read() + " ", "language": kwargs.get("language") or "en"}


def load_model(name):
    if name == "missing":
        raise RuntimeError("Model missing not found")
    return _Model(name)
