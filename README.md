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
│   ├── frontend/          # Browser UI for extraction, mapping, and visualization
│   └── mapping-api/       # Deployable HTTP wrapper for code-location mapping
├── data/
│   ├── raw/               # Local-only paper PDFs and source inputs
│   └── processed/         # Local-only generated JSON outputs
├── docs/
│   └── link_paper_components_to_code_explanation.md
├── scripts/
│   ├── extract_paper_json.py
│   └── link_paper_components_to_code.py
├── Dockerfile             # Mapping API container
├── render.yaml            # Render web service blueprint
└── README.md
```

## Prerequisites

- Python 3.10 or later recommended
- `git`
- Network access to Paper2Run and GitHub
- `OPENAI_API_KEY` for code-location mapping

The scripts and mapping API use Python standard library modules only.

## Production Endpoints

The frontend ships with these defaults:

```text
Paper2Run API: https://paper2run.onrender.com
Mapping API:   https://paper2run-nevv.onrender.com/map
```

The Paper2Run API exposes the end-to-end pipeline documented at:

```text
https://paper2run.onrender.com/docs
```

The Mapping API healthcheck is:

```text
https://paper2run-nevv.onrender.com/health
```

## Frontend

The frontend is a static browser app under `apps/frontend`. It calls the existing Paper2Run pipeline API directly for extraction, grounding, and visualization. API URL edits are stored in browser local storage so local overrides survive refreshes.

Run it locally:

```bash
cd apps/frontend
python3 -m http.server 5173
```

Then open:

```text
http://localhost:5173
```

The UI supports:

- PDF upload
- GitHub repository URL input
- Paper2Run API base URL configuration
- pipeline execution through `POST /paper2run/run`
- polling through `GET /paper2run/jobs/{job_id}`
- result loading through `GET /paper2run/jobs/{job_id}/result`
- equation/figure visualization
- loading an already enriched JSON file
- downloading the current result JSON

### Deploying the Frontend

Deploy `apps/frontend` as a static Vercel project:

1. Import this GitHub repository in Vercel.
2. Set the Vercel project root directory to `apps/frontend`.
3. Leave build and install commands empty.
4. Deploy.

`apps/frontend/vercel.json` enables clean static URLs. No frontend environment variables are required because the production Paper2Run pipeline API URL is defined in `apps/frontend/src/app.js`.

### Mapping API Contract

The extraction backend described in `backend_description.pdf` does not expose code-location mapping. The mapping API is a standalone integration point for enriching already extracted Paper2Run JSON.

For local development, run the included wrapper around `scripts/link_paper_components_to_code.py`:

```bash
export OPENAI_API_KEY="..."
python3 apps/mapping-api/server.py
```

Use this URL from a compatible UI or direct API client:

```text
http://127.0.0.1:8787/map
```

### Deploying the Mapping API

The mapping API can be deployed as a small Python service. The repository includes both a `Procfile` and a `Dockerfile`.

Required environment variable:

```text
OPENAI_API_KEY
```

Optional environment variables:

```text
OPENAI_MODEL=auto
HOST=0.0.0.0
PORT=<set by provider>
```

On Render:

1. Create a new Web Service from this GitHub repository.
2. Set `OPENAI_API_KEY` in the service environment variables.
3. Keep the repository root as the service root so Render can use the included `Dockerfile`.
4. Confirm the healthcheck path is `/health`.
5. Deploy.

The active production Mapping API is:

```text
https://paper2run-nevv.onrender.com/map
```

For another provider, use the default start command from `Procfile`, or set:

```bash
python3 apps/mapping-api/server.py --host 0.0.0.0
```

Direct Mapping API clients send:

```http
POST <mapping-api-url>
Content-Type: application/json
```

Request body:

```json
{
  "filename": "paper.pdf",
  "paper_id": "uuid",
  "base_url": "https://paper2run.onrender.com",
  "github_repository": {
    "url": "https://github.com/owner/repo"
  },
  "equations": [],
  "figures": []
}
```

The mapping API should return the same shape as the enriched `*_paper2run_with_code.json` files produced by `scripts/link_paper_components_to_code.py`, especially `equations[].code_locations` and `figures[].code_locations`.

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
