# Paper2Run

Paper2Run is a small research tooling workspace for turning paper-level artifacts into structured data that can later power a frontend experience.

The current backend-side workflow has two parts:

1. Extract equations and figures from a paper PDF into JSON.
2. Map each extracted equation or figure to likely implementation locations in a GitHub repository using an OpenAI model.

This repository intentionally does not track specific paper PDFs or generated extraction JSON files. Keep those in `data/raw/` and `data/processed/` locally.

## Repository Layout

```text
.
├── apps/
│   └── frontend/          # Reserved for a future frontend app
├── data/
│   ├── raw/               # Local-only paper PDFs and source inputs
│   └── processed/         # Local-only generated JSON outputs
├── docs/
│   └── link_paper_components_to_code_explanation.md
├── scripts/
│   ├── extract_paper_json.py
│   └── link_paper_components_to_code.py
└── README.md
```

## Prerequisites

- Python 3.10 or later recommended
- `git`
- Network access to Paper2Run and GitHub
- `OPENAI_API_KEY` for code-location mapping

The scripts use Python standard library modules only.

## 1. Extract Equations and Figures

Use `scripts/extract_paper_json.py` to upload a paper PDF to the Paper2Run API and save the extracted equations and figures as JSON.

```bash
python3 scripts/extract_paper_json.py data/raw/<paper>.pdf -o data/processed/<paper>_paper2run.json
```

Useful options:

```bash
python3 scripts/extract_paper_json.py data/raw/<paper>.pdf --force
python3 scripts/extract_paper_json.py data/raw/<paper>.pdf --role model
```

The output JSON includes:

- source PDF metadata
- equation extraction job metadata
- figure extraction job metadata
- `equations[]`
- `figures[]`

## 2. Map Paper Components to Code

Use `scripts/link_paper_components_to_code.py` to map extracted equations and figures to code locations in a GitHub repository.

```bash
export OPENAI_API_KEY="..."
python3 scripts/link_paper_components_to_code.py \
  data/processed/<paper>_paper2run.json \
  https://github.com/<owner>/<repo> \
  -o data/processed/<paper>_paper2run_with_code.json
```

The script:

1. clones or reuses the target GitHub repository,
2. searches for relevant candidate code snippets,
3. asks an OpenAI model to choose matching code locations,
4. validates returned file paths and line ranges,
5. writes an enriched JSON file.

By default, the model is selected with `--model auto`. You can inspect available models:

```bash
python3 scripts/link_paper_components_to_code.py --list-models
```

Or force a specific model:

```bash
python3 scripts/link_paper_components_to_code.py \
  data/processed/<paper>_paper2run.json \
  https://github.com/<owner>/<repo> \
  --model gpt-4.1
```

## Output Shape

Each mapped equation or figure receives fields like:

```json
{
  "code_locations": [
    {
      "repository": "https://github.com/<owner>/<repo>",
      "commit": "...",
      "path": "path/to/file.py",
      "line_start": 10,
      "line_end": 24,
      "url": "https://github.com/<owner>/<repo>/blob/<commit>/path/to/file.py#L10-L24",
      "symbol": "function_or_class_name",
      "relation": "short description of the connection",
      "confidence": 0.85,
      "rationale": "why this code matches the paper component"
    }
  ],
  "code_mapping_status": "mapped"
}
```

## Notes for Frontend Work

The future frontend can consume files from `data/processed/` during local development. For production, prefer serving processed JSON through an API or object storage rather than committing generated paper artifacts to the repository.

Recommended frontend assumptions:

- `equations[]` and `figures[]` are the primary display collections.
- `code_locations[]` can be rendered as GitHub links with confidence/rationale metadata.
- The top-level `github_repository` and `code_mapping_counts` fields are useful for summary views.

## Documentation

See [docs/link_paper_components_to_code_explanation.md](docs/link_paper_components_to_code_explanation.md) for a detailed walkthrough of the code-location mapping script.
