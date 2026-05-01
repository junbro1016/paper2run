#!/usr/bin/env python3
"""Map Paper2Run equations/figures to GitHub code locations with an LLM.

Inputs:
  1. A Paper2Run JSON file containing `equations` and/or `figures`.
  2. A GitHub repository URL, e.g. https://github.com/tensorflow/tensor2tensor.

The script clones the repo, selects likely code snippets for each paper
component, asks the OpenAI Responses API to choose matching locations, validates
the returned file/line ranges, and writes an enriched JSON file.

Required environment:
  OPENAI_API_KEY
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


DEFAULT_MODEL = "auto"
OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses"
OPENAI_MODELS_URL = "https://api.openai.com/v1/models"
PREFERRED_MODELS = [
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.2",
    "gpt-5",
    "gpt-4.1",
    "gpt-4.1-mini",
    "gpt-4o",
    "gpt-4o-mini",
]
CODE_EXTENSIONS = {
    ".py",
    ".pyi",
    ".ipynb",
    ".js",
    ".jsx",
    ".ts",
    ".tsx",
    ".java",
    ".kt",
    ".go",
    ".rs",
    ".c",
    ".cc",
    ".cpp",
    ".cxx",
    ".h",
    ".hpp",
    ".m",
    ".mm",
    ".swift",
    ".scala",
    ".jl",
    ".r",
    ".R",
    ".m",
    ".cu",
    ".sh",
    ".yaml",
    ".yml",
    ".json",
    ".toml",
}
SKIP_DIRS = {
    ".git",
    ".hg",
    ".svn",
    "__pycache__",
    ".mypy_cache",
    ".pytest_cache",
    "node_modules",
    "venv",
    ".venv",
    "dist",
    "build",
    "third_party",
    "vendor",
}
STOPWORDS = {
    "the",
    "and",
    "for",
    "with",
    "from",
    "that",
    "this",
    "into",
    "used",
    "uses",
    "using",
    "each",
    "paper",
    "model",
    "figure",
    "equation",
    "section",
    "where",
    "when",
    "then",
    "than",
    "output",
    "input",
}


@dataclass
class CandidateSnippet:
    candidate_id: str
    path: str
    line_start: int
    line_end: int
    score: float
    text: str


def run_git(args: list[str], cwd: Path | None = None) -> str:
    result = subprocess.run(
        ["git", *args],
        cwd=str(cwd) if cwd else None,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or f"git {' '.join(args)} failed")
    return result.stdout.strip()


def parse_github_repo(repo_url: str) -> tuple[str, str, str]:
    match = re.match(r"^https://github\.com/([^/\s]+)/([^/\s#?]+?)(?:\.git)?/?$", repo_url)
    if not match:
        raise ValueError("repo_url must look like https://github.com/<owner>/<repo>")
    owner, repo = match.group(1), match.group(2)
    return owner, repo, f"https://github.com/{owner}/{repo}"


def ensure_repo(repo_url: str, cache_root: Path, repo_dir: Path | None, ref: str | None) -> Path:
    owner, repo, normalized_url = parse_github_repo(repo_url)
    target = repo_dir.expanduser().resolve() if repo_dir else cache_root / f"{owner}__{repo}"

    if target.exists() and (target / ".git").exists():
        if ref:
            run_git(["fetch", "--depth", "1", "origin", ref], cwd=target)
            run_git(["checkout", "FETCH_HEAD"], cwd=target)
        return target

    if target.exists() and any(target.iterdir()):
        raise RuntimeError(f"Repo directory exists but is not a git repo: {target}")

    target.parent.mkdir(parents=True, exist_ok=True)
    clone_args = ["clone", "--depth", "1"]
    if ref:
        clone_args += ["--branch", ref]
    clone_args += [normalized_url, str(target)]
    run_git(clone_args)
    return target


def repo_commit(repo_dir: Path) -> str:
    return run_git(["rev-parse", "HEAD"], cwd=repo_dir)


def relative_path(path: Path, root: Path) -> str:
    return path.relative_to(root).as_posix()


def iter_code_files(repo_dir: Path, max_file_bytes: int) -> list[Path]:
    files: list[Path] = []
    for path in repo_dir.rglob("*"):
        if any(part in SKIP_DIRS for part in path.relative_to(repo_dir).parts):
            continue
        if not path.is_file():
            continue
        if path.suffix not in CODE_EXTENSIONS:
            continue
        try:
            if path.stat().st_size > max_file_bytes:
                continue
        except OSError:
            continue
        files.append(path)
    return files


def read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return path.read_text(encoding="utf-8", errors="replace")


def component_identity(kind: str, component: dict[str, Any]) -> str:
    if kind == "equation":
        return f"equation_{component.get('eq_number', component.get('id', 'unknown'))}"
    return f"figure_{component.get('fig_number', component.get('id', 'unknown'))}"


def component_text(kind: str, component: dict[str, Any]) -> str:
    keys = (
        ["latex", "description", "context", "core_reason", "section_hint", "role"]
        if kind == "equation"
        else ["caption", "figure_type", "key_insight"]
    )
    values = [str(component.get(key, "")) for key in keys if component.get(key)]
    return "\n".join(values)


def tokenize(text: str) -> list[str]:
    raw_tokens = re.findall(r"[A-Za-z_][A-Za-z0-9_]{2,}", text.lower())
    tokens = []
    for token in raw_tokens:
        token = token.strip("_")
        if len(token) < 3 or token in STOPWORDS:
            continue
        tokens.append(token)
    return sorted(set(tokens), key=lambda value: (-len(value), value))[:80]


def add_domain_expansions(tokens: set[str], text: str) -> None:
    lowered = text.lower()
    expansions = {
        "softmax": ["softmax", "attention", "weights", "logits"],
        "attention": ["attention", "query", "queries", "key", "keys", "value", "values", "qkv"],
        "multihead": ["multihead", "head", "heads", "split_heads", "combine_heads"],
        "ffn": ["ffn", "feed", "forward", "relu", "dense"],
        "positional": ["position", "positional", "timing", "sin", "cos"],
        "learning": ["learning_rate", "warmup", "decay", "schedule", "optimizer"],
        "smoothing": ["smoothing", "label_smoothing", "cross_entropy", "confidence"],
    }
    for trigger, words in expansions.items():
        if trigger in lowered:
            tokens.update(words)


def score_text(text: str, tokens: set[str]) -> float:
    lowered = text.lower()
    score = 0.0
    for token in tokens:
        count = lowered.count(token)
        if count:
            score += min(count, 8) * (2.5 if "_" in token else 1.0)
    return score


def line_window(lines: list[str], center: int, context: int) -> tuple[int, int, str]:
    start = max(1, center - context)
    end = min(len(lines), center + context)
    rendered = "\n".join(f"{idx}: {lines[idx - 1]}" for idx in range(start, end + 1))
    return start, end, rendered


def find_candidate_snippets(
    repo_dir: Path,
    files: list[Path],
    kind: str,
    component: dict[str, Any],
    *,
    max_candidates: int,
    context_lines: int,
) -> list[CandidateSnippet]:
    text = component_text(kind, component)
    tokens = set(tokenize(text))
    add_domain_expansions(tokens, text)
    if not tokens:
        tokens = set(tokenize(json.dumps(component, ensure_ascii=False)))

    file_scores: list[tuple[float, Path, str]] = []
    for path in files:
        rel = relative_path(path, repo_dir)
        content = read_text(path)
        score = score_text(content, tokens) + score_text(rel.replace("/", " "), tokens) * 3.0
        if score > 0:
            file_scores.append((score, path, content))

    file_scores.sort(key=lambda item: item[0], reverse=True)
    candidates: list[CandidateSnippet] = []
    seen_windows: set[tuple[str, int, int]] = set()

    for file_score, path, content in file_scores[: max(8, max_candidates)]:
        rel = relative_path(path, repo_dir)
        lines = content.splitlines()
        line_scores = []
        for index, line in enumerate(lines, start=1):
            score = score_text(line, tokens)
            if re.match(r"\s*(def|class|function|const|let|var|public|private|protected)\b", line):
                score += 2.0
            if score > 0:
                line_scores.append((score, index))
        line_scores.sort(key=lambda item: item[0], reverse=True)

        selected_centers: list[int] = []
        for _, center in line_scores:
            if all(abs(center - previous) > context_lines * 2 for previous in selected_centers):
                selected_centers.append(center)
            if len(selected_centers) >= 3:
                break

        for center in selected_centers:
            start, end, rendered = line_window(lines, center, context_lines)
            key = (rel, start, end)
            if key in seen_windows:
                continue
            seen_windows.add(key)
            candidates.append(
                CandidateSnippet(
                    candidate_id=f"c{len(candidates) + 1}",
                    path=rel,
                    line_start=start,
                    line_end=end,
                    score=file_score,
                    text=rendered,
                )
            )
            if len(candidates) >= max_candidates:
                return candidates

    return candidates


def mapping_schema() -> dict[str, Any]:
    location_schema = {
        "type": "object",
        "properties": {
            "candidate_id": {"type": "string"},
            "path": {"type": "string"},
            "line_start": {"type": "integer"},
            "line_end": {"type": "integer"},
            "symbol": {"type": "string"},
            "relation": {"type": "string"},
            "confidence": {"type": "number"},
            "rationale": {"type": "string"},
        },
        "required": [
            "candidate_id",
            "path",
            "line_start",
            "line_end",
            "symbol",
            "relation",
            "confidence",
            "rationale",
        ],
        "additionalProperties": False,
    }
    return {
        "type": "object",
        "properties": {
            "status": {"type": "string", "enum": ["mapped", "unmapped"]},
            "component_summary": {"type": "string"},
            "code_locations": {"type": "array", "items": location_schema},
            "unmapped_reason": {"type": "string"},
        },
        "required": ["status", "component_summary", "code_locations", "unmapped_reason"],
        "additionalProperties": False,
    }


def extract_output_text(response: dict[str, Any]) -> str:
    if isinstance(response.get("output_text"), str):
        return response["output_text"]
    chunks: list[str] = []
    for item in response.get("output", []):
        for content in item.get("content", []):
            if content.get("type") in {"output_text", "text"} and isinstance(content.get("text"), str):
                chunks.append(content["text"])
    if chunks:
        return "".join(chunks)
    raise RuntimeError(f"Could not find output text in OpenAI response: {response}")


def list_openai_models(api_key: str, timeout: int) -> list[str]:
    request = Request(
        OPENAI_MODELS_URL,
        headers={"Authorization": f"Bearer {api_key}"},
        method="GET",
    )
    try:
        with urlopen(request, timeout=timeout) as response:
            raw = response.read().decode("utf-8")
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"OpenAI API HTTP {exc.code}: {detail}") from exc
    except URLError as exc:
        raise RuntimeError(f"Could not reach OpenAI models API: {exc.reason}") from exc

    data = json.loads(raw)
    return sorted(item["id"] for item in data.get("data", []) if isinstance(item.get("id"), str))


def choose_model(model_arg: str, available_models: list[str] | None) -> str:
    if model_arg != "auto":
        return model_arg
    if not available_models:
        raise RuntimeError("Cannot use --model auto without available model list.")
    available = set(available_models)
    for model in PREFERRED_MODELS:
        if model in available:
            return model
    gpt_models = sorted(model for model in available if model.startswith("gpt-"))
    if gpt_models:
        return gpt_models[-1]
    raise RuntimeError("No GPT model is available for this API key/project.")


def call_openai_mapping(
    *,
    api_key: str,
    model: str,
    repo_url: str,
    commit: str,
    kind: str,
    component: dict[str, Any],
    candidates: list[CandidateSnippet],
    timeout: int,
    max_retries: int,
) -> dict[str, Any]:
    system_prompt = (
        "You map machine learning paper components to implementation locations in a GitHub repo. "
        "Use only the provided candidate snippets. Do not invent files or line numbers. "
        "Choose exact line ranges inside candidate snippets where the concept is implemented. "
        "Return unmapped if none of the candidates plausibly implement the component."
    )
    candidate_payload = [
        {
            "candidate_id": candidate.candidate_id,
            "path": candidate.path,
            "line_start": candidate.line_start,
            "line_end": candidate.line_end,
            "snippet": candidate.text,
        }
        for candidate in candidates
    ]
    user_prompt = {
        "repository": repo_url,
        "commit": commit,
        "component_type": kind,
        "component": component,
        "candidate_snippets": candidate_payload,
        "instructions": [
            "Return at most 4 code_locations.",
            "Every returned path must exactly match one candidate path.",
            "Every returned line range must be contained inside that candidate's line range.",
            "Prefer implementation lines over comments/tests unless tests are the only evidence.",
            "Use confidence from 0.0 to 1.0.",
        ],
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
                "name": "paper_component_code_mapping",
                "strict": True,
                "schema": mapping_schema(),
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
            output = json.loads(extract_output_text(json.loads(raw)))
            return output
        except HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            last_error = RuntimeError(f"OpenAI API HTTP {exc.code}: {detail}")
        except (URLError, TimeoutError, json.JSONDecodeError, RuntimeError) as exc:
            last_error = exc

        if attempt < max_retries:
            time.sleep(2**attempt)

    raise RuntimeError(f"OpenAI mapping failed: {last_error}")


def validate_locations(
    mapping: dict[str, Any],
    candidates: list[CandidateSnippet],
    repo_url: str,
    commit: str,
) -> list[dict[str, Any]]:
    by_id = {candidate.candidate_id: candidate for candidate in candidates}
    validated: list[dict[str, Any]] = []
    for location in mapping.get("code_locations", []):
        candidate = by_id.get(str(location.get("candidate_id", "")))
        if not candidate:
            continue
        if location.get("path") != candidate.path:
            continue
        try:
            line_start = int(location["line_start"])
            line_end = int(location["line_end"])
        except (KeyError, TypeError, ValueError):
            continue
        line_start = max(candidate.line_start, min(line_start, candidate.line_end))
        line_end = max(line_start, min(line_end, candidate.line_end))
        path = candidate.path
        url = f"{repo_url}/blob/{commit}/{path}#L{line_start}"
        if line_end != line_start:
            url += f"-L{line_end}"
        validated.append(
            {
                "repository": repo_url,
                "commit": commit,
                "path": path,
                "line_start": line_start,
                "line_end": line_end,
                "url": url,
                "symbol": str(location.get("symbol", "")),
                "relation": str(location.get("relation", "")),
                "confidence": float(location.get("confidence", 0.0)),
                "rationale": str(location.get("rationale", "")),
                "candidate_id": candidate.candidate_id,
            }
        )
    return validated


def enrich_component(
    *,
    kind: str,
    component: dict[str, Any],
    repo_dir: Path,
    files: list[Path],
    repo_url: str,
    commit: str,
    api_key: str,
    model: str,
    max_candidates: int,
    context_lines: int,
    timeout: int,
    max_retries: int,
    save_candidates: bool,
) -> dict[str, Any]:
    candidates = find_candidate_snippets(
        repo_dir,
        files,
        kind,
        component,
        max_candidates=max_candidates,
        context_lines=context_lines,
    )
    enriched = dict(component)
    if save_candidates:
        enriched["code_mapping_candidates"] = [
            {
                "candidate_id": candidate.candidate_id,
                "path": candidate.path,
                "line_start": candidate.line_start,
                "line_end": candidate.line_end,
                "score": candidate.score,
            }
            for candidate in candidates
        ]

    if not candidates:
        enriched["code_locations"] = []
        enriched["code_mapping_status"] = "unmapped"
        enriched["code_mapping_reason"] = "No candidate snippets found by lexical repo search."
        return enriched

    mapping = call_openai_mapping(
        api_key=api_key,
        model=model,
        repo_url=repo_url,
        commit=commit,
        kind=kind,
        component=component,
        candidates=candidates,
        timeout=timeout,
        max_retries=max_retries,
    )
    locations = validate_locations(mapping, candidates, repo_url, commit)
    enriched["code_locations"] = locations
    enriched["code_mapping_status"] = "mapped" if locations else "unmapped"
    enriched["code_mapping_summary"] = mapping.get("component_summary", "")
    enriched["code_mapping_reason"] = "" if locations else mapping.get("unmapped_reason", "")
    return enriched


def default_output_path(input_path: Path) -> Path:
    return input_path.with_name(f"{input_path.stem}_with_code.json")


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Use an OpenAI LLM to map Paper2Run equations/figures to GitHub code locations."
    )
    parser.add_argument("input_json", type=Path, nargs="?", help="Paper2Run JSON path.")
    parser.add_argument("repo_url", nargs="?", help="GitHub repository URL.")
    parser.add_argument("-o", "--output", type=Path, help="Output JSON path.")
    parser.add_argument("--repo-dir", type=Path, help="Use an existing local clone instead of cloning.")
    parser.add_argument("--repo-cache", type=Path, default=Path(".paper2code_repos"))
    parser.add_argument("--ref", help="Optional branch, tag, or commit to checkout.")
    parser.add_argument(
        "--model",
        default=os.environ.get("OPENAI_MODEL", DEFAULT_MODEL),
        help="OpenAI model id, or 'auto' to choose the best accessible GPT model. Default: auto.",
    )
    parser.add_argument("--api-key-env", default="OPENAI_API_KEY")
    parser.add_argument(
        "--list-models",
        action="store_true",
        help="List models available to the configured API key/project and exit.",
    )
    parser.add_argument("--max-candidates", type=int, default=12)
    parser.add_argument("--context-lines", type=int, default=35)
    parser.add_argument("--max-file-bytes", type=int, default=350_000)
    parser.add_argument("--timeout", type=int, default=120)
    parser.add_argument("--max-retries", type=int, default=2)
    parser.add_argument("--equations-only", action="store_true")
    parser.add_argument("--figures-only", action="store_true")
    parser.add_argument("--save-candidates", action="store_true")
    parser.add_argument("--compact", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)

    if args.equations_only and args.figures_only:
        print("Choose at most one of --equations-only or --figures-only.", file=sys.stderr)
        return 2

    api_key = os.environ.get(args.api_key_env)
    if not api_key:
        print(f"Missing API key. Set {args.api_key_env}.", file=sys.stderr)
        return 2

    available_models: list[str] | None = None
    if args.list_models or args.model == "auto":
        available_models = list_openai_models(api_key, args.timeout)

    if args.list_models:
        for model_id in available_models or []:
            print(model_id)
        if available_models:
            print(f"\nAuto-selected model would be: {choose_model('auto', available_models)}")
        return 0

    if args.input_json is None or args.repo_url is None:
        print("input_json and repo_url are required unless --list-models is used.", file=sys.stderr)
        return 2

    input_path = args.input_json.expanduser().resolve()
    output_path = (args.output or default_output_path(input_path)).expanduser().resolve()

    if not input_path.exists():
        print(f"Input JSON not found: {input_path}", file=sys.stderr)
        return 2

    selected_model = choose_model(args.model, available_models)
    print(f"Using OpenAI model: {selected_model}")

    if not shutil.which("git"):
        print("git is required to clone/read the repository.", file=sys.stderr)
        return 2

    with input_path.open("r", encoding="utf-8") as file:
        data = json.load(file)

    _, _, normalized_repo_url = parse_github_repo(args.repo_url)
    repo_dir = ensure_repo(
        normalized_repo_url,
        args.repo_cache.expanduser().resolve(),
        args.repo_dir,
        args.ref,
    )
    commit = repo_commit(repo_dir)
    files = iter_code_files(repo_dir, args.max_file_bytes)

    enriched = dict(data)
    enriched["github_repository"] = {
        "url": normalized_repo_url,
        "commit": commit,
        "local_path": str(repo_dir),
        "mapping_method": "openai_llm_candidate_snippet_mapping",
        "model": selected_model,
    }

    equations = data.get("equations", []) if not args.figures_only else []
    figures = data.get("figures", []) if not args.equations_only else []
    enriched_equations = []
    enriched_figures = []

    for index, equation in enumerate(equations, start=1):
        print(f"Mapping equation {index}/{len(equations)}: {component_identity('equation', equation)}")
        enriched_equations.append(
            enrich_component(
                kind="equation",
                component=equation,
                repo_dir=repo_dir,
                files=files,
                repo_url=normalized_repo_url,
                commit=commit,
                api_key=api_key,
                model=selected_model,
                max_candidates=args.max_candidates,
                context_lines=args.context_lines,
                timeout=args.timeout,
                max_retries=args.max_retries,
                save_candidates=args.save_candidates,
            )
        )

    for index, figure in enumerate(figures, start=1):
        print(f"Mapping figure {index}/{len(figures)}: {component_identity('figure', figure)}")
        enriched_figures.append(
            enrich_component(
                kind="figure",
                component=figure,
                repo_dir=repo_dir,
                files=files,
                repo_url=normalized_repo_url,
                commit=commit,
                api_key=api_key,
                model=selected_model,
                max_candidates=args.max_candidates,
                context_lines=args.context_lines,
                timeout=args.timeout,
                max_retries=args.max_retries,
                save_candidates=args.save_candidates,
            )
        )

    if not args.figures_only:
        enriched["equations"] = enriched_equations
    if not args.equations_only:
        enriched["figures"] = enriched_figures

    enriched["code_mapping_counts"] = {
        "mapped_equations": sum(1 for item in enriched.get("equations", []) if item.get("code_mapping_status") == "mapped"),
        "total_equations": len(enriched.get("equations", [])),
        "mapped_figures": sum(1 for item in enriched.get("figures", []) if item.get("code_mapping_status") == "mapped"),
        "total_figures": len(enriched.get("figures", [])),
    }

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8") as file:
        if args.compact:
            json.dump(enriched, file, ensure_ascii=False, separators=(",", ":"))
        else:
            json.dump(enriched, file, ensure_ascii=False, indent=2)
            file.write("\n")

    counts = enriched["code_mapping_counts"]
    print(f"Saved enriched JSON: {output_path}")
    print(
        "Mapped "
        f"{counts['mapped_equations']}/{counts['total_equations']} equations and "
        f"{counts['mapped_figures']}/{counts['total_figures']} figures."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
