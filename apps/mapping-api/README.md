# Paper2Run Mapping API

This is a deployable HTTP wrapper around `scripts/link_paper_components_to_code.py`.

It exposes:

```text
GET  /health
POST /map
```

`POST /map` receives extracted Paper2Run JSON plus `github_repository.url`, then returns the same JSON enriched with `code_locations`.

## Local Run

```bash
export OPENAI_API_KEY="..."
python3 apps/mapping-api/server.py
```

Default local endpoint:

```text
http://127.0.0.1:8787/map
```

## Deployment

Required environment variable:

```text
OPENAI_API_KEY
```

Optional environment variables:

```text
OPENAI_MODEL=auto
HOST=0.0.0.0
PORT=8787
```

Most providers set `PORT` automatically. The included `Procfile` and `Dockerfile` both bind the service to `0.0.0.0`, which is required for external access.

Render deployment is configured by the repository-level `render.yaml`. The production endpoint is:

```text
https://paper2run-nevv.onrender.com/map
```

## Request Shape

```json
{
  "github_repository": {
    "url": "https://github.com/tensorflow/tensor2tensor"
  },
  "equations": [],
  "figures": []
}
```

## Response Shape

The response preserves the input fields and adds mapping metadata:

```json
{
  "github_repository": {
    "url": "https://github.com/tensorflow/tensor2tensor",
    "commit": "...",
    "mapping_method": "local_mapping_api_openai_llm_candidate_snippet_mapping",
    "model": "..."
  },
  "equations": [
    {
      "code_mapping_status": "mapped",
      "code_locations": []
    }
  ],
  "figures": [],
  "code_mapping_counts": {
    "mapped_equations": 1,
    "total_equations": 1,
    "mapped_figures": 0,
    "total_figures": 0
  }
}
```
