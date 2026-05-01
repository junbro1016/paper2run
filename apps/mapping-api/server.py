#!/usr/bin/env python3
"""Local HTTP wrapper for Paper2Run code-location mapping.

This service exposes:

  GET  /health
  POST /map

The frontend can call POST /map with the extracted Paper2Run JSON plus a
`github_repository.url` value. The response is the same JSON enriched with
`code_locations` for equations and figures.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse


REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPTS_DIR = REPO_ROOT / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from link_paper_components_to_code import (  # noqa: E402
    DEFAULT_MODEL,
    choose_model,
    component_identity,
    enrich_component,
    ensure_repo,
    iter_code_files,
    list_openai_models,
    parse_github_repo,
    repo_commit,
)


def cors_headers() -> dict[str, str]:
    return {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type,Authorization",
    }


def env_int(name: str, default: int) -> int:
    value = os.environ.get(name)
    if not value:
        return default
    try:
        return int(value)
    except ValueError as exc:
        raise ValueError(f"{name} must be an integer, got {value!r}") from exc


def json_response(handler: BaseHTTPRequestHandler, status: int, payload: dict[str, Any]) -> None:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    for key, value in cors_headers().items():
        handler.send_header(key, value)
    handler.end_headers()
    handler.wfile.write(body)


def read_json_body(handler: BaseHTTPRequestHandler, max_bytes: int) -> dict[str, Any]:
    length = int(handler.headers.get("Content-Length", "0"))
    if length <= 0:
        raise ValueError("Request body is empty.")
    if length > max_bytes:
        raise ValueError(f"Request body is too large: {length} bytes.")
    raw = handler.rfile.read(length)
    return json.loads(raw.decode("utf-8"))


class MappingService:
    def __init__(self, args: argparse.Namespace):
        self.args = args
        self.api_key = os.environ.get(args.api_key_env)
        if not self.api_key:
            raise RuntimeError(f"Missing API key. Set {args.api_key_env}.")
        if not shutil.which("git"):
            raise RuntimeError("git is required to clone/read target repositories.")
        self.available_models: list[str] | None = None
        if args.model == "auto":
            self.available_models = list_openai_models(self.api_key, args.timeout)
        self.model = choose_model(args.model, self.available_models)

    def map_payload(self, payload: dict[str, Any]) -> dict[str, Any]:
        repo_url = (
            payload.get("github_repository", {}).get("url")
            or payload.get("repo_url")
            or payload.get("repository_url")
        )
        if not repo_url:
            raise ValueError("Missing github_repository.url.")

        _, _, normalized_repo_url = parse_github_repo(str(repo_url))
        repo_dir = ensure_repo(
            normalized_repo_url,
            self.args.repo_cache.expanduser().resolve(),
            None,
            self.args.ref,
        )
        commit = repo_commit(repo_dir)
        files = iter_code_files(repo_dir, self.args.max_file_bytes)

        enriched = dict(payload)
        enriched["github_repository"] = {
            **payload.get("github_repository", {}),
            "url": normalized_repo_url,
            "commit": commit,
            "local_path": str(repo_dir),
            "mapping_method": "local_mapping_api_openai_llm_candidate_snippet_mapping",
            "model": self.model,
        }

        equations = []
        for index, equation in enumerate(payload.get("equations", []), start=1):
            print(f"Mapping equation {index}: {component_identity('equation', equation)}", flush=True)
            equations.append(
                enrich_component(
                    kind="equation",
                    component=equation,
                    repo_dir=repo_dir,
                    files=files,
                    repo_url=normalized_repo_url,
                    commit=commit,
                    api_key=self.api_key,
                    model=self.model,
                    max_candidates=self.args.max_candidates,
                    context_lines=self.args.context_lines,
                    timeout=self.args.timeout,
                    max_retries=self.args.max_retries,
                    save_candidates=self.args.save_candidates,
                )
            )

        figures = []
        for index, figure in enumerate(payload.get("figures", []), start=1):
            print(f"Mapping figure {index}: {component_identity('figure', figure)}", flush=True)
            figures.append(
                enrich_component(
                    kind="figure",
                    component=figure,
                    repo_dir=repo_dir,
                    files=files,
                    repo_url=normalized_repo_url,
                    commit=commit,
                    api_key=self.api_key,
                    model=self.model,
                    max_candidates=self.args.max_candidates,
                    context_lines=self.args.context_lines,
                    timeout=self.args.timeout,
                    max_retries=self.args.max_retries,
                    save_candidates=self.args.save_candidates,
                )
            )

        enriched["equations"] = equations
        enriched["figures"] = figures
        enriched["code_mapping_counts"] = {
            "mapped_equations": sum(
                1 for item in equations if item.get("code_mapping_status") == "mapped"
            ),
            "total_equations": len(equations),
            "mapped_figures": sum(
                1 for item in figures if item.get("code_mapping_status") == "mapped"
            ),
            "total_figures": len(figures),
        }
        return enriched


def make_handler(service: MappingService, max_body_bytes: int) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        def do_OPTIONS(self) -> None:  # noqa: N802
            self.send_response(204)
            for key, value in cors_headers().items():
                self.send_header(key, value)
            self.end_headers()

        def do_GET(self) -> None:  # noqa: N802
            path = urlparse(self.path).path
            if path == "/":
                json_response(
                    self,
                    200,
                    {
                        "service": "paper2run-mapping-api",
                        "endpoints": {
                            "health": "/health",
                            "map": "/map",
                        },
                    },
                )
                return
            if path == "/health":
                json_response(
                    self,
                    200,
                    {
                        "status": "ok",
                        "model": service.model,
                    },
                )
                return
            json_response(self, 404, {"error": "Not found"})

        def do_POST(self) -> None:  # noqa: N802
            path = urlparse(self.path).path
            if path != "/map":
                json_response(self, 404, {"error": "Not found"})
                return
            try:
                payload = read_json_body(self, max_body_bytes)
                mapped = service.map_payload(payload)
                json_response(self, 200, mapped)
            except Exception as exc:  # pylint: disable=broad-except
                json_response(self, 500, {"error": str(exc)})

        def log_message(self, fmt: str, *args: object) -> None:
            print(f"{self.address_string()} - {fmt % args}", flush=True)

    return Handler


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run Paper2Run mapping API.")
    parser.add_argument("--host", default=os.environ.get("HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=env_int("PORT", 8787))
    parser.add_argument("--model", default=os.environ.get("OPENAI_MODEL", DEFAULT_MODEL))
    parser.add_argument("--api-key-env", default="OPENAI_API_KEY")
    parser.add_argument("--repo-cache", type=Path, default=REPO_ROOT / ".paper2code_repos")
    parser.add_argument("--ref")
    parser.add_argument("--max-candidates", type=int, default=12)
    parser.add_argument("--context-lines", type=int, default=35)
    parser.add_argument("--max-file-bytes", type=int, default=350_000)
    parser.add_argument("--timeout", type=int, default=120)
    parser.add_argument("--max-retries", type=int, default=2)
    parser.add_argument("--save-candidates", action="store_true")
    parser.add_argument("--max-body-bytes", type=int, default=5_000_000)
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    service = MappingService(args)
    server = ThreadingHTTPServer((args.host, args.port), make_handler(service, args.max_body_bytes))
    print(f"Mapping API running at http://{args.host}:{args.port}/map")
    print(f"Using OpenAI model: {service.model}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping mapping API.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
