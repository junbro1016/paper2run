const DEFAULT_API_BASE_URL = "https://paper2run-production.up.railway.app";

const state = {
  file: null,
  repoUrl: "",
  apiBaseUrl: DEFAULT_API_BASE_URL,
  mappingApiUrl: "",
  paper: null,
  equations: [],
  figures: [],
  activeTab: "overview",
  statuses: [],
};

const elements = {
  pdfInput: document.querySelector("#pdfInput"),
  jsonInput: document.querySelector("#jsonInput"),
  fileMeta: document.querySelector("#fileMeta"),
  repoUrl: document.querySelector("#repoUrl"),
  apiBaseUrl: document.querySelector("#apiBaseUrl"),
  mappingApiUrl: document.querySelector("#mappingApiUrl"),
  extractBtn: document.querySelector("#extractBtn"),
  mapBtn: document.querySelector("#mapBtn"),
  downloadBtn: document.querySelector("#downloadBtn"),
  statusList: document.querySelector("#statusList"),
  paperTitle: document.querySelector("#paperTitle"),
  equationCount: document.querySelector("#equationCount"),
  figureCount: document.querySelector("#figureCount"),
  mappedCount: document.querySelector("#mappedCount"),
  overviewContent: document.querySelector("#overviewContent"),
  emptyState: document.querySelector("#emptyState"),
  equationList: document.querySelector("#equationList"),
  figureList: document.querySelector("#figureList"),
  codeMap: document.querySelector("#codeMap"),
  tabs: [...document.querySelectorAll(".tab")],
};

elements.apiBaseUrl.value = DEFAULT_API_BASE_URL;

function addStatus(label, stateName = "pending") {
  state.statuses.unshift({ label, state: stateName, at: new Date().toLocaleTimeString() });
  state.statuses = state.statuses.slice(0, 8);
  renderStatus();
}

function renderStatus() {
  elements.statusList.innerHTML = state.statuses
    .map((item) => `<li data-state="${item.state}">${escapeHtml(item.at)} · ${escapeHtml(item.label)}</li>`)
    .join("");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function apiUrl(path) {
  return `${state.apiBaseUrl.replace(/\/$/, "")}${path}`;
}

function setBusy(isBusy) {
  elements.extractBtn.disabled = isBusy || !state.file;
  elements.mapBtn.disabled = isBusy || !canMap();
  elements.downloadBtn.disabled = isBusy || !hasResults();
}

function hasResults() {
  return state.equations.length > 0 || state.figures.length > 0;
}

function canMap() {
  return hasResults() && Boolean(state.repoUrl.trim()) && Boolean(state.mappingApiUrl.trim());
}

async function uploadForExtraction(endpoint) {
  const formData = new FormData();
  formData.append("file", state.file);

  const response = await fetch(apiUrl(endpoint), {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    throw new Error(`${endpoint} failed with HTTP ${response.status}`);
  }

  return response.json();
}

async function waitForJob(jobId) {
  while (true) {
    const response = await fetch(apiUrl(`/jobs/${jobId}`));
    if (!response.ok) {
      throw new Error(`Job polling failed with HTTP ${response.status}`);
    }
    const job = await response.json();
    if (job.status === "done") return job;
    if (job.status === "error") throw new Error(job.error || "Extraction job failed");
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

async function resolveExtraction(endpoint) {
  const started = await uploadForExtraction(endpoint);
  if (started.status === "done") return started;
  if (!started.job_id) {
    throw new Error(`Unexpected response from ${endpoint}`);
  }
  return waitForJob(started.job_id);
}

async function fetchEquations(paperId) {
  const response = await fetch(apiUrl(`/papers/${paperId}/equations`));
  if (!response.ok) throw new Error(`Equation fetch failed with HTTP ${response.status}`);
  return response.json();
}

async function fetchFigures(paperId) {
  const response = await fetch(apiUrl(`/papers/${paperId}/figures`));
  if (!response.ok) throw new Error(`Figure fetch failed with HTTP ${response.status}`);
  return response.json();
}

async function runExtraction() {
  if (!state.file) return;

  setBusy(true);
  state.equations = [];
  state.figures = [];
  state.paper = { filename: state.file.name };
  render();

  try {
    addStatus("Uploading PDF for equations", "pending");
    const equationJob = await resolveExtraction("/papers/extract");
    const paperId = equationJob.paper_id;
    state.paper = { ...state.paper, paper_id: paperId, equation_job: equationJob };
    state.equations = await fetchEquations(paperId);
    addStatus(`Loaded ${state.equations.length} equations`, "done");

    try {
      addStatus("Uploading PDF for figures", "pending");
      const figureJob = await resolveExtraction("/papers/figures/extract");
      const figurePaperId = figureJob.paper_id || paperId;
      state.paper = { ...state.paper, figure_job: figureJob, figure_paper_id: figurePaperId };
      state.figures = await fetchFigures(figurePaperId);
      addStatus(`Loaded ${state.figures.length} figures`, "done");
    } catch (error) {
      addStatus(`Figure extraction unavailable: ${error.message}`, "error");
    }

    render();
  } catch (error) {
    addStatus(error.message, "error");
  } finally {
    setBusy(false);
  }
}

async function runMapping() {
  if (!canMap()) return;
  setBusy(true);
  addStatus("Requesting code-location mapping", "pending");

  const payload = buildOutputJson();
  payload.github_repository = {
    ...(payload.github_repository || {}),
    url: state.repoUrl.trim(),
  };

  try {
    const response = await fetch(state.mappingApiUrl.trim(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      throw new Error(`Mapping API failed with HTTP ${response.status}`);
    }
    const mapped = await response.json();
    state.paper = {
      ...state.paper,
      github_repository: mapped.github_repository || payload.github_repository,
      code_mapping_counts: mapped.code_mapping_counts,
    };
    state.equations = Array.isArray(mapped.equations) ? mapped.equations : state.equations;
    state.figures = Array.isArray(mapped.figures) ? mapped.figures : state.figures;
    addStatus("Code mapping complete", "done");
    render();
  } catch (error) {
    addStatus(error.message, "error");
  } finally {
    setBusy(false);
  }
}

function buildOutputJson() {
  return {
    filename: state.paper?.filename || state.file?.name || "paper.pdf",
    paper_id: state.paper?.paper_id,
    base_url: state.apiBaseUrl,
    github_repository: state.paper?.github_repository || { url: state.repoUrl.trim() },
    equation_job: state.paper?.equation_job,
    figure_job: state.paper?.figure_job,
    equations: state.equations,
    figures: state.figures,
    counts: {
      equations: state.equations.length,
      figures: state.figures.length,
    },
    code_mapping_counts: {
      mapped_equations: state.equations.filter((item) => item.code_mapping_status === "mapped").length,
      total_equations: state.equations.length,
      mapped_figures: state.figures.filter((item) => item.code_mapping_status === "mapped").length,
      total_figures: state.figures.length,
    },
  };
}

function downloadJson() {
  const blob = new Blob([JSON.stringify(buildOutputJson(), null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  const stem = (state.paper?.filename || "paper").replace(/\.pdf$/i, "");
  anchor.href = url;
  anchor.download = `${stem}_paper2run_with_code.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

async function loadJson(file) {
  const text = await file.text();
  const data = JSON.parse(text);
  state.paper = {
    filename: data.filename || file.name,
    paper_id: data.paper_id,
    github_repository: data.github_repository,
    code_mapping_counts: data.code_mapping_counts,
  };
  state.repoUrl = data.github_repository?.url || state.repoUrl;
  elements.repoUrl.value = state.repoUrl;
  state.equations = Array.isArray(data.equations) ? data.equations : [];
  state.figures = Array.isArray(data.figures) ? data.figures : [];
  addStatus(`Loaded ${file.name}`, "done");
  render();
}

function render() {
  const mapped = [...state.equations, ...state.figures].filter(
    (item) => item.code_mapping_status === "mapped" || item.code_locations?.length,
  ).length;

  elements.paperTitle.textContent = state.paper?.filename || state.file?.name || "Upload a paper to begin";
  elements.equationCount.textContent = state.equations.length;
  elements.figureCount.textContent = state.figures.length;
  elements.mappedCount.textContent = mapped;
  elements.emptyState.style.display = hasResults() ? "none" : "grid";
  elements.overviewContent.style.display = hasResults() ? "grid" : "none";

  renderOverview();
  renderEquations();
  renderFigures();
  renderCodeMap();
  setBusy(false);
}

function renderOverview() {
  if (!hasResults()) {
    elements.overviewContent.innerHTML = "";
    return;
  }

  const topEquations = state.equations.slice(0, 4);
  const topFigures = state.figures.slice(0, 3);
  elements.overviewContent.innerHTML = `
    <section class="panel">
      <h3>Core equations</h3>
      ${topEquations.map(renderEquationSummary).join("") || "<p>No equations loaded.</p>"}
    </section>
    <section class="panel">
      <h3>Figures</h3>
      ${topFigures.map(renderFigureSummary).join("") || "<p>No figures loaded.</p>"}
    </section>
  `;
}

function renderEquationSummary(equation) {
  return `
    <article class="summary-item">
      <p><strong>#${escapeHtml(equation.eq_number)}</strong> ${escapeHtml(equation.description || equation.section_hint || "Equation")}</p>
      <div class="badge-row">
        <span class="badge">${escapeHtml(equation.role || "unknown")}</span>
        <span class="badge ${equation.importance_hint === "high" ? "high" : ""}">${escapeHtml(equation.importance_hint || "medium")}</span>
      </div>
    </article>
  `;
}

function renderFigureSummary(figure) {
  return `
    <article class="summary-item">
      <p><strong>Figure ${escapeHtml(figure.fig_number)}</strong> ${escapeHtml(figure.caption || figure.key_insight || "Figure")}</p>
    </article>
  `;
}

function renderEquations() {
  elements.equationList.innerHTML =
    state.equations.map(renderEquationCard).join("") || emptyMessage("No equations loaded.");
}

function renderEquationCard(equation) {
  return `
    <article class="component-card">
      <div class="card-header">
        <h3>Equation ${escapeHtml(equation.eq_number)}</h3>
        <div class="badge-row">
          <span class="badge">${escapeHtml(equation.role || "unknown")}</span>
          <span class="badge ${equation.importance_hint === "high" ? "high" : ""}">${escapeHtml(equation.importance_hint || "medium")}</span>
          <span class="badge">page ${escapeHtml(equation.page || "-")}</span>
        </div>
      </div>
      <pre class="latex">${escapeHtml(equation.latex || "")}</pre>
      <p>${escapeHtml(equation.description || "")}</p>
      <p>${escapeHtml(equation.core_reason || "")}</p>
      ${renderLocations(equation.code_locations)}
    </article>
  `;
}

function renderFigures() {
  elements.figureList.innerHTML =
    state.figures.map(renderFigureCard).join("") || emptyMessage("No figures loaded.");
}

function renderFigureCard(figure) {
  const image = figure.image_url
    ? `<img src="${escapeHtml(figure.image_url)}" alt="${escapeHtml(figure.caption || "Extracted figure")}" />`
    : "";
  return `
    <article class="figure-card">
      ${image}
      <div class="figure-body">
        <div class="card-header">
          <h3>Figure ${escapeHtml(figure.fig_number)}</h3>
          <span class="badge">${escapeHtml(figure.figure_type || "figure")}</span>
        </div>
        <p>${escapeHtml(figure.caption || "")}</p>
        <p>${escapeHtml(figure.key_insight || "")}</p>
        ${renderLocations(figure.code_locations)}
      </div>
    </article>
  `;
}

function renderLocations(locations = []) {
  if (!locations.length) {
    return `<div class="meta-line">No code locations mapped yet.</div>`;
  }
  return `
    <div class="location-list">
      ${locations
        .map(
          (location) => `
          <a class="code-link" href="${escapeHtml(location.url || "#")}" target="_blank" rel="noreferrer">
            <span class="code-symbol">${escapeHtml(location.symbol || "code")}</span>
            <span class="code-path">${escapeHtml(location.path || "")}:${escapeHtml(location.line_start || "")}-${escapeHtml(location.line_end || "")}</span>
          </a>
        `,
        )
        .join("")}
    </div>
  `;
}

function renderCodeMap() {
  const components = [
    ...state.equations.map((item) => ({ type: "Equation", label: `Equation ${item.eq_number}`, item })),
    ...state.figures.map((item) => ({ type: "Figure", label: `Figure ${item.fig_number}`, item })),
  ];
  const mapped = components.filter(({ item }) => item.code_locations?.length);

  elements.codeMap.innerHTML =
    mapped
      .map(({ type, label, item }) => {
        const first = item.code_locations[0];
        return `
          <article class="map-row">
            <div class="map-node">
              <strong>${escapeHtml(label)}</strong>
              <p>${escapeHtml(item.description || item.caption || item.key_insight || type)}</p>
            </div>
            <div class="map-arrow">→</div>
            <div class="map-node">
              <strong>${escapeHtml(first.symbol || "code location")}</strong>
              <p>${escapeHtml(first.path || "")}:${escapeHtml(first.line_start || "")}-${escapeHtml(first.line_end || "")}</p>
              ${renderLocations(item.code_locations)}
            </div>
          </article>
        `;
      })
      .join("") || emptyMessage("No mapped code locations yet.");
}

function emptyMessage(text) {
  return `<div class="empty-state"><h3>${escapeHtml(text)}</h3></div>`;
}

function activateTab(tabName) {
  state.activeTab = tabName;
  elements.tabs.forEach((tab) => tab.classList.toggle("is-active", tab.dataset.tab === tabName));
  document.querySelectorAll(".view").forEach((view) => view.classList.remove("is-active"));
  document.querySelector(`#${tabName}View`).classList.add("is-active");
}

elements.pdfInput.addEventListener("change", (event) => {
  state.file = event.target.files?.[0] || null;
  elements.fileMeta.textContent = state.file
    ? `${state.file.name} · ${(state.file.size / 1024 / 1024).toFixed(2)} MB`
    : "No file selected";
  setBusy(false);
});

elements.repoUrl.addEventListener("input", (event) => {
  state.repoUrl = event.target.value;
  setBusy(false);
});

elements.apiBaseUrl.addEventListener("input", (event) => {
  state.apiBaseUrl = event.target.value || DEFAULT_API_BASE_URL;
});

elements.mappingApiUrl.addEventListener("input", (event) => {
  state.mappingApiUrl = event.target.value;
  setBusy(false);
});

elements.extractBtn.addEventListener("click", runExtraction);
elements.mapBtn.addEventListener("click", runMapping);
elements.downloadBtn.addEventListener("click", downloadJson);
elements.jsonInput.addEventListener("change", (event) => {
  const file = event.target.files?.[0];
  if (file) loadJson(file).catch((error) => addStatus(error.message, "error"));
});

elements.tabs.forEach((tab) => {
  tab.addEventListener("click", () => activateTab(tab.dataset.tab));
});

addStatus("Frontend ready", "done");
render();
