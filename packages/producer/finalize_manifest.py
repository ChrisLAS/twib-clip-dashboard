#!/usr/bin/env python3
"""Create an importable local manifest after an authorized uploader provides a receipt.
Does not upload, authenticate, or append the Sheet. Worker independently verifies Drive.
"""
import argparse
import copy
import json
import os
import tempfile
from pathlib import Path
import re
import sys
from producer import Blocked, canonical, digest, regular


def finalize(bundle_path, receipt):
    regular(bundle_path)
    for parent in bundle_path.absolute().parents:
        if parent.is_symlink():
            raise Blocked("Symlink bundle directory refused")
    state_path = regular(bundle_path.parent / "state.json")
    state = json.loads(state_path.read_text())
    checkpoint = state.get("checkpoints", {}).get("bundle", {})
    if state.get("status") != "ready" or checkpoint.get("sha256") != digest(bundle_path) or checkpoint.get("size") != bundle_path.stat().st_size:
        raise Blocked("Bundle is not a verified completed checkpoint")
    bundle = json.loads(bundle_path.read_text())
    artifact = bundle["artifact"]
    if artifact["path"] != "render.mp4":
        raise Blocked("Unexpected artifact filename")
    media = regular(bundle_path.parent / "render.mp4")
    if digest(media) != artifact["sha256"] or media.stat().st_size != artifact["size"]:
        raise Blocked("Bundle artifact fingerprint mismatch")
    if receipt.get("sha256") != artifact["sha256"] or receipt.get("size") != artifact["size"]:
        raise Blocked("Upload receipt must identify these exact output bytes")
    if not re.fullmatch(r"[a-zA-Z0-9_-]{1,120}", receipt.get("fileId", "")):
        raise Blocked("Invalid Drive file ID in upload receipt")
    manifest = copy.deepcopy(bundle["manifestTemplate"])
    manifest["artifacts"] = [{"renderId": artifact["renderId"], "kind": "original", "fileId": receipt["fileId"], "size": artifact["size"], "sha256": artifact["sha256"]}]
    return manifest


def publish_manifest(path, manifest):
    """Publish exactly once without replacing any existing file, even under races."""
    path = path.absolute()
    if any(parent.is_symlink() for parent in [path, *path.parents]):
        raise Blocked("Symlink manifest output refused")
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="wb", prefix=".manifest-", suffix=".tmp", dir=path.parent, delete=False) as output:
            temporary = Path(output.name)
            output.write(canonical(manifest) + b"\n")
            output.flush()
            os.fsync(output.fileno())
        try:
            # Unlike replace(), link() fails atomically if another publisher won.
            os.link(temporary, path, follow_symlinks=False)
        except FileExistsError as e:
            raise Blocked("Manifest output already exists; choose a new filename") from e
        fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bundle", type=Path)
    parser.add_argument("receipt", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    try:
        manifest = finalize(args.bundle, json.loads(args.receipt.read_text()))
        # Never overwrite bundle/checkpoints, export destinations, or sibling files.
        publish_manifest(args.out, manifest)
        print(json.dumps({"status": "manifest_exported_locally", "path": str(args.out)}))
        return 0
    except Exception as e:
        print(json.dumps({"status": "blocked", "reason": str(e)}), file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
