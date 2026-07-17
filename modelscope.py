"""Mirror a Hugging Face dataset repository to ModelScope.

The source repository is downloaded at one immutable Hugging Face commit, then
uploaded to an already-created ModelScope dataset repository without changing
its file layout.
"""

from __future__ import annotations

import argparse
import os
import shutil
import sys
from pathlib import Path


# This file is intentionally named ``modelscope.py``. Remove its directory from
# the import path so it does not shadow the third-party ``modelscope`` package.
SCRIPT_DIR = Path(__file__).resolve().parent
sys.path = [
    entry
    for entry in sys.path
    if Path(entry or os.curdir).resolve() != SCRIPT_DIR
]

HUGGINGFACE_REPO = "simon3000/zenless-voice"
MODELSCOPE_REPO = "simono/zenless-voice"
HUGGINGFACE_URL = f"https://huggingface.co/datasets/{HUGGINGFACE_REPO}"
MODELSCOPE_URL = f"https://modelscope.cn/datasets/{MODELSCOPE_REPO}"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            f"Mirror every file from {HUGGINGFACE_URL} to {MODELSCOPE_URL}."
        )
    )
    parser.add_argument(
        "--revision",
        default="main",
        help="Hugging Face branch, tag, or commit to mirror (default: main)",
    )
    parser.add_argument(
        "--local-dir",
        type=Path,
        help="staging directory (default: .scratch/modelscope-sync/<repo>)",
    )
    parser.add_argument(
        "--max-workers",
        type=int,
        default=8,
        help="maximum concurrent workers for download and upload (default: 8)",
    )
    parser.add_argument(
        "--commit-message",
        default="Mirror dataset from Hugging Face",
        help="ModelScope commit message",
    )
    return parser.parse_args()


def require_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise SystemExit(
            f"Environment variable {name} is not set. "
            f"Set it before running this script."
        )
    return value


def remove_huggingface_metadata(local_dir: Path) -> None:
    """Remove metadata created by snapshot_download, not files from the repo."""
    metadata_dir = local_dir / ".cache" / "huggingface"
    if metadata_dir.exists():
        shutil.rmtree(metadata_dir)

    cache_dir = local_dir / ".cache"
    if cache_dir.exists() and not any(cache_dir.iterdir()):
        cache_dir.rmdir()


def reconcile_and_verify_snapshot(local_dir: Path, repo_files: set[str]) -> None:
    """Remove stale staging files and ensure every source file was downloaded."""
    for path in local_dir.rglob("*"):
        if path.is_file() and path.relative_to(local_dir).as_posix() not in repo_files:
            path.unlink()

    for path in sorted(local_dir.rglob("*"), reverse=True):
        if path.is_dir() and not any(path.iterdir()):
            path.rmdir()

    missing = [path for path in sorted(repo_files) if not (local_dir / path).is_file()]
    if missing:
        preview = "\n".join(f"  - {path}" for path in missing[:20])
        suffix = f"\n  ... and {len(missing) - 20} more" if len(missing) > 20 else ""
        raise RuntimeError(
            f"Download verification failed; {len(missing)} files are missing:\n"
            f"{preview}{suffix}"
        )


def main() -> None:
    args = parse_args()
    if args.max_workers < 1:
        raise SystemExit("--max-workers must be at least 1.")

    try:
        from huggingface_hub import HfApi, snapshot_download
    except ImportError as exc:
        raise SystemExit(
            "Missing dependency: install it with "
            "`python -m pip install huggingface_hub`."
        ) from exc

    try:
        from modelscope.hub.api import HubApi
    except ImportError as exc:
        raise SystemExit(
            "Missing dependency: install it with `python -m pip install modelscope`."
        ) from exc

    try:
        from dotenv import load_dotenv
    except ImportError as exc:
        raise SystemExit(
            "Missing dependency: install it with `python -m pip install python-dotenv`."
        ) from exc

    # Existing process environment variables take precedence over values in .env.
    load_dotenv(SCRIPT_DIR / ".env")
    modelscope_token = require_env("MODELSCOPE_API_TOKEN")
    huggingface_token = os.environ.get("HF_TOKEN")

    local_dir = args.local_dir or (
        SCRIPT_DIR
        / ".scratch"
        / "modelscope-sync"
        / HUGGINGFACE_REPO.replace("/", "--")
    )
    local_dir = local_dir.resolve()
    local_dir.mkdir(parents=True, exist_ok=True)

    hf_api = HfApi(token=huggingface_token)
    repo_info = hf_api.repo_info(
        repo_id=HUGGINGFACE_REPO,
        repo_type="dataset",
        revision=args.revision,
    )
    source_commit = repo_info.sha
    repo_files = set(
        hf_api.list_repo_files(
            repo_id=HUGGINGFACE_REPO,
            repo_type="dataset",
            revision=source_commit,
            token=huggingface_token,
        )
    )

    print(
        f"Downloading {len(repo_files)} files from "
        f"{HUGGINGFACE_URL}@{source_commit} to {local_dir}"
    )
    snapshot_download(
        repo_id=HUGGINGFACE_REPO,
        repo_type="dataset",
        revision=source_commit,
        local_dir=local_dir,
        token=huggingface_token,
        max_workers=args.max_workers,
    )
    remove_huggingface_metadata(local_dir)
    reconcile_and_verify_snapshot(local_dir, repo_files)

    print(f"Uploading the complete snapshot to {MODELSCOPE_URL}")
    modelscope_api = HubApi()
    modelscope_api.login(modelscope_token)
    modelscope_api.upload_folder(
        repo_id=MODELSCOPE_REPO,
        folder_path=str(local_dir),
        repo_type="dataset",
        commit_message=(
            f"{args.commit_message} "
            f"({HUGGINGFACE_REPO}@{source_commit})"
        ),
        max_workers=args.max_workers,
    )
    print("Mirror upload completed successfully.")


if __name__ == "__main__":
    main()
