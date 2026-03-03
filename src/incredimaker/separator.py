from __future__ import annotations

import json
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from tempfile import TemporaryDirectory

import librosa
import numpy as np
import soundfile as sf


STEM_NAMES = ("drums", "bass", "other", "vocals")
ROLE_ORDER = ("beat", "bass", "fx", "harmony", "melody", "vocals")


@dataclass
class LoopInfo:
    tempo_bpm: float
    loop_beats: int
    loop_seconds: float
    loop_samples: int


def _run_demucs(input_audio: Path, model: str, tmp_root: Path) -> Path:
    cmd = [
        sys.executable,
        "-m",
        "demucs.separate",
        "-n",
        model,
        "--out",
        str(tmp_root),
        str(input_audio),
    ]
    subprocess.run(cmd, check=True)

    model_dir = tmp_root / model
    candidates = sorted(model_dir.iterdir())
    if not candidates:
        raise RuntimeError(
            f"Demucs did not produce output in {model_dir}. "
            "Check model name and input file format."
        )
    return candidates[0]


def _load_stem(path: Path) -> tuple[np.ndarray, int]:
    audio, sr = librosa.load(path, sr=None, mono=False)
    if audio.ndim == 1:
        audio = np.expand_dims(audio, axis=0)
    return audio.astype(np.float32), sr


def _hard_hpss_split(audio: np.ndarray, n_fft: int = 4096, hop_length: int = 1024) -> tuple[np.ndarray, np.ndarray]:
    harmonics: list[np.ndarray] = []
    percussives: list[np.ndarray] = []

    for channel in audio:
        stft = librosa.stft(channel, n_fft=n_fft, hop_length=hop_length)
        magnitude = np.abs(stft)
        h_mask, p_mask = librosa.decompose.hpss(magnitude, mask=True)
        h_hard = h_mask >= p_mask

        h_stft = stft * h_hard
        p_stft = stft * (~h_hard)

        harmonics.append(librosa.istft(h_stft, hop_length=hop_length, length=channel.shape[0]))
        percussives.append(librosa.istft(p_stft, hop_length=hop_length, length=channel.shape[0]))

    return np.stack(harmonics).astype(np.float32), np.stack(percussives).astype(np.float32)


def _split_harmonic_bands(
    harmonic_audio: np.ndarray,
    sr: int,
    crossover_hz: float,
    n_fft: int = 4096,
    hop_length: int = 1024,
) -> tuple[np.ndarray, np.ndarray]:
    lows: list[np.ndarray] = []
    highs: list[np.ndarray] = []
    freqs = librosa.fft_frequencies(sr=sr, n_fft=n_fft)
    low_band = (freqs <= crossover_hz).astype(np.float32)[:, np.newaxis]
    high_band = (freqs > crossover_hz).astype(np.float32)[:, np.newaxis]

    for channel in harmonic_audio:
        stft = librosa.stft(channel, n_fft=n_fft, hop_length=hop_length)
        low_stft = stft * low_band
        high_stft = stft * high_band
        lows.append(librosa.istft(low_stft, hop_length=hop_length, length=channel.shape[0]))
        highs.append(librosa.istft(high_stft, hop_length=hop_length, length=channel.shape[0]))

    return np.stack(lows).astype(np.float32), np.stack(highs).astype(np.float32)


def _save_audio(path: Path, audio: np.ndarray, sr: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(path, audio.T, sr, subtype="PCM_16")


def _estimate_loop_info(reference_audio: np.ndarray, sr: int) -> LoopInfo:
    mono = np.mean(reference_audio, axis=0)
    onset_env = librosa.onset.onset_strength(y=mono, sr=sr)
    tempo_candidates = librosa.feature.tempo(onset_envelope=onset_env, sr=sr, aggregate=None)
    if np.size(tempo_candidates):
        tempo_bpm = float(np.median(tempo_candidates))
    else:
        tempo, _ = librosa.beat.beat_track(y=mono, sr=sr, trim=False)
        tempo_bpm = float(np.atleast_1d(tempo)[0]) if np.size(tempo) else 120.0
    if tempo_bpm <= 0:
        tempo_bpm = 120.0

    # Beat trackers often return double/half tempo. Bring into a practical range.
    while tempo_bpm > 165.0:
        tempo_bpm /= 2.0
    while tempo_bpm < 70.0:
        tempo_bpm *= 2.0

    _, beat_frames = librosa.beat.beat_track(y=mono, sr=sr, trim=False, bpm=tempo_bpm)

    candidate_beats = [8, 12, 16, 24, 32]
    best_beats = 16

    if len(beat_frames) > 16:
        chroma = librosa.feature.chroma_cqt(y=mono, sr=sr)
        beat_chroma = librosa.util.sync(chroma, beat_frames, aggregate=np.median)
        norms = np.linalg.norm(beat_chroma, axis=0, keepdims=True) + 1e-8
        beat_chroma = beat_chroma / norms
        usable = beat_chroma.shape[1]

        best_score = -1e9
        for beats in candidate_beats:
            if usable <= beats + 2:
                continue
            left = beat_chroma[:, :-beats]
            right = beat_chroma[:, beats:]
            cosine = np.sum(left * right, axis=0)
            # Favor strong repetition while avoiding tiny loops.
            score = float(np.mean(cosine)) + beats * 0.005
            if score > best_score:
                best_score = score
                best_beats = beats

    seconds_per_beat = 60.0 / tempo_bpm
    loop_seconds = best_beats * seconds_per_beat
    loop_samples = max(int(round(loop_seconds * sr)), sr)

    total_samples = reference_audio.shape[1]
    while loop_samples * 2 > total_samples and best_beats > 4:
        best_beats //= 2
        loop_seconds = best_beats * seconds_per_beat
        loop_samples = max(int(round(loop_seconds * sr)), sr)

    if total_samples < loop_samples:
        loop_samples = total_samples
        loop_seconds = total_samples / sr

    return LoopInfo(
        tempo_bpm=tempo_bpm,
        loop_beats=best_beats,
        loop_seconds=loop_seconds,
        loop_samples=loop_samples,
    )


def _loop_info_with_overrides(
    reference_audio: np.ndarray,
    sr: int,
    manual_loop_seconds: float | None,
    manual_loop_beats: int | None,
    auto_min_loop_seconds: float,
    auto_max_loop_seconds: float,
) -> LoopInfo:
    detected = _estimate_loop_info(reference_audio=reference_audio, sr=sr)
    total_samples = reference_audio.shape[1]

    if manual_loop_seconds is not None:
        loop_seconds = max(manual_loop_seconds, 0.5)
        loop_samples = min(max(int(round(loop_seconds * sr)), 1), total_samples)
        return LoopInfo(
            tempo_bpm=detected.tempo_bpm,
            loop_beats=detected.loop_beats,
            loop_seconds=loop_samples / sr,
            loop_samples=loop_samples,
        )

    if manual_loop_beats is not None:
        loop_seconds = max((60.0 / detected.tempo_bpm) * manual_loop_beats, 0.5)
        loop_samples = min(max(int(round(loop_seconds * sr)), 1), total_samples)
        return LoopInfo(
            tempo_bpm=detected.tempo_bpm,
            loop_beats=manual_loop_beats,
            loop_seconds=loop_samples / sr,
            loop_samples=loop_samples,
        )

    min_s = max(auto_min_loop_seconds, 0.5)
    max_s = max(auto_max_loop_seconds, min_s)
    seconds_per_beat = 60.0 / detected.tempo_bpm
    beats = detected.loop_beats
    loop_seconds = beats * seconds_per_beat

    # Keep loop size in user-configurable practical bounds.
    while loop_seconds < min_s and beats < 64:
        beats *= 2
        loop_seconds = beats * seconds_per_beat
    while loop_seconds > max_s and beats > 4:
        beats //= 2
        loop_seconds = beats * seconds_per_beat

    loop_samples = min(max(int(round(loop_seconds * sr)), 1), total_samples)
    return LoopInfo(
        tempo_bpm=detected.tempo_bpm,
        loop_beats=beats,
        loop_seconds=loop_samples / sr,
        loop_samples=loop_samples,
    )


def _extract_clip(audio: np.ndarray, start: int, length: int) -> np.ndarray:
    end = start + length
    if end <= audio.shape[1]:
        return audio[:, start:end].copy()
    clip = np.zeros((audio.shape[0], length), dtype=np.float32)
    available = max(audio.shape[1] - start, 0)
    if available > 0:
        clip[:, :available] = audio[:, start:start + available]
    return clip


def _pick_loop_indices(audio: np.ndarray, loop_samples: int, count: int) -> list[int]:
    total_samples = audio.shape[1]
    n_loops = max(total_samples // loop_samples, 1)
    energies: list[tuple[float, int]] = []
    for idx in range(n_loops):
        start = idx * loop_samples
        end = min(start + loop_samples, total_samples)
        seg = audio[:, start:end]
        if seg.size == 0:
            energy = 0.0
        else:
            energy = float(np.sqrt(np.mean(np.square(seg))))
        energies.append((energy, idx))

    energies.sort(key=lambda item: item[0], reverse=True)
    selected: list[int] = [idx for _, idx in energies[:count] if _ > 1e-5]
    if not selected:
        selected = [0]

    while len(selected) < count:
        selected.append(selected[len(selected) % len(selected)])
    return selected[:count]


def _loop_multiple_for(role: str, index: int, available_loops: int, loop_index: int) -> int:
    if role in {"melody", "harmony", "vocals"} and index in {2, 4} and available_loops >= loop_index + 2:
        return 2
    return 1


def separate_to_characters(
    input_audio: Path,
    output_dir: Path,
    model: str = "htdemucs",
    crossover_hz: float = 1800.0,
    characters_per_role: int = 5,
    manual_loop_seconds: float | None = None,
    manual_loop_beats: int | None = None,
    auto_min_loop_seconds: float = 6.0,
    auto_max_loop_seconds: float = 16.0,
) -> dict[str, Path]:
    if not input_audio.exists():
        raise FileNotFoundError(f"Input file not found: {input_audio}")

    output_dir.mkdir(parents=True, exist_ok=True)
    characters_dir = output_dir / "characters"
    characters_dir.mkdir(parents=True, exist_ok=True)

    with TemporaryDirectory(prefix="incredimaker_") as tmp:
        tmp_root = Path(tmp)
        demucs_song_dir = _run_demucs(input_audio=input_audio, model=model, tmp_root=tmp_root)

        loaded: dict[str, np.ndarray] = {}
        target_sr: int | None = None
        max_len = 0

        for stem_name in STEM_NAMES:
            stem_path = demucs_song_dir / f"{stem_name}.wav"
            audio, sr = _load_stem(stem_path)
            loaded[stem_name] = audio
            target_sr = sr if target_sr is None else target_sr
            if sr != target_sr:
                raise RuntimeError(f"Sample rate mismatch for {stem_name}: {sr} != {target_sr}")
            max_len = max(max_len, audio.shape[1])

        for key, audio in loaded.items():
            if audio.shape[1] < max_len:
                pad_width = max_len - audio.shape[1]
                loaded[key] = np.pad(audio, ((0, 0), (0, pad_width)))

        assert target_sr is not None
        harmonic_other, percussive_other = _hard_hpss_split(loaded["other"])
        harmony, melody = _split_harmonic_bands(harmonic_other, sr=target_sr, crossover_hz=crossover_hz)

        stems = {
            "beat": loaded["drums"],
            "bass": loaded["bass"],
            "harmony": harmony,
            "melody": melody,
            "fx": percussive_other,
            "vocals": loaded["vocals"],
        }

        full_mix = sum(stems.values())
        loop_info = _loop_info_with_overrides(
            reference_audio=full_mix,
            sr=target_sr,
            manual_loop_seconds=manual_loop_seconds,
            manual_loop_beats=manual_loop_beats,
            auto_min_loop_seconds=auto_min_loop_seconds,
            auto_max_loop_seconds=auto_max_loop_seconds,
        )
        n_loops = max(max_len // loop_info.loop_samples, 1)

        outputs: dict[str, Path] = {}
        manifest_characters: list[dict[str, object]] = []
        for role in ROLE_ORDER:
            audio = stems[role]
            loop_indices = _pick_loop_indices(audio, loop_info.loop_samples, characters_per_role)
            for i, loop_idx in enumerate(loop_indices, start=1):
                loop_multiple = _loop_multiple_for(role, i, n_loops, loop_idx)
                start = loop_idx * loop_info.loop_samples
                length = loop_info.loop_samples * loop_multiple
                clip = _extract_clip(audio, start=start, length=length)

                character_id = f"{role}_{i:02d}"
                stem_out = characters_dir / role / f"{character_id}.wav"
                _save_audio(stem_out, clip, target_sr)
                outputs[character_id] = stem_out
                manifest_characters.append(
                    {
                        "id": character_id,
                        "role": role,
                        "file": str(stem_out.relative_to(output_dir).as_posix()),
                        "loop_multiple": loop_multiple,
                        "source_loop_index": int(loop_idx),
                    }
                )

        manifest = {
            "format_version": 2,
            "input_file": str(input_audio.resolve()),
            "model": model,
            "sample_rate": target_sr,
            "crossover_hz": crossover_hz,
            "loop": {
                "tempo_bpm": loop_info.tempo_bpm,
                "beats": loop_info.loop_beats,
                "seconds": loop_info.loop_seconds,
                "samples": loop_info.loop_samples,
                "manual_seconds": manual_loop_seconds,
                "manual_beats": manual_loop_beats,
                "auto_min_seconds": auto_min_loop_seconds,
                "auto_max_seconds": auto_max_loop_seconds,
            },
            "characters_per_role": characters_per_role,
            "characters": manifest_characters,
        }
        manifest_path = output_dir / "manifest.json"
        manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")

        return outputs
