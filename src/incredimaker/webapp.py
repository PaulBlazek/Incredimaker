from __future__ import annotations

import argparse
import base64
import io
import hashlib
import json
import re
import zipfile
from dataclasses import dataclass
from pathlib import Path

from flask import Flask, abort, jsonify, render_template, request, send_file


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
    module_dir: Path
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
                module_dir=manifest.parent.resolve(),
                manifest_path=manifest,
                loop_seconds=max(loop_seconds, 0.5),
                characters=parsed,
            )
        except (json.JSONDecodeError, OSError):
            continue
    return boxes


def _customization_path(module_dir: Path) -> Path:
    return module_dir / "module.custom.json"


def _sanitize_name(name: str) -> str:
    return re.sub(r"[^a-zA-Z0-9_\-]", "_", name)


def _decode_data_url(data_url: str) -> tuple[bytes, str]:
    match = re.match(r"^data:(image/[a-zA-Z0-9.+-]+);base64,(.+)$", data_url)
    if not match:
        raise ValueError("Invalid data URL.")
    mime = match.group(1).lower()
    b64_data = match.group(2)
    raw = base64.b64decode(b64_data)
    ext_by_mime = {
        "image/png": "png",
        "image/jpeg": "jpg",
        "image/jpg": "jpg",
        "image/webp": "webp",
        "image/gif": "gif",
    }
    ext = ext_by_mime.get(mime, "png")
    return raw, ext


def _write_image_from_data_url(image_data_url: str, folder: Path, stem: str) -> str:
    raw, ext = _decode_data_url(image_data_url)
    folder.mkdir(parents=True, exist_ok=True)
    for old in folder.glob(f"{stem}.*"):
        try:
            old.unlink()
        except OSError:
            pass
    out = folder / f"{stem}.{ext}"
    out.write_bytes(raw)
    return str(out.name)


def _load_customization(rec: BoxRecord) -> dict[str, object]:
    custom_path = _customization_path(rec.module_dir)
    if not custom_path.exists():
        return {
            "hidden_ids": [],
            "role_colors": {},
            "images": {},
        }

    try:
        data = json.loads(custom_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {
            "hidden_ids": [],
            "role_colors": {},
            "images": {},
        }

    images_out: dict[str, dict[str, object]] = {}
    for char_id, img_cfg in (data.get("images") or {}).items():
        if not isinstance(char_id, str) or not isinstance(img_cfg, dict):
            continue
        palette_rel = img_cfg.get("palette_file")
        stage_rel = img_cfg.get("stage_file")
        separate_stage = bool(img_cfg.get("separate_stage", False))

        palette_url = None
        stage_url = None
        if isinstance(palette_rel, str) and (rec.module_dir / palette_rel).exists():
            palette_url = f"/api/boxes/{rec.box_id}/assets/{palette_rel}"
        if isinstance(stage_rel, str) and (rec.module_dir / stage_rel).exists():
            stage_url = f"/api/boxes/{rec.box_id}/assets/{stage_rel}"

        if palette_url or stage_url:
            images_out[char_id] = {
                "palette": palette_url,
                "stage": stage_url,
                "separateStage": separate_stage,
            }

    return {
        "hidden_ids": [x for x in (data.get("hidden_ids") or []) if isinstance(x, str)],
        "role_colors": data.get("role_colors") if isinstance(data.get("role_colors"), dict) else {},
        "images": images_out,
    }


def _save_customization(rec: BoxRecord, payload: dict[str, object]) -> None:
    assets_dir = rec.module_dir / "assets"
    palette_dir = assets_dir / "palette"
    stage_dir = assets_dir / "stage"
    hidden_ids = [x for x in (payload.get("hiddenIds") or []) if isinstance(x, str)]
    role_colors = payload.get("roleColors") if isinstance(payload.get("roleColors"), dict) else {}
    raw_images = payload.get("images") if isinstance(payload.get("images"), dict) else {}

    images_for_file: dict[str, dict[str, object]] = {}
    for char_id, cfg in raw_images.items():
        if not isinstance(char_id, str) or not isinstance(cfg, dict):
            continue
        safe_id = _sanitize_name(char_id)

        palette_value = cfg.get("palette")
        stage_value = cfg.get("stage")
        separate_stage = bool(cfg.get("separateStage", False))

        palette_file_rel: str | None = None
        stage_file_rel: str | None = None

        if isinstance(palette_value, str):
            if palette_value.startswith("data:image/"):
                file_name = _write_image_from_data_url(palette_value, palette_dir, safe_id)
                palette_file_rel = f"assets/palette/{file_name}"
            elif palette_value.startswith("/api/boxes/"):
                # Keep existing file reference if already persisted.
                found = next((p for p in palette_dir.glob(f"{safe_id}.*")), None)
                if found:
                    palette_file_rel = f"assets/palette/{found.name}"

        if separate_stage and isinstance(stage_value, str):
            if stage_value.startswith("data:image/"):
                file_name = _write_image_from_data_url(stage_value, stage_dir, safe_id)
                stage_file_rel = f"assets/stage/{file_name}"
            elif stage_value.startswith("/api/boxes/"):
                found = next((p for p in stage_dir.glob(f"{safe_id}.*")), None)
                if found:
                    stage_file_rel = f"assets/stage/{found.name}"
        else:
            for old in stage_dir.glob(f"{safe_id}.*"):
                try:
                    old.unlink()
                except OSError:
                    pass

        if palette_file_rel:
            images_for_file[char_id] = {
                "separate_stage": bool(separate_stage and stage_file_rel),
                "palette_file": palette_file_rel,
                "stage_file": stage_file_rel,
            }

    out = {
        "format_version": 1,
        "hidden_ids": hidden_ids,
        "role_colors": role_colors,
        "images": images_for_file,
    }
    _customization_path(rec.module_dir).write_text(json.dumps(out, indent=2), encoding="utf-8")


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

    @app.get("/api/boxes/<box_id>/customization")
    def get_customization(box_id: str):
        boxes = current_boxes()
        rec = boxes.get(box_id)
        if not rec:
            abort(404, description="Box not found.")
        return jsonify(_load_customization(rec))

    @app.post("/api/boxes/<box_id>/customization")
    def set_customization(box_id: str):
        boxes = current_boxes()
        rec = boxes.get(box_id)
        if not rec:
            abort(404, description="Box not found.")
        payload = request.get_json(silent=True) or {}
        if not isinstance(payload, dict):
            abort(400, description="Invalid JSON payload.")
        _save_customization(rec, payload)
        return jsonify(_load_customization(rec))

    @app.get("/api/boxes/<box_id>/assets/<path:rel_path>")
    def get_asset(box_id: str, rel_path: str):
        boxes = current_boxes()
        rec = boxes.get(box_id)
        if not rec:
            abort(404, description="Box not found.")
        target = (rec.module_dir / rel_path).resolve()
        try:
            target.relative_to(rec.module_dir.resolve())
        except ValueError:
            abort(403, description="Invalid asset path.")
        if not target.exists():
            abort(404, description="Asset not found.")
        return send_file(str(target))

    @app.get("/api/boxes/<box_id>/export")
    def export_box(box_id: str):
        boxes = current_boxes()
        rec = boxes.get(box_id)
        if not rec:
            abort(404, description="Box not found.")

        mem = io.BytesIO()
        with zipfile.ZipFile(mem, mode="w", compression=zipfile.ZIP_DEFLATED) as zf:
            base_name = rec.module_dir.name
            for file_path in rec.module_dir.rglob("*"):
                if file_path.is_file():
                    arcname = f"{base_name}/{file_path.relative_to(rec.module_dir).as_posix()}"
                    zf.write(file_path, arcname=arcname)
        mem.seek(0)
        safe_name = _sanitize_name(rec.name) or "incredibox_module"
        return send_file(
            mem,
            mimetype="application/zip",
            as_attachment=True,
            download_name=f"{safe_name}.zip",
        )

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
