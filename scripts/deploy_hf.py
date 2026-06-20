#!/usr/bin/env python
"""Redeploy the portfolio to its Hugging Face Space.

The Space (sachalchandio/sachal-portfolio) is a Docker Space: HF rebuilds the
root Dockerfile from source on every push, so we just re-upload the changed
source files and HF does the rest (~3-5 min rebuild).

Safety:
  - The write token is read from the gitignored .env (HF_TOKEN=hf_...). It is
    never printed or embedded in a command.
  - README.md / readme.md are excluded so the Space's front-matter README
    (sdk: docker, app_port: 8000) is never overwritten by the GitHub readme.
  - Build artifacts, node_modules, secrets and the local Flask webroot are
    excluded; everything the Dockerfile needs (frontend/, backend/, public
    assets incl. the resume PDF) is uploaded.

Usage:  python scripts/deploy_hf.py ["commit message"]
"""
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SPACE_NAME = "sachal-portfolio"

IGNORE = [
    ".env",
    ".git/**",
    "**/node_modules/**",
    "**/dist/**",
    "backend/webroot/**",
    "**/__pycache__/**",
    "**/*.pyc",
    ".claude/**",
    ".github/**",
    "**/.pytest_cache/**",
    "HuggingFace-Deploy-Guide.pdf",
    "Vercel-Deploy-Guide.pdf",
    "README.md",
    "readme.md",
]


def read_token() -> str:
    env = os.path.join(ROOT, ".env")
    for line in open(env, encoding="utf-8"):
        if line.strip().startswith("HF_TOKEN"):
            return line.split("=", 1)[1].strip()
    raise SystemExit("HF_TOKEN not found in .env")


def main() -> None:
    from huggingface_hub import HfApi

    msg = sys.argv[1] if len(sys.argv) > 1 else "Update portfolio"
    token = read_token()
    api = HfApi(token=token)
    user = api.whoami()["name"]
    repo = f"{user}/{SPACE_NAME}"
    print(f"Uploading to space: {repo}")

    commit = api.upload_folder(
        folder_path=ROOT,
        repo_id=repo,
        repo_type="space",
        ignore_patterns=IGNORE,
        commit_message=msg,
    )
    print("Commit:", getattr(commit, "commit_url", commit))
    try:
        rt = api.get_space_runtime(repo)
        print("Stage after push:", rt.stage)
    except Exception as e:
        print("runtime check skipped:", e)
    print("Rebuild triggered. Watch: https://huggingface.co/spaces/%s" % repo)


if __name__ == "__main__":
    main()
