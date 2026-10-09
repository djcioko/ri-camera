#!/usr/bin/env python3
"""Install the pinned model once; never used by an offline worker at runtime."""
import argparse
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ri_subtitles.worker import (MODEL_FILES, MODEL_REPO, MODEL_REVISION, MODEL_SHA256,
                                 MODEL_SIZE, atomic_json, sha256_file, verify_model)


def public_model_permissions(directory):
    # These are public model weights, never uploaded media. The sudo installer
    # must leave them readable by the unprivileged, read-only runtime service.
    for name in (*MODEL_FILES, 'model-manifest.json'):
        (directory / name).chmod(0o644)
    directory.chmod(0o755)


def download_model(destination):
    destination = Path(destination).resolve()
    if destination.exists():
        # An existing complete verified installation is idempotent; do not silently
        # overwrite unexpected files or an interrupted installation.
        verify_model(destination)
        public_model_permissions(destination)
        return
    destination.parent.mkdir(parents=True, exist_ok=True)
    if shutil.disk_usage(destination.parent).free < MODEL_SIZE * 2 + 2 * 1024**3:
        raise RuntimeError('Insufficient free space for model installation and reserve.')
    from huggingface_hub import hf_hub_download
    staging = Path(tempfile.mkdtemp(prefix='.ri-model-', dir=destination.parent))
    try:
        files = {}
        for name in MODEL_FILES:
            path = Path(hf_hub_download(repo_id=MODEL_REPO, filename=name, revision=MODEL_REVISION,
                                        local_dir=staging, token=False))
            size = path.stat().st_size
            if path.is_symlink() or size <= 0:
                raise RuntimeError(f'Invalid model file: {name}')
            if name == 'model.bin' and size != MODEL_SIZE:
                raise RuntimeError('Unexpected model.bin size.')
            if name != 'model.bin':
                json.loads(path.read_text(encoding='utf-8'))
            digest = sha256_file(path)
            if name == 'model.bin' and digest != MODEL_SHA256:
                raise RuntimeError('Unexpected model.bin SHA-256.')
            files[name] = {'size': size, 'sha256': digest}
        atomic_json(staging / 'model-manifest.json', {'repoId': MODEL_REPO, 'revision': MODEL_REVISION, 'files': files})
        verify_model(staging)
        public_model_permissions(staging)
        # The readiness manifest and its files become visible together.
        os.rename(staging, destination)
    finally:
        if staging.exists():
            shutil.rmtree(staging)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model-dir', required=True, type=Path)
    args = parser.parse_args()
    try:
        download_model(args.model_dir)
    except Exception as error:
        parser.exit(1, f'Model installation failed: {error}\n')
    print(f'Verified model revision {MODEL_REVISION}.')


if __name__ == '__main__':
    main()
