from __future__ import annotations

import argparse
import hashlib
import json
from dataclasses import dataclass
from pathlib import Path

from flask import Flask, abort, jsonify, render_template, send_file


@dataclass
class CharacterRecord:
    char_id: str
    role: str
    path: Path
    loop_multiple: int


@dataclass
class BoxRecord:
    box_id: str
    name: str
    manifest_path: Path
    loop_seconds: float
    characters: list[CharacterRecord]


def _resolve_character_path(raw_path: str, manifest_path: Path) -> Path:
    candidate = Path(raw_path)
    if candidate.is_absolute():
        return candidate
    return (manifest_path.parent / candidate).resolve()


def _discover_boxes(library_dir: Path) -> dict[str, BoxRecord]:
    boxes: dict[str, BoxRecord] = {}
    if not library_dir.exists():
        return boxes

    for manifest in library_dir.rglob("manifest.json"):
        try:
            data = json.loads(manifest.read_text(encoding="utf-8"))
            loop_seconds = float(data.get("loop", {}).get("seconds", 4.0))
            parsed: list[CharacterRecord] = []

            # New format: "characters" is a list of metadata objects.
            raw_list = data.get("characters", [])
            if isinstance(raw_list, list):
                for item in raw_list:
                    if not isinstance(item, dict):
                        continue
                    char_id = item.get("id")
                    role = item.get("role")
                    file_path = item.get("file")
                    loop_multiple = int(item.get("loop_multiple", 1))
                    if not isinstance(char_id, str) or not isinstance(role, str) or not isinstance(file_path, str):
                        continue
                    parsed.append(
                        CharacterRecord(
                            char_id=char_id,
                            role=role,
                            path=_resolve_character_path(file_path, manifest),
                            loop_multiple=max(loop_multiple, 1),
                        )
                    )

            # Legacy format: "characters" is a dict of role -> path.
            if not parsed and isinstance(raw_list, dict):
                for role, file_path in raw_list.items():
                    if not isinstance(role, str) or not isinstance(file_path, str):
                        continue
                    parsed.append(
                        CharacterRecord(
                            char_id=f"{role}_01",
                            role=role,
                            path=_resolve_character_path(file_path, manifest),
                            loop_multiple=1,
                        )
                    )

            parsed = [c for c in parsed if c.path.exists()]
            if not parsed:
                continue
            raw_name = manifest.parent.name.strip()
            if raw_name:
                display_name = raw_name
            else:
                display_name = data.get("input_file", manifest.stem)

            box_id = hashlib.sha1(str(manifest.resolve()).encode("utf-8")).hexdigest()[:12]
            boxes[box_id] = BoxRecord(
                box_id=box_id,
                name=display_name,
                manifest_path=manifest,
                loop_seconds=max(loop_seconds, 0.5),
                characters=parsed,
            )
        except (json.JSONDecodeError, OSError):
            continue
    return boxes


def create_app(library_dir: Path) -> Flask:
    package_dir = Path(__file__).parent
    app = Flask(
        __name__,
        template_folder=str(package_dir / "web" / "templates"),
        static_folder=str(package_dir / "web" / "static"),
    )
    app.config["LIBRARY_DIR"] = library_dir.resolve()

    def current_boxes() -> dict[str, BoxRecord]:
        return _discover_boxes(Path(app.config["LIBRARY_DIR"]))

    @app.get("/")
    def index():
        return render_template("index.html")

    @app.get("/api/boxes")
    def list_boxes():
        boxes = current_boxes()
        response = [
            {
                "id": rec.box_id,
                "name": rec.name,
                "loop_seconds": rec.loop_seconds,
                "characters": [
                    {
                        "id": c.char_id,
                        "role": c.role,
                        "loop_multiple": c.loop_multiple,
                    }
                    for c in rec.characters
                ],
                "manifest_path": str(rec.manifest_path.resolve()),
            }
            for rec in boxes.values()
        ]
        response.sort(key=lambda b: b["name"].lower())
        return jsonify({"boxes": response})

    @app.get("/api/boxes/<box_id>/audio/<character_id>")
    def stream_character(box_id: str, character_id: str):
        boxes = current_boxes()
        rec = boxes.get(box_id)
        if not rec:
            abort(404, description="Box not found.")
        match = next((c for c in rec.characters if c.char_id == character_id), None)
        if match is None or not match.path.exists():
            abort(404, description="Character audio not found.")
        return send_file(str(match.path), mimetype="audio/wav")

    return app


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="incredimaker-web",
        description="Run the Incredimaker web UI for loading and arranging song characters.",
    )
    parser.add_argument(
        "--library-dir",
        type=Path,
        default=Path("library"),
        help="Directory containing separated song folders with manifest.json files.",
    )
    parser.add_argument("--host", default="127.0.0.1", help="Host to bind the web server.")
    parser.add_argument("--port", default=8000, type=int, help="Port to bind the web server.")
    args = parser.parse_args()

    app = create_app(args.library_dir)
    app.run(host=args.host, port=args.port, debug=False)


if __name__ == "__main__":
    main()
