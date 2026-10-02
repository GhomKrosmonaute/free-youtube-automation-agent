#!/usr/bin/env python3
"""Local open-source narration bridge for the YouTube agent.

Usage: tts_bridge.py --engine kokoro|chatterbox --text-file IN.txt --out OUT.wav
       [--lang fr] [--voice ff_siwis] [--ref-audio clip.wav] [--speed 1.0] [--device auto]
Reads plain text, writes a 24 kHz mono WAV. Prints JSON with duration on stdout.
"""
import argparse, json, re, sys, time
import numpy as np
import soundfile as sf

KOKORO_LANG = {"fr": "f", "en": "a", "es": "e", "it": "i", "pt": "p", "hi": "h", "ja": "j", "zh": "z"}


def chunk_text(text, max_chars):
    text = re.sub(r"\[[^\]]*\]", " ", text)          # drop stage directions
    text = re.sub(r"[ \t]+", " ", text)
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n+", text) if p.strip()]
    chunks = []
    for paragraph in paragraphs:
        sentences = re.split(r"(?<=[.!?…])\s+", paragraph.replace("\n", " "))
        current = ""
        for sentence in sentences:
            if not sentence:
                continue
            if current and len(current) + len(sentence) + 1 > max_chars:
                chunks.append(current)
                current = sentence
            else:
                current = f"{current} {sentence}".strip()
        if current:
            chunks.append(current)
    return chunks


def silence(seconds, sr):
    return np.zeros(int(seconds * sr), dtype=np.float32)


def run_kokoro(args, text):
    from kokoro import KPipeline
    pipeline = KPipeline(lang_code=KOKORO_LANG.get(args.lang, args.lang), repo_id="hexgrad/Kokoro-82M")
    sr = 24000
    parts = []
    for chunk in chunk_text(text, 400):
        for _, _, audio in pipeline(chunk, voice=args.voice, speed=args.speed, split_pattern=r"\n+"):
            arr = audio.detach().cpu().numpy() if hasattr(audio, "detach") else np.asarray(audio)
            parts.append(arr.astype(np.float32))
            parts.append(silence(0.12, sr))
        parts.append(silence(0.35, sr))
    return np.concatenate(parts), sr


def run_chatterbox(args, text):
    import torch
    from chatterbox.mtl_tts import ChatterboxMultilingualTTS
    device = args.device
    if device == "auto":
        device = "mps" if torch.backends.mps.is_available() else ("cuda" if torch.cuda.is_available() else "cpu")
    model = ChatterboxMultilingualTTS.from_pretrained(device=device)
    sr = model.sr
    parts = []
    kwargs = {"language_id": args.lang}
    if args.ref_audio:
        kwargs["audio_prompt_path"] = args.ref_audio
    if args.exaggeration is not None:
        kwargs["exaggeration"] = args.exaggeration
    if args.cfg_weight is not None:
        kwargs["cfg_weight"] = args.cfg_weight
    chunks = chunk_text(text, 260)
    for index, chunk in enumerate(chunks):
        wav = model.generate(chunk, **kwargs)
        arr = wav.squeeze().detach().cpu().numpy().astype(np.float32)
        parts.append(arr)
        parts.append(silence(0.3 if not chunk.endswith(("?", "!")) else 0.4, sr))
        print(json.dumps({"progress": index + 1, "total": len(chunks)}), file=sys.stderr, flush=True)
    return np.concatenate(parts), sr


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--engine", required=True, choices=["kokoro", "chatterbox"])
    parser.add_argument("--text-file", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--lang", default="fr")
    parser.add_argument("--voice", default="ff_siwis")
    parser.add_argument("--ref-audio", default=None)
    parser.add_argument("--speed", type=float, default=1.0)
    parser.add_argument("--device", default="auto")
    parser.add_argument("--exaggeration", type=float, default=None)
    parser.add_argument("--cfg-weight", type=float, default=None)
    args = parser.parse_args()
    with open(args.text_file, encoding="utf-8") as handle:
        text = handle.read()
    if not text.strip():
        sys.exit("empty narration text")
    started = time.time()
    audio, sr = run_kokoro(args, text) if args.engine == "kokoro" else run_chatterbox(args, text)
    peak = float(np.max(np.abs(audio))) or 1.0
    if peak > 0.98:
        audio = audio / peak * 0.95
    sf.write(args.out, audio, sr)
    print(json.dumps({"engine": args.engine, "seconds": round(len(audio) / sr, 2), "sampleRate": sr, "elapsed": round(time.time() - started, 1)}))


if __name__ == "__main__":
    main()
