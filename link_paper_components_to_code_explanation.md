# `link_paper_components_to_code.py` 코드 설명

## 목적

`link_paper_components_to_code.py`는 Paper2Run으로 추출한 논문 구성요소 JSON을 받아서, 각 `equation`과 `figure`가 GitHub repository의 어떤 코드 위치와 대응되는지 찾아 JSON에 추가하는 스크립트입니다.

입력은 다음 두 가지입니다.

```bash
python3 link_paper_components_to_code.py <paper2run_json> <github_repo_url>
```

예시:

```bash
python3 link_paper_components_to_code.py Transformer_paper2run.json https://github.com/tensorflow/tensor2tensor
```

출력은 기본적으로 `<input_stem>_with_code.json` 형식입니다.

예시:

```text
Transformer_paper2run_with_code.json
```

## 전체 동작 흐름

스크립트는 크게 6단계로 동작합니다.

1. 입력 JSON과 GitHub repo URL을 읽습니다.
2. GitHub repo를 로컬 캐시에 clone하거나 기존 clone을 사용합니다.
3. repo 안의 코드 파일을 스캔합니다.
4. 각 equation/figure에 대해 관련 있어 보이는 코드 snippet 후보를 lexical search로 추립니다.
5. OpenAI Responses API를 호출해 후보 snippet 중 실제 대응 위치를 LLM이 선택하게 합니다.
6. LLM 응답을 검증한 뒤 원본 JSON에 `code_locations`를 추가해 저장합니다.

핵심 아이디어는 repo 전체를 LLM에 한 번에 넣지 않는 것입니다. 먼저 로컬에서 후보를 좁히고, LLM은 그 후보 안에서만 판단합니다. 이렇게 하면 비용이 줄고, 존재하지 않는 파일이나 라인을 만들어내는 위험도 줄어듭니다.

## 출력 JSON에 추가되는 필드

각 equation/figure 항목에는 다음 필드가 추가됩니다.

```json
{
  "code_locations": [
    {
      "repository": "https://github.com/tensorflow/tensor2tensor",
      "commit": "...",
      "path": "tensor2tensor/layers/common_attention.py",
      "line_start": 1602,
      "line_end": 1667,
      "url": "https://github.com/...",
      "symbol": "dot_product_attention",
      "relation": "computes softmax(QK^T)V",
      "confidence": 0.92,
      "rationale": "..."
    }
  ],
  "code_mapping_status": "mapped",
  "code_mapping_summary": "...",
  "code_mapping_reason": ""
}
```

최상위에는 다음 정보도 추가됩니다.

```json
{
  "github_repository": {
    "url": "...",
    "commit": "...",
    "local_path": "...",
    "mapping_method": "openai_llm_candidate_snippet_mapping",
    "model": "..."
  },
  "code_mapping_counts": {
    "mapped_equations": 8,
    "total_equations": 8,
    "mapped_figures": 2,
    "total_figures": 2
  }
}
```

## 주요 상수

### `DEFAULT_MODEL`

```python
DEFAULT_MODEL = "auto"
```

기본 모델 선택 방식입니다. 특정 모델을 고정하지 않고, API key가 접근 가능한 모델 목록을 조회한 뒤 좋은 모델을 자동 선택합니다.

### `PREFERRED_MODELS`

```python
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
```

`--model auto`일 때 이 순서대로 접근 가능한 모델을 찾습니다. 리스트 앞쪽에 있는 모델일수록 우선순위가 높습니다.

### `CODE_EXTENSIONS`

검색 대상으로 삼을 코드 파일 확장자 목록입니다. Python, JavaScript, TypeScript, C/C++, Java, Go, Rust, YAML, JSON 등을 포함합니다.

### `SKIP_DIRS`

검색에서 제외할 디렉터리입니다. 예를 들어 `.git`, `node_modules`, `venv`, `build`, `dist`, `third_party`, `vendor` 등입니다.

### `STOPWORDS`

후보 검색용 token을 만들 때 제거할 일반 단어 목록입니다. `the`, `and`, `model`, `figure`, `equation`처럼 검색 노이즈가 큰 단어를 제거합니다.

## 데이터 구조

### `CandidateSnippet`

```python
@dataclass
class CandidateSnippet:
    candidate_id: str
    path: str
    line_start: int
    line_end: int
    score: float
    text: str
```

LLM에 전달할 후보 코드 조각입니다.

필드 의미:

- `candidate_id`: LLM이 참조할 후보 ID입니다. 예: `c1`, `c2`
- `path`: repo 기준 상대 파일 경로입니다.
- `line_start`, `line_end`: snippet의 라인 범위입니다.
- `score`: lexical search 점수입니다.
- `text`: 라인 번호가 포함된 코드 snippet 본문입니다.

## GitHub repo 처리 함수

### `run_git`

```python
def run_git(args: list[str], cwd: Path | None = None) -> str:
```

`git` 명령을 실행하고 stdout을 반환합니다. 실패하면 stderr를 포함한 `RuntimeError`를 발생시킵니다.

### `parse_github_repo`

```python
def parse_github_repo(repo_url: str) -> tuple[str, str, str]:
```

GitHub URL에서 `owner`, `repo`, 정규화된 repo URL을 추출합니다.

지원 형식:

```text
https://github.com/<owner>/<repo>
https://github.com/<owner>/<repo>.git
```

### `ensure_repo`

```python
def ensure_repo(repo_url, cache_root, repo_dir, ref) -> Path:
```

repo를 로컬에 준비합니다.

- `--repo-dir`이 있으면 기존 clone을 사용합니다.
- 없으면 `.paper2code_repos/<owner>__<repo>`에 shallow clone합니다.
- `--ref`가 있으면 해당 branch/tag/commit을 checkout합니다.

### `repo_commit`

현재 checkout된 commit SHA를 가져옵니다.

### `iter_code_files`

repo 안에서 검색할 코드 파일 목록을 만듭니다.

제외 조건:

- `SKIP_DIRS` 안에 있는 파일
- 확장자가 `CODE_EXTENSIONS`에 없는 파일
- `--max-file-bytes`보다 큰 파일

## Paper component 전처리 함수

### `component_identity`

로그 출력용 component 이름을 만듭니다.

예:

```text
equation_1
figure_2
```

### `component_text`

equation/figure에서 검색에 쓸 텍스트를 추출합니다.

equation은 다음 필드를 사용합니다.

- `latex`
- `description`
- `context`
- `core_reason`
- `section_hint`
- `role`

figure는 다음 필드를 사용합니다.

- `caption`
- `figure_type`
- `key_insight`

### `tokenize`

검색용 token을 만듭니다.

동작:

- 영문/숫자/underscore 기반 token 추출
- 너무 짧은 token 제거
- `STOPWORDS` 제거
- 길이가 긴 token을 우선적으로 최대 80개 선택

### `add_domain_expansions`

논문/ML 도메인에서 자주 쓰는 표현을 기반으로 검색어를 확장합니다.

예:

- `attention`이 있으면 `query`, `key`, `value`, `qkv` 추가
- `multihead`가 있으면 `split_heads`, `combine_heads` 추가
- `positional`이 있으면 `timing`, `sin`, `cos` 추가
- `smoothing`이 있으면 `label_smoothing`, `cross_entropy` 추가

이 부분이 후보 검색 품질에 꽤 중요합니다.

## 후보 snippet 검색

### `score_text`

텍스트 안에 token이 얼마나 많이 등장하는지 점수화합니다.

underscore가 들어간 token은 코드 식별자일 가능성이 높으므로 더 높은 가중치를 줍니다.

### `line_window`

특정 중심 라인 주변으로 context window를 만듭니다.

예를 들어 `context_lines=35`이면 중심 라인 기준 앞뒤 35줄을 snippet으로 묶습니다.

### `find_candidate_snippets`

```python
def find_candidate_snippets(... ) -> list[CandidateSnippet]:
```

각 equation/figure에 대해 LLM에게 보여줄 후보 코드 조각을 찾는 핵심 함수입니다.

동작 순서:

1. component에서 텍스트를 추출합니다.
2. token을 만들고 domain expansion을 적용합니다.
3. repo의 코드 파일들을 점수화합니다.
4. 점수가 높은 파일들을 선택합니다.
5. 각 파일 안에서 점수가 높은 라인을 찾습니다.
6. 해당 라인 주변을 snippet으로 잘라 `CandidateSnippet` 리스트를 만듭니다.

기본 후보 수는 `--max-candidates 12`입니다.

## OpenAI 모델 선택

### `list_openai_models`

```python
def list_openai_models(api_key: str, timeout: int) -> list[str]:
```

OpenAI Models API를 호출해 현재 API key/project에서 접근 가능한 모델 목록을 가져옵니다.

명령어로도 확인할 수 있습니다.

```bash
python3 link_paper_components_to_code.py --list-models
```

### `choose_model`

```python
def choose_model(model_arg: str, available_models: list[str] | None) -> str:
```

실제로 사용할 모델을 결정합니다.

- `--model gpt-4.1`처럼 직접 지정하면 그대로 사용합니다.
- `--model auto`이면 `PREFERRED_MODELS` 순서대로 접근 가능한 모델을 고릅니다.
- 선호 모델이 없으면 접근 가능한 `gpt-` 모델 중 하나를 fallback으로 선택합니다.

## LLM 호출

### `mapping_schema`

OpenAI Structured Outputs에 사용할 JSON Schema를 정의합니다.

LLM은 반드시 다음 구조로 응답해야 합니다.

```json
{
  "status": "mapped",
  "component_summary": "...",
  "code_locations": [
    {
      "candidate_id": "c1",
      "path": "...",
      "line_start": 10,
      "line_end": 20,
      "symbol": "...",
      "relation": "...",
      "confidence": 0.9,
      "rationale": "..."
    }
  ],
  "unmapped_reason": ""
}
```

Structured Outputs를 쓰기 때문에 일반 텍스트 응답보다 파싱 안정성이 높습니다.

### `call_openai_mapping`

```python
def call_openai_mapping(... ) -> dict[str, Any]:
```

OpenAI Responses API를 호출해 실제 매핑 판단을 요청합니다.

LLM에게 전달하는 내용:

- repo URL
- commit SHA
- component type: `equation` 또는 `figure`
- component 원본 JSON
- 후보 snippet 목록
- 매핑 규칙

중요한 prompt 규칙:

- 제공된 후보 snippet만 사용
- 없는 파일이나 라인 번호를 만들지 않기
- line range는 candidate 범위 안에 있어야 함
- 구현 라인을 우선하고, 테스트/주석은 보조로만 사용
- 후보 중 적절한 것이 없으면 `unmapped`

API 호출 실패 시 `--max-retries` 횟수만큼 재시도합니다.

### `extract_output_text`

Responses API 응답에서 실제 output text를 꺼냅니다. 응답 형태가 약간 달라져도 처리할 수 있게 `output_text`와 `output[].content[]` 둘 다 확인합니다.

## LLM 응답 검증

### `validate_locations`

LLM이 반환한 code location을 검증합니다.

검증 조건:

- `candidate_id`가 실제 후보에 존재해야 합니다.
- 반환된 `path`가 후보의 `path`와 정확히 같아야 합니다.
- `line_start`, `line_end`가 후보 snippet 범위 안에 있어야 합니다.

라인 번호가 후보 범위를 살짝 벗어나면 candidate 범위 안으로 clamp합니다. 완전히 잘못된 candidate/path는 버립니다.

검증 후 GitHub URL도 생성합니다.

```text
https://github.com/<owner>/<repo>/blob/<commit>/<path>#L<start>-L<end>
```

## Component enrichment

### `enrich_component`

하나의 equation 또는 figure를 처리하는 함수입니다.

동작:

1. `find_candidate_snippets`로 후보 snippet을 찾습니다.
2. 후보가 없으면 `unmapped`로 기록합니다.
3. 후보가 있으면 `call_openai_mapping`으로 LLM 매핑을 요청합니다.
4. `validate_locations`로 응답을 검증합니다.
5. 원본 component에 `code_locations`, `code_mapping_status`, `code_mapping_summary` 등을 붙여 반환합니다.

`--save-candidates` 옵션을 켜면 LLM에 전달된 후보 목록 요약도 JSON에 저장합니다. 디버깅할 때 유용합니다.

## CLI 처리

### `parse_args`

명령행 옵션을 정의합니다.

주요 옵션:

```bash
--model MODEL
```

사용할 OpenAI 모델입니다. 기본값은 `auto`입니다.

```bash
--list-models
```

현재 API key/project에서 접근 가능한 모델 목록만 출력하고 종료합니다.

```bash
--repo-dir REPO_DIR
```

이미 clone된 local repo를 사용합니다.

```bash
--ref REF
```

특정 branch/tag/commit을 checkout합니다.

```bash
--equations-only
--figures-only
```

equation 또는 figure만 매핑합니다.

```bash
--save-candidates
```

후보 snippet 메타데이터를 결과 JSON에 함께 저장합니다.

```bash
--max-candidates
--context-lines
--max-file-bytes
```

후보 검색 범위와 snippet 크기를 조절합니다.

### `main`

전체 실행 흐름을 조율하는 entry point입니다.

주요 처리:

1. CLI 인자 파싱
2. API key 확인
3. `--list-models` 처리
4. 모델 자동 선택
5. repo 준비
6. 코드 파일 목록 생성
7. equations loop
8. figures loop
9. mapping count 계산
10. enriched JSON 저장

## 실행 예시

### 기본 실행

```bash
export OPENAI_API_KEY="..."
python3 link_paper_components_to_code.py Transformer_paper2run.json https://github.com/tensorflow/tensor2tensor
```

### 접근 가능한 모델 확인

```bash
python3 link_paper_components_to_code.py --list-models
```

### 모델 직접 지정

```bash
python3 link_paper_components_to_code.py Transformer_paper2run.json https://github.com/tensorflow/tensor2tensor --model gpt-4.1
```

### Equation만 매핑

```bash
python3 link_paper_components_to_code.py Transformer_paper2run.json https://github.com/tensorflow/tensor2tensor --equations-only
```

### 후보 snippet도 결과에 저장

```bash
python3 link_paper_components_to_code.py Transformer_paper2run.json https://github.com/tensorflow/tensor2tensor --save-candidates
```

## 설계상 장점

- 특정 논문이나 repo에 하드코딩되어 있지 않습니다.
- repo URL과 Paper2Run JSON만 바꾸면 다른 논문에도 적용할 수 있습니다.
- LLM이 repo 전체가 아니라 후보 snippet만 보므로 비용이 낮습니다.
- Structured Outputs로 JSON 파싱 안정성을 높였습니다.
- LLM 응답을 그대로 믿지 않고 file/path/line range를 검증합니다.
- `--list-models`와 `--model auto`로 project별 모델 권한 차이를 처리합니다.

## 현재 한계

- 후보 검색은 lexical search 기반입니다. component 설명과 코드 식별자가 다르면 좋은 후보를 놓칠 수 있습니다.
- 대형 repo에서는 `--max-file-bytes`, `SKIP_DIRS`, 확장자 필터 때문에 일부 구현 파일이 제외될 수 있습니다.
- LLM은 후보 안에서만 고르므로, 후보 검색이 실패하면 매핑도 실패합니다.
- 현재는 GitHub repo URL만 지원합니다.
- PDF나 논문 원문을 직접 다시 읽지는 않고, Paper2Run JSON에 저장된 metadata를 기반으로 판단합니다.

## 개선 아이디어

- tree-sitter 기반 함수/클래스 단위 indexing 추가
- README, docs, tests를 별도 가중치로 분리
- embedding search를 추가해 lexical mismatch 개선
- 한 component를 여러 search query로 나눠 후보 다양성 증가
- LLM이 후보 부족을 감지하면 추가 keyword를 제안하고 2차 검색하는 loop 추가
- 결과 JSON에 사람이 검수한 label을 저장하는 workflow 추가

