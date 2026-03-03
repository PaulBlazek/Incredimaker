from __future__ import annotations

import argparse
from pathlib import Path

from incredimaker.separator import separate_to_characters


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="incredimaker",
        description="Split a song into distinct character parts for Incredibox-style remixing.",
    )
    parser.add_argument("input_audio", type=Path, help="Path to input audio file.")
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("output"),
        help="Output directory for separated character stems.",
    )
    parser.add_argument(
        "--model",
        type=str,
        default="htdemucs",
        help="Demucs model to use (default: htdemucs).",
    )
    parser.add_argument(
        "--crossover-hz",
        type=float,
        default=1800.0,
        help="Frequency (Hz) that splits harmony (below) and melody (above).",
    )
    parser.add_argument(
        "--characters-per-role",
        type=int,
        default=5,
        help="Number of character clips to create for each role (default: 5).",
    )
    parser.add_argument(
        "--loop-seconds",
        type=float,
        default=None,
        help="Manual loop duration in seconds. Overrides auto detection.",
    )
    parser.add_argument(
        "--loop-beats",
        type=int,
        default=None,
        help="Manual loop length in beats at detected tempo. Ignored if --loop-seconds is set.",
    )
    parser.add_argument(
        "--auto-min-loop-seconds",
        type=float,
        default=6.0,
        help="Lower bound for auto-detected loop length in seconds (default: 6.0).",
    )
    parser.add_argument(
        "--auto-max-loop-seconds",
        type=float,
        default=16.0,
        help="Upper bound for auto-detected loop length in seconds (default: 16.0).",
    )
    return parser


def main() -> None:
    args = build_parser().parse_args()
    if args.loop_seconds is not None and args.loop_beats is not None:
        raise SystemExit("Use either --loop-seconds or --loop-beats, not both.")
    if args.auto_min_loop_seconds > args.auto_max_loop_seconds:
        raise SystemExit("--auto-min-loop-seconds must be <= --auto-max-loop-seconds.")

    outputs = separate_to_characters(
        input_audio=args.input_audio,
        output_dir=args.output_dir,
        model=args.model,
        crossover_hz=args.crossover_hz,
        characters_per_role=args.characters_per_role,
        manual_loop_seconds=args.loop_seconds,
        manual_loop_beats=args.loop_beats,
        auto_min_loop_seconds=args.auto_min_loop_seconds,
        auto_max_loop_seconds=args.auto_max_loop_seconds,
    )
    for char_id, path in sorted(outputs.items()):
        print(f"{char_id}: {path}")


if __name__ == "__main__":
    main()
