# Incredimaker

Incredimaker is a Python CLI project that breaks one song into distinct, non-overlapping "character" parts inspired by Incredibox layering.

## What it does

Given one input song, it now outputs loop-aligned character clips:

- `beat` (drums)
- `bass`
- `fx` (percussive non-drum accents from residual stem)
- `harmony` (lower-mid harmonic content)
- `melody` (upper harmonic content)
- `vocals` (if present)

By default, it creates `5` character clips per role (30 total), each clip tied to:
- one base loop length, or
- a multiple of that loop length (for variation while staying synced)

The split uses:

1. Demucs stem separation (`drums`, `bass`, `other`, `vocals`)
2. Hard-mask spectral partitioning of the `other` stem so `melody`, `harmony`, and `fx` do not share time-frequency bins
3. Loop-length estimation from tempo + chroma repetition
4. Energy-based loop section sampling to create multiple characters per role

## Requirements

- Python 3.10+
- FFmpeg on PATH (required by Demucs for many formats)
- PyTorch / torchaudio are installed via `pip install -e .` with compatible versions

## Install

```bash
python -m venv .venv
.venv\Scripts\activate
pip install -e .
```

## Usage

```bash
incredimaker "path\to\song.mp3" --output-dir output
```

Optional flags:

- `--model`: Demucs model name (default: `htdemucs`)
- `--crossover-hz`: frequency split between `harmony` and `melody` (default: `1800`)
- `--characters-per-role`: number of characters generated per role (default: `5`)
- `--loop-seconds`: manual loop duration override in seconds
- `--loop-beats`: manual loop duration override in beats at detected tempo
- `--auto-min-loop-seconds`: lower bound for auto loop detection (default: `6`)
- `--auto-max-loop-seconds`: upper bound for auto loop detection (default: `16`)

For songs where auto detection picks loops too short, prefer a manual override:

```bash
incredimaker "path\to\song.mp3" --output-dir library\song-a --loop-seconds 7.5
```

## Output layout

```text
output/
  characters/
    beat/
      beat_01.wav
      ...
    bass/
      bass_01.wav
      ...
    fx/
      fx_01.wav
      ...
    harmony/
      harmony_01.wav
      ...
    melody/
      melody_01.wav
      ...
    vocals/
      vocals_01.wav
      ...
  manifest.json
```

## Web UI

Start a simple drag-and-drop web stage:

```bash
incredimaker-web --library-dir library --port 8000
```

Then open `http://127.0.0.1:8000`.

The web app looks for `manifest.json` files under `library/` recursively. A good pattern is one folder per song:

```text
library/
  song-a/
    manifest.json
    characters/
      beat.wav
      bass.wav
      harmony.wav
      melody.wav
      fx.wav
      vocals.wav
```

Example creation command:

```bash
incredimaker "path\to\song-a.mp3" --output-dir library\song-a
```

In the web UI:
- characters are scheduled on loop boundaries (quantized add/remove)
- active characters stay time-aligned to one transport clock
- double-clicking a stage slot mutes it on the next loop boundary
