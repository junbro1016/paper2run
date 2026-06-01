#!/usr/bin/env python3
"""Extract equation and figure metadata from a paper PDF into JSON.

This script follows the API contract described in backend_description.pdf:

1. Upload a PDF to /papers/extract for equations.
2. Poll /jobs/{job_id} until completion.
3. Fetch /papers/{paper_id}/equations.
4. Upload the same PDF to /papers/figures/extract for figures.
5. Poll /jobs/{job_id} until completion.
6. Fetch /papers/{paper_id}/figures.
7. Save one combined JSON file.
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import sys
import time
import uuid
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


DEFAULT_BASE_URL = "https://paper2run.onrender.com"


class ApiError(RuntimeError):
    """Raised when the Paper2Run API returns an error response."""


def request_json(
    method: str,
    url: str,
    *,
    body: bytes | None = None,
    headers: dict[str, str] | None = None,
    timeout: int = 120,
) -> Any:
    request = Request(url, data=body, headers=headers or {}, method=method)
    try:
        with urlopen(request, timeout=timeout) as response:
            raw = response.read().decode("utf-8")
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise ApiError(f"HTTP {exc.code} for {url}: {detail}") from exc
    except URLError as exc:
        raise ApiError(f"Could not reach {url}: {exc.reason}") from exc

    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ApiError(f"Invalid JSON from {url}: {raw[:500]}") from exc


def build_multipart_file(field_name: str, file_path: Path) -> tuple[bytes, str]:
    boundary = f"----paper2run-{uuid.uuid4().hex}"
    content_type = mimetypes.guess_type(file_path.name)[0] or "application/pdf"
    file_bytes = file_path.read_bytes()

    parts = [
        f"--{boundary}\r\n".encode("utf-8"),
        (
            f'Content-Disposition: form-data; name="{field_name}"; '
            f'filename="{file_path.name}"\r\n'
        ).encode("utf-8"),
        f"Content-Type: {content_type}\r\n\r\n".encode("utf-8"),
        file_bytes,
        b"\r\n",
        f"--{boundary}--\r\n".encode("utf-8"),
    ]
    return b"".join(parts), boundary


def upload_pdf(base_url: str, endpoint: str, pdf_path: Path, force: bool) -> dict[str, Any]:
    query = f"?{urlencode({'force': 'true'})}" if force else ""
    url = f"{base_url.rstrip('/')}{endpoint}{query}"
    body, boundary = build_multipart_file("file", pdf_path)
    headers = {"Content-Type": f"multipart/form-data; boundary={boundary}"}
    return request_json("POST", url, body=body, headers=headers)


def wait_for_job(
    base_url: str,
    job_id: str,
    *,
    poll_interval: float,
    timeout_seconds: float,
) -> dict[str, Any]:
    deadline = time.monotonic() + timeout_seconds
    url = f"{base_url.rstrip('/')}/jobs/{job_id}"

    while True:
        job = request_json("GET", url)
        status = job.get("status")

        if status == "done":
            return job
        if status == "error":
            raise ApiError(f"Job {job_id} failed: {job.get('error', job)}")
        if status != "processing":
            raise ApiError(f"Unexpected job status for {job_id}: {job}")
        if time.monotonic() >= deadline:
            raise TimeoutError(f"Timed out waiting for job {job_id}")

        time.sleep(poll_interval)


def extract_job_result(
    base_url: str,
    endpoint: str,
    pdf_path: Path,
    *,
    force: bool,
    poll_interval: float,
    timeout_seconds: float,
) -> dict[str, Any]:
    started = upload_pdf(base_url, endpoint, pdf_path, force)

    if started.get("status") == "done":
        return started
    if started.get("status") != "processing" or "job_id" not in started:
        raise ApiError(f"Unexpected upload response from {endpoint}: {started}")

    return wait_for_job(
        base_url,
        started["job_id"],
        poll_interval=poll_interval,
        timeout_seconds=timeout_seconds,
    )


def fetch_equations(base_url: str, paper_id: str, role: str | None = None) -> list[dict[str, Any]]:
    query = f"?{urlencode({'role': role})}" if role else ""
    url = f"{base_url.rstrip('/')}/papers/{paper_id}/equations{query}"
    data = request_json("GET", url)
    if not isinstance(data, list):
        raise ApiError(f"Unexpected equations response: {data}")
    return data


def fetch_figures(base_url: str, paper_id: str) -> list[dict[str, Any]]:
    url = f"{base_url.rstrip('/')}/papers/{paper_id}/figures"
    data = request_json("GET", url)
    if not isinstance(data, list):
        raise ApiError(f"Unexpected figures response: {data}")
    return data


def default_output_path(pdf_path: Path) -> Path:
    return pdf_path.with_name(f"{pdf_path.stem}_paper2run.json")


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Upload a paper PDF to Paper2Run and save equations/figures as JSON."
    )
    parser.add_argument("pdf", type=Path, help="Path to the paper PDF file.")
    parser.add_argument(
        "-o",
        "--output",
        type=Path,
        help="Output JSON path. Defaults to <pdf_stem>_paper2run.json.",
    )
    parser.add_argument(
        "--base-url",
        default=DEFAULT_BASE_URL,
        help=f"Paper2Run API base URL. Default: {DEFAULT_BASE_URL}",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Ignore API cache and request re-extraction.",
    )
    parser.add_argument(
        "--role",
        choices=["model", "loss", "update", "inference", "definition"],
        help="Optional equation role filter.",
    )
    parser.add_argument(
        "--poll-interval",
        type=float,
        default=2.0,
        help="Seconds between job status checks. Default: 2.0",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=900.0,
        help="Maximum seconds to wait for each extraction job. Default: 900.",
    )
    parser.add_argument(
        "--pretty",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Pretty-print JSON output. Enabled by default.",
    )
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    pdf_path = args.pdf.expanduser().resolve()
    output_path = (args.output or default_output_path(pdf_path)).expanduser().resolve()

    if not pdf_path.exists():
        print(f"PDF not found: {pdf_path}", file=sys.stderr)
        return 2
    if pdf_path.suffix.lower() != ".pdf":
        print(f"Expected a .pdf file: {pdf_path}", file=sys.stderr)
        return 2

    print(f"Uploading for equation extraction: {pdf_path.name}")
    equation_job = extract_job_result(
        args.base_url,
        "/papers/extract",
        pdf_path,
        force=args.force,
        poll_interval=args.poll_interval,
        timeout_seconds=args.timeout,
    )
    equation_paper_id = equation_job["paper_id"]
    equations = fetch_equations(args.base_url, equation_paper_id, role=args.role)

    print(f"Uploading for figure extraction: {pdf_path.name}")
    figure_job = extract_job_result(
        args.base_url,
        "/papers/figures/extract",
        pdf_path,
        force=args.force,
        poll_interval=args.poll_interval,
        timeout_seconds=args.timeout,
    )
    figure_paper_id = figure_job["paper_id"]
    figures = fetch_figures(args.base_url, figure_paper_id)

    result = {
        "source_pdf": str(pdf_path),
        "filename": pdf_path.name,
        "base_url": args.base_url.rstrip("/"),
        "paper_id": equation_paper_id,
        "equation_job": equation_job,
        "figure_job": figure_job,
        "equations": equations,
        "figures": figures,
        "counts": {
            "equations": len(equations),
            "figures": len(figures),
        },
    }

    if figure_paper_id != equation_paper_id:
        result["figure_paper_id"] = figure_paper_id

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8") as file:
        if args.pretty:
            json.dump(result, file, ensure_ascii=False, indent=2)
            file.write("\n")
        else:
            json.dump(result, file, ensure_ascii=False, separators=(",", ":"))

    print(f"Saved JSON: {output_path}")
    print(f"Equations: {len(equations)} | Figures: {len(figures)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
