#!/usr/bin/env python3
"""Local HTTP wrapper for Paper2Run code-location mapping and runbooks.

This service exposes:

  GET  /health
  POST /map
  POST /runbook
  POST /chat

The frontend can call POST /map with the extracted Paper2Run JSON plus a
`github_repository.url` value. The response is the same JSON enriched with
`code_locations` for equations and figures.

The frontend can call POST /runbook with a Paper2Run result. The service reads
README/requirements files from the target GitHub repository, combines them with
backend-extracted commands, and asks OpenAI to create a reproduction runbook.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen


REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPTS_DIR = REPO_ROOT / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from link_paper_components_to_code import (  # noqa: E402
    DEFAULT_MODEL,
    OPENAI_RESPONSES_URL,
    choose_model,
    component_identity,
    enrich_component,
    ensure_repo,
    extract_output_text,
    iter_code_files,
    list_openai_models,
    parse_github_repo,
    read_text,
    repo_commit,
)


MAX_README_CHARS = 28_000
MAX_REQUIREMENTS_CHARS = 14_000
MAX_COMMANDS = 24
MAX_COMPONENTS_PER_GROUP = 12
MAX_CHAT_CONTEXT_CHARS = 60_000
MAX_CHAT_HISTORY = 8


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


def head_response(handler: BaseHTTPRequestHandler, status: int) -> None:
    handler.send_response(status)
    for key, value in cors_headers().items():
        handler.send_header(key, value)
    handler.end_headers()


def read_json_body(handler: BaseHTTPRequestHandler, max_bytes: int) -> dict[str, Any]:
    length = int(handler.headers.get("Content-Length", "0"))
    if length <= 0:
        raise ValueError("Request body is empty.")
    if length > max_bytes:
        raise ValueError(f"Request body is too large: {length} bytes.")
    raw = handler.rfile.read(length)
    return json.loads(raw.decode("utf-8"))


def trim_text(text: str, max_chars: int) -> str:
    if len(text) <= max_chars:
        return text
    return f"{text[:max_chars]}\n\n[truncated: {len(text) - max_chars} chars omitted]"


def find_repo_file(repo_dir: Path, names: tuple[str, ...], max_chars: int) -> dict[str, Any]:
    lowered = {name.lower() for name in names}
    candidates = [path for path in repo_dir.iterdir() if path.is_file() and path.name.lower() in lowered]

    if not candidates:
        for path in repo_dir.rglob("*"):
            relative_parts = path.relative_to(repo_dir).parts
            if any(part in {".git", "node_modules", "venv", ".venv"} for part in relative_parts):
                continue
            if path.is_file() and path.name.lower() in lowered:
                candidates.append(path)
                break

    if not candidates:
        return {"found": False, "path": "", "content": ""}

    chosen = candidates[0]
    return {
        "found": True,
        "path": chosen.relative_to(repo_dir).as_posix(),
        "content": trim_text(read_text(chosen), max_chars),
    }


def collect_commands(payload: dict[str, Any]) -> list[dict[str, Any]]:
    commands: list[dict[str, Any]] = []

    def looks_like_command(item: dict[str, Any]) -> bool:
        command_keys = {"command_id", "command_type", "raw_command", "command", "shell", "cli", "script", "arguments"}
        return any(key in item and item.get(key) for key in command_keys)

    def add(item: dict[str, Any], group: str) -> None:
        if not looks_like_command(item):
            return
        commands.append(
            {
                "source_group": group,
                "command_id": item.get("command_id") or item.get("id") or item.get("component_id") or "",
                "command_type": item.get("command_type") or item.get("type") or item.get("role") or "",
                "raw_command": item.get("raw_command") or item.get("command") or item.get("shell") or "",
                "description": item.get("description") or item.get("steps_summary") or item.get("context") or "",
                "framework": item.get("framework") or "",
                "confidence": item.get("confidence"),
            }
        )

    for group_name in ("commands", "command", "run_commands"):
        value = payload.get(group_name)
        if isinstance(value, list):
            for item in value:
                if isinstance(item, dict):
                    add(item, group_name)

    extractions = payload.get("extractions")
    if isinstance(extractions, dict):
        for group, value in extractions.items():
            items = extraction_items(value)
            for item in items:
                add(item, str(group))

    seen: set[tuple[str, str, str]] = set()
    unique: list[dict[str, Any]] = []
    for command in commands:
        key = (
            str(command.get("command_id", "")),
            str(command.get("command_type", "")),
            str(command.get("raw_command", "")),
        )
        if key in seen:
            continue
        seen.add(key)
        unique.append(command)
        if len(unique) >= MAX_COMMANDS:
            break
    return unique


def extraction_items(value: Any) -> list[dict[str, Any]]:
    if isinstance(value, list):
        return [item for item in value if isinstance(item, dict)]
    if not isinstance(value, dict):
        return []
    for key in ("items", "results", "extractions"):
        if isinstance(value.get(key), list):
            return [item for item in value[key] if isinstance(item, dict)]
    return []


def compact_components(payload: dict[str, Any]) -> dict[str, Any]:
    extractions = payload.get("extractions")
    if not isinstance(extractions, dict):
        return {}
    compact: dict[str, Any] = {}
    for group, value in extractions.items():
        selected = []
        for item in extraction_items(value)[:MAX_COMPONENTS_PER_GROUP]:
            metadata = item.get("metadata") if isinstance(item.get("metadata"), dict) else {}
            selected.append(
                {
                    "id": item.get("id") or item.get("component_id") or item.get("figure_id") or item.get("algorithm_id"),
                    "type": item.get("type") or str(group).replace("_extractor", ""),
                    "content": item.get("content"),
                    "title": metadata.get("algorithm_name") or metadata.get("caption") or item.get("command_type") or item.get("role"),
                    "description": item.get("description") or metadata.get("steps_summary") or metadata.get("key_insight") or item.get("context"),
                    "latex": metadata.get("latex") or item.get("latex"),
                    "raw_command": item.get("raw_command") or item.get("command"),
                }
            )
        compact[str(group)] = selected
    return compact


def runbook_schema() -> dict[str, Any]:
    step_schema = {
        "type": "object",
        "properties": {
            "title": {"type": "string"},
            "commands": {"type": "array", "items": {"type": "string"}},
            "notes": {"type": "string"},
            "source": {"type": "string"},
        },
        "required": ["title", "commands", "notes", "source"],
        "additionalProperties": False,
    }
    return {
        "type": "object",
        "properties": {
            "title": {"type": "string"},
            "overview": {"type": "string"},
            "source_confidence": {"type": "string", "enum": ["high", "medium", "low"]},
            "environment": {
                "type": "object",
                "properties": {
                    "package_manager": {"type": "string"},
                    "python": {"type": "string"},
                    "frameworks": {"type": "array", "items": {"type": "string"}},
                    "hardware": {"type": "string"},
                },
                "required": ["package_manager", "python", "frameworks", "hardware"],
                "additionalProperties": False,
            },
            "setup": {"type": "array", "items": step_schema},
            "data_preparation": {"type": "array", "items": step_schema},
            "reproduction_steps": {"type": "array", "items": step_schema},
            "evaluation": {"type": "array", "items": step_schema},
            "expected_outputs": {"type": "array", "items": {"type": "string"}},
            "troubleshooting": {"type": "array", "items": step_schema},
            "assumptions": {"type": "array", "items": {"type": "string"}},
            "open_questions": {"type": "array", "items": {"type": "string"}},
            "source_notes": {"type": "array", "items": {"type": "string"}},
        },
        "required": [
            "title",
            "overview",
            "source_confidence",
            "environment",
            "setup",
            "data_preparation",
            "reproduction_steps",
            "evaluation",
            "expected_outputs",
            "troubleshooting",
            "assumptions",
            "open_questions",
            "source_notes",
        ],
        "additionalProperties": False,
    }


def call_openai_runbook(
    *,
    api_key: str,
    model: str,
    source_context: dict[str, Any],
    timeout: int,
    max_retries: int,
) -> dict[str, Any]:
    system_prompt = (
        "You are a senior reproducibility engineer for machine learning papers. "
        "Create concise, practical runbooks that a researcher can follow to reproduce a paper from a GitHub repository. "
        "Use the README and requirements as the strongest evidence, then backend-extracted commands, then paper analysis. "
        "Do not invent exact commands when the sources do not support them; write assumptions or open questions instead. "
        "Write in clear English. Keep the guide short, direct, and action-oriented. "
        "Keep shell commands, file names, package names, and paths exactly as they should be typed."
    )
    user_prompt = {
        "task": "Create a reproduction runbook for the analyzed paper.",
        "source_priority": [
            "1. GitHub README.md or equivalent README file",
            "2. GitHub requirements.txt / environment.yml / pyproject.toml",
            "3. Backend-extracted command components",
            "4. Paper2Run profile, components, and mappings",
        ],
        "requirements": [
            "Prefer commands explicitly supported by README or extracted commands.",
            "If data paths, checkpoints, or exact hyperparameters are missing, mark them as assumptions or open questions.",
            "Include only the steps needed to get from a fresh clone to a reproduced result.",
            "Use imperative titles such as 'Clone the repository', 'Install dependencies', and 'Run evaluation'.",
            "Keep overview under 80 words.",
            "Keep each step note to one or two short sentences.",
            "Limit setup, data_preparation, reproduction_steps, evaluation, and troubleshooting to the most important items.",
            "Put commands in commands arrays only when the source supports them.",
            "Mention which source supports each step, using compact labels like README, requirements.txt, extracted command, or assumption.",
        ],
        "source_context": source_context,
    }
    body = {
        "model": model,
        "input": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": json.dumps(user_prompt, ensure_ascii=False)},
        ],
        "text": {
            "format": {
                "type": "json_schema",
                "name": "paper_reproduction_runbook",
                "strict": True,
                "schema": runbook_schema(),
            }
        },
    }
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    encoded = json.dumps(body).encode("utf-8")
    last_error: Exception | None = None

    for attempt in range(max_retries + 1):
        request = Request(OPENAI_RESPONSES_URL, data=encoded, headers=headers, method="POST")
        try:
            with urlopen(request, timeout=timeout) as response:
                raw = response.read().decode("utf-8")
            return json.loads(extract_output_text(json.loads(raw)))
        except HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            last_error = RuntimeError(f"OpenAI API HTTP {exc.code}: {detail}")
        except (URLError, TimeoutError, json.JSONDecodeError, RuntimeError) as exc:
            last_error = exc

        if attempt < max_retries:
            time.sleep(2**attempt)

    raise RuntimeError(f"OpenAI runbook generation failed: {last_error}")


def call_openai_chat(
    *,
    api_key: str,
    model: str,
    question: str,
    context: dict[str, Any],
    messages: list[dict[str, Any]],
    timeout: int,
    max_retries: int,
) -> str:
    system_prompt = (
        "You are Paper2Run's research assistant. Answer questions about a paper analysis result. "
        "Use only the provided Paper2Run JSON context and prior chat messages. "
        "If the context is scoped to a single equation, figure, algorithm, runbook, or runbook step, "
        "focus the answer on that component and do not rely on unrelated components. "
        "When code mappings are present, cite file names, line numbers, confidence, and verification status when useful. "
        "If the provided context is insufficient, say what is missing instead of inventing details. "
        "Answer in the same language as the user's question. Keep the answer concise and practical."
    )
    compact_messages = [
        {
            "role": "assistant" if item.get("role") == "assistant" else "user",
            "content": str(item.get("content") or "")[:1800],
        }
        for item in messages[-MAX_CHAT_HISTORY:]
        if item.get("content")
    ]
    user_prompt = {
        "task": "Answer the user's question using the supplied Paper2Run JSON context.",
        "question": question,
        "context_scope": context.get("scope") or context.get("kind") or "unknown",
        "context_title": context.get("title") or "",
        "context_json": trim_text(json.dumps(context, ensure_ascii=False), MAX_CHAT_CONTEXT_CHARS),
        "recent_messages": compact_messages,
    }
    body = {
        "model": model,
        "input": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": json.dumps(user_prompt, ensure_ascii=False)},
        ],
        "max_output_tokens": 900,
    }
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    encoded = json.dumps(body).encode("utf-8")
    last_error: Exception | None = None

    for attempt in range(max_retries + 1):
        request = Request(OPENAI_RESPONSES_URL, data=encoded, headers=headers, method="POST")
        try:
            with urlopen(request, timeout=timeout) as response:
                raw = response.read().decode("utf-8")
            return extract_output_text(json.loads(raw)).strip()
        except HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            last_error = RuntimeError(f"OpenAI API HTTP {exc.code}: {detail}")
        except (URLError, TimeoutError, json.JSONDecodeError, RuntimeError) as exc:
            last_error = exc

        if attempt < max_retries:
            time.sleep(2**attempt)

    raise RuntimeError(f"OpenAI chat failed: {last_error}")


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

    def runbook_payload(self, payload: dict[str, Any]) -> dict[str, Any]:
        repo_url = (
            payload.get("github_repository", {}).get("url")
            or payload.get("github_url")
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
        readme = find_repo_file(
            repo_dir,
            ("README.md", "README.markdown", "README.rst", "README.txt", "README"),
            MAX_README_CHARS,
        )
        requirements = find_repo_file(
            repo_dir,
            ("requirements.txt", "requirements-dev.txt", "environment.yml", "environment.yaml", "pyproject.toml"),
            MAX_REQUIREMENTS_CHARS,
        )
        commands = collect_commands(payload)
        source_context = {
            "repository": {
                "url": normalized_repo_url,
                "commit": commit,
            },
            "paper": {
                "filename": payload.get("filename") or payload.get("source_pdf") or "",
                "title": payload.get("title") or payload.get("paper_title") or "",
                "profile": payload.get("profile") or payload.get("profile_summary") or {},
                "plan": payload.get("plan") or payload.get("plan_summary") or [],
            },
            "repo_files": {
                "readme": readme,
                "requirements": requirements,
            },
            "commands": commands,
            "components": compact_components(payload),
            "mappings": payload.get("mappings", [])[:24] if isinstance(payload.get("mappings"), list) else [],
        }
        runbook = call_openai_runbook(
            api_key=self.api_key,
            model=self.model,
            source_context=source_context,
            timeout=self.args.timeout,
            max_retries=self.args.max_retries,
        )
        return {
            "github_repository": {
                **payload.get("github_repository", {}),
                "url": normalized_repo_url,
                "commit": commit,
                "runbook_method": "openai_readme_requirements_command_reproduction_runbook",
                "model": self.model,
            },
            "source_files": {
                "readme": {key: value for key, value in readme.items() if key != "content"},
                "requirements": {key: value for key, value in requirements.items() if key != "content"},
            },
            "commands_used": commands,
            "runbook": runbook,
        }

    def chat_payload(self, payload: dict[str, Any]) -> dict[str, Any]:
        question = str(payload.get("question") or "").strip()
        if not question:
            raise ValueError("Missing question.")
        context = payload.get("context")
        if not isinstance(context, dict):
            raise ValueError("Missing context object.")
        messages = payload.get("messages")
        if not isinstance(messages, list):
            messages = []
        answer = call_openai_chat(
            api_key=self.api_key,
            model=self.model,
            question=question,
            context=context,
            messages=[item for item in messages if isinstance(item, dict)],
            timeout=self.args.timeout,
            max_retries=self.args.max_retries,
        )
        return {
            "answer": answer,
            "model": self.model,
            "context_scope": context.get("scope") or context.get("kind") or "unknown",
            "context_title": context.get("title") or "",
        }


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
                            "runbook": "/runbook",
                            "chat": "/chat",
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

        def do_HEAD(self) -> None:  # noqa: N802
            path = urlparse(self.path).path
            head_response(self, 200 if path in {"/", "/health", "/map", "/runbook", "/chat"} else 404)

        def do_POST(self) -> None:  # noqa: N802
            path = urlparse(self.path).path
            if path not in {"/map", "/runbook", "/chat"}:
                json_response(self, 404, {"error": "Not found"})
                return
            try:
                payload = read_json_body(self, max_body_bytes)
                if path == "/map":
                    mapped = service.map_payload(payload)
                    json_response(self, 200, mapped)
                    return
                if path == "/chat":
                    chat = service.chat_payload(payload)
                    json_response(self, 200, chat)
                    return
                runbook = service.runbook_payload(payload)
                json_response(self, 200, runbook)
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
    print(f"Runbook API running at http://{args.host}:{args.port}/runbook")
    print(f"Using OpenAI model: {service.model}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping mapping API.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
