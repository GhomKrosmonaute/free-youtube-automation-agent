#!/usr/bin/env bash
# Installs every local engine the agent needs on a Mac (Apple Silicon):
# Homebrew tools, Ollama fallback model, Kokoro voice, Chatterbox voice (optional), Z-Image illustrations.
set -euo pipefail
cd "$(dirname "$0")/.."

command -v brew >/dev/null || { echo "Install Homebrew first: https://brew.sh"; exit 1; }
brew list --versions ffmpeg >/dev/null 2>&1 || brew install ffmpeg
brew list --versions espeak-ng >/dev/null 2>&1 || brew install espeak-ng
brew list --versions ollama >/dev/null 2>&1 || brew install ollama
brew list --versions python@3.11 >/dev/null 2>&1 || brew install python@3.11
PY="$(brew --prefix)/opt/python@3.11/bin/python3.11"

npm install --no-fund --no-audit

# Ollama fallback text model (used only when ANTHROPIC_API_KEY is absent)
(pgrep -x ollama >/dev/null || (ollama serve >/dev/null 2>&1 &)) ; sleep 2
ollama list | grep -q "qwen2.5:7b" || ollama pull qwen2.5:7b

# Kokoro (narration)
[ -d .venv-tts ] || "$PY" -m venv .venv-tts
.venv-tts/bin/pip install -q --upgrade pip
.venv-tts/bin/pip install -q "kokoro>=0.9.4" soundfile

# Z-Image Turbo via mflux (illustrations)
[ -d .venv-images ] || "$PY" -m venv .venv-images
.venv-images/bin/pip install -q --upgrade pip
.venv-images/bin/pip install -q mflux

# Chatterbox (optional voice cloning engine)
if [ "${WITH_CHATTERBOX:-0}" = "1" ]; then
  [ -d .venv-chatterbox ] || "$PY" -m venv .venv-chatterbox
  .venv-chatterbox/bin/pip install -q --upgrade pip
  .venv-chatterbox/bin/pip install -q chatterbox-tts
fi

# Warm up the models (downloads ~0.5 GB for Kokoro, ~4 GB for Z-Image 4-bit)
printf "Bonjour, ceci est un test." > /tmp/agent-warmup.txt
.venv-tts/bin/python scripts/tts/tts_bridge.py --engine kokoro --text-file /tmp/agent-warmup.txt --out /tmp/agent-warmup.wav --lang fr --voice am_onyx >/dev/null
.venv-images/bin/mflux-generate-z-image-turbo --model filipstrand/Z-Image-Turbo-mflux-4bit --steps 2 --width 512 --height 288 --seed 1 --output /tmp/agent-warmup.png --prompt "a candle" >/dev/null 2>&1 || true
echo "Local engines ready."
