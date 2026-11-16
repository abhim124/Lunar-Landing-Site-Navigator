"""
Deploy the backend to a Hugging Face Docker Space, so it runs without this computer.

    pip install huggingface_hub
    hf auth login                      # paste a *write* token from huggingface.co/settings/tokens
    python scripts/deploy_hf_space.py <hf-username>/lunar-backend \
        --cors https://lunar-landing-site-navigator-one.vercel.app

Uploads only Dockerfile, requirements.txt, app/ and data/ (plus the Space README). backend/.env is
never uploaded: add NASA_API_KEY yourself under the Space's Settings → Variables and secrets.
Re-running the script updates the Space; only changed files are sent.
"""

from __future__ import annotations

import argparse
from pathlib import Path

from huggingface_hub import HfApi

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
SPACE_README = ROOT / "deploy" / "hf-space" / "README.md"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("space", help="<username>/<space-name>, e.g. jane/lunar-backend")
    ap.add_argument("--cors", default="*", help="comma-separated allowed origins (your Vercel URL)")
    ap.add_argument("--private", action="store_true", help="private Space (the API then needs a token: keep it public)")
    args = ap.parse_args()

    api = HfApi()
    url = api.create_repo(args.space, repo_type="space", space_sdk="docker", private=args.private, exist_ok=True)
    print(f"Space: {url}")

    api.upload_file(path_or_fileobj=str(SPACE_README), path_in_repo="README.md", repo_id=args.space, repo_type="space")
    api.upload_folder(
        folder_path=str(BACKEND),
        repo_id=args.space,
        repo_type="space",
        allow_patterns=["Dockerfile", ".dockerignore", "requirements.txt", "app/**", "data/**"],
        ignore_patterns=[".env", ".env.*", "**/.env", "**/__pycache__/**", "**/*.pyc", ".venv/**"],
        commit_message="Deploy backend",
    )
    api.add_space_variable(args.space, "CORS_ORIGINS", args.cors)

    owner, name = args.space.split("/", 1)
    host = f"https://{owner.lower()}-{name.lower().replace('_', '-').replace('.', '-')}.hf.space"
    print(f"Uploaded. The Space builds for a few minutes, then serves at {host}")
    print(f"Check: {host}/api/health")
    print("Next: add the NASA_API_KEY secret in the Space settings, then set NEXT_PUBLIC_API_BASE in Vercel to that URL.")


if __name__ == "__main__":
    main()
