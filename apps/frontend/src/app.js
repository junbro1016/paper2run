const DEFAULT_API_BASE_URL = "https://paper2run-production.up.railway.app";
const DEFAULT_MAPPING_API_URL = "https://web-production-148e8.up.railway.app/map";
const SETTINGS_STORAGE_KEY = "paper2run.frontend.settings";

const savedSettings = loadSavedSettings();

const state = {
  file: null,
  repoUrl: "",
  apiBaseUrl: savedSettings.apiBaseUrl || DEFAULT_API_BASE_URL,
  mappingApiUrl: savedSettings.mappingApiUrl || DEFAULT_MAPPING_API_URL,
  paper: null,
  equations: [],
  figures: [],
  activeTab: "overview",
  statuses: [],
  busyAction: null,
  codeSnippets: {},
  mathTypesetTimer: null,
};

const elements = {
  pdfInput: document.querySelector("#pdfInput"),
  jsonInput: document.querySelector("#jsonInput"),
  fileMeta: document.querySelector("#fileMeta"),
  repoUrl: document.querySelector("#repoUrl"),
  apiBaseUrl: document.querySelector("#apiBaseUrl"),
  mappingApiUrl: document.querySelector("#mappingApiUrl"),
  extractBtn: document.querySelector("#extractBtn"),
  uploadBtn: document.querySelector("#uploadBtn"),
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

elements.apiBaseUrl.value = state.apiBaseUrl;
elements.mappingApiUrl.value = state.mappingApiUrl;

function loadSavedSettings() {
  try {
    return JSON.parse(window.localStorage.getItem(SETTINGS_STORAGE_KEY) || "{}");
  } catch {
    return {};
  }
}

function saveSettings() {
  try {
    window.localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({
        apiBaseUrl: state.apiBaseUrl,
        mappingApiUrl: state.mappingApiUrl,
      }),
    );
  } catch {
    // The app still works when local storage is unavailable.
  }
}

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

function setBusy(action = null) {
  state.busyAction = action;
  updateControls();
}

function updateControls() {
  const isBusy = Boolean(state.busyAction);
  elements.extractBtn.disabled = isBusy || !state.file;
  elements.jsonInput.disabled = isBusy;
  elements.uploadBtn.classList.toggle("is-disabled", isBusy);
  elements.uploadBtn.classList.toggle("is-loading", state.busyAction === "upload");
  elements.uploadBtn.setAttribute("aria-disabled", String(isBusy));
  elements.mapBtn.disabled = isBusy || !canMap();
  elements.downloadBtn.disabled = isBusy || !hasResults();
  elements.extractBtn.classList.toggle("is-loading", state.busyAction === "extract");
  elements.mapBtn.classList.toggle("is-loading", state.busyAction === "mapping");
  elements.downloadBtn.classList.remove("is-loading");
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

  setBusy("extract");
  state.equations = [];
  state.figures = [];
  state.codeSnippets = {};
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
    setBusy(null);
  }
}

async function runMapping() {
  if (!canMap()) return;
  setBusy("mapping");
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
    state.codeSnippets = {};
    state.equations = Array.isArray(mapped.equations) ? mapped.equations : state.equations;
    state.figures = Array.isArray(mapped.figures) ? mapped.figures : state.figures;
    addStatus("Code mapping complete", "done");
    render();
  } catch (error) {
    addStatus(error.message, "error");
  } finally {
    setBusy(null);
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
  state.codeSnippets = {};
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
  typesetMath();
  updateControls();
}

function renderOverview() {
  if (!hasResults()) {
    elements.overviewContent.innerHTML = "";
    return;
  }

  elements.overviewContent.innerHTML = `
    <section class="panel overview-section">
      <h3>Equations</h3>
      <div class="overview-list">
        ${state.equations.map(renderEquationSummary).join("") || "<p>No equations loaded.</p>"}
      </div>
    </section>
    <section class="panel overview-section">
      <h3>Figures</h3>
      <div class="overview-figure-list">
        ${state.figures.map(renderFigureSummary).join("") || "<p>No figures loaded.</p>"}
      </div>
    </section>
  `;
}

function renderEquationSummary(equation) {
  return `
    <article class="overview-equation">
      <div class="overview-equation-math">${escapeHtml(formatLatexForDisplay(equation.latex || ""))}</div>
      <p class="overview-one-line">
        <strong>Equation ${escapeHtml(equation.eq_number)}</strong>
        ${escapeHtml(equation.description || equation.core_reason || equation.section_hint || "No explanation available.")}
      </p>
    </article>
  `;
}

function renderFigureSummary(figure) {
  const image = figure.image_url
    ? `<img src="${escapeHtml(figure.image_url)}" alt="${escapeHtml(figure.caption || "Extracted figure")}" />`
    : `<div class="overview-figure-placeholder">No image</div>`;

  return `
    <article class="overview-figure">
      ${image}
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
      <div class="math-render">${escapeHtml(formatLatexForDisplay(equation.latex || ""))}</div>
      <p>${escapeHtml(equation.description || "")}</p>
      <p>${escapeHtml(equation.core_reason || "")}</p>
      ${renderLocations(equation.code_locations)}
    </article>
  `;
}

function formatLatexForDisplay(value) {
  let latex = String(value || "").trim();
  if (!latex) return "\\[\\]";

  latex = latex
    .replace(/^\\\[/, "")
    .replace(/\\\]$/, "")
    .replace(/^\\\(/, "")
    .replace(/\\\)$/, "")
    .replace(/^\$\$/, "")
    .replace(/\$\$$/, "")
    .replace(/^\$/, "")
    .replace(/\$$/, "")
    .replace(/^\\begin\{equation\*?\}/, "")
    .replace(/\\end\{equation\*?\}$/, "")
    .trim();

  return `\\[${latex}\\]`;
}

function typesetMath() {
  if (!window.MathJax) return;

  if (!window.MathJax.typesetPromise && !window.MathJax.startup?.promise) {
    window.clearTimeout(state.mathTypesetTimer);
    state.mathTypesetTimer = window.setTimeout(typesetMath, 100);
    return;
  }

  const targets = [elements.overviewContent, elements.equationList];
  const runTypeset = () => {
    window.MathJax.typesetClear?.(targets);
    window.MathJax.typesetPromise?.(targets).catch((error) => {
      addStatus(`Equation rendering failed: ${error.message}`, "error");
    });
  };

  if (window.MathJax.startup?.promise) {
    window.MathJax.startup.promise.then(runTypeset).catch(() => {});
  } else {
    runTypeset();
  }
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
        return `
          <article class="map-row">
            <div class="map-node">
              <strong>${escapeHtml(label)}</strong>
              <p>${escapeHtml(item.description || item.caption || item.key_insight || type)}</p>
            </div>
            <div class="map-arrow">→</div>
            <div class="map-node">
              ${item.code_locations.map(renderCodeLocationDetail).join("")}
            </div>
          </article>
        `;
      })
      .join("") || emptyMessage("No mapped code locations yet.");

  loadCodeSnippets();
}

function renderCodeLocationDetail(location) {
  return `
    <article class="code-location-detail">
      <a class="code-link" href="${escapeHtml(location.url || "#")}" target="_blank" rel="noreferrer">
        <span class="code-symbol">${escapeHtml(location.symbol || "code location")}</span>
        <span class="code-path">${escapeHtml(location.path || "")}:${escapeHtml(location.line_start || "")}-${escapeHtml(location.line_end || "")}</span>
      </a>
      ${renderCodeSnippet(location)}
      ${location.relation ? `<p class="code-note">${escapeHtml(location.relation)}</p>` : ""}
      ${location.rationale ? `<p class="code-note">${escapeHtml(location.rationale)}</p>` : ""}
    </article>
  `;
}

function renderCodeSnippet(location) {
  if (!getRawCodeUrl(location)) {
    return `<div class="snippet-message">No source URL available.</div>`;
  }

  const key = getLocationKey(location);
  const snippet = state.codeSnippets[key];

  if (snippet?.status === "done") {
    return `<pre class="code-snippet"><code>${escapeHtml(snippet.code)}</code></pre>`;
  }

  if (snippet?.status === "error") {
    return `<div class="snippet-message">Could not load code snippet.</div>`;
  }

  return `<div class="snippet-message">Loading code snippet...</div>`;
}

function loadCodeSnippets() {
  const locations = getMappedLocations();
  const pending = locations.filter((location) => {
    const key = getLocationKey(location);
    return getRawCodeUrl(location) && !state.codeSnippets[key];
  });

  if (!pending.length) return;

  pending.forEach((location) => {
    state.codeSnippets[getLocationKey(location)] = { status: "loading" };
  });

  Promise.allSettled(pending.map(loadCodeSnippet)).then(() => {
    renderCodeMap();
  });
}

async function loadCodeSnippet(location) {
  const key = getLocationKey(location);

  try {
    const rawUrl = getRawCodeUrl(location);
    if (!rawUrl) throw new Error("Missing GitHub source URL.");

    const response = await fetch(rawUrl);
    if (!response.ok) throw new Error(`Source fetch failed with HTTP ${response.status}`);

    const text = await response.text();
    state.codeSnippets[key] = {
      status: "done",
      ...extractCodeSnippet(text, location.line_start, location.line_end),
    };
  } catch (error) {
    state.codeSnippets[key] = { status: "error", error: error.message };
  }
}

function getMappedLocations() {
  return [...state.equations, ...state.figures].flatMap((item) => item.code_locations || []);
}

function getLocationKey(location) {
  return [
    location.url,
    location.repository,
    location.commit,
    location.path,
    location.line_start,
    location.line_end,
    location.symbol,
  ]
    .filter(Boolean)
    .join("|");
}

function getRawCodeUrl(location) {
  if (location.url) {
    try {
      const parsed = new URL(location.url);
      const parts = parsed.pathname.split("/").filter(Boolean);
      if (parsed.hostname === "github.com" && parts[2] === "blob" && parts.length >= 5) {
        const [owner, repo, , ref, ...pathParts] = parts;
        return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${pathParts.join("/")}`;
      }
      if (parsed.hostname === "raw.githubusercontent.com") return parsed.href.split("#")[0];
    } catch {
      return "";
    }
  }

  if (!location.repository || !location.commit || !location.path) return "";

  try {
    const parsed = new URL(location.repository);
    const [owner, repo] = parsed.pathname.split("/").filter(Boolean);
    if (!owner || !repo) return "";
    return `https://raw.githubusercontent.com/${owner}/${repo}/${location.commit}/${location.path}`;
  } catch {
    return "";
  }
}

function extractCodeSnippet(text, lineStart, lineEnd) {
  const lines = text.split(/\r?\n/);
  const startLine = Math.max(1, Number(lineStart) || 1);
  const endLine = Math.max(startLine, Number(lineEnd) || startLine);
  const displayStart = Math.max(1, startLine - 3);
  const displayEnd = Math.min(lines.length, endLine + 3);
  const width = String(displayEnd).length;
  const code = lines
    .slice(displayStart - 1, displayEnd)
    .map((line, index) => {
      const lineNumber = displayStart + index;
      const marker = lineNumber >= startLine && lineNumber <= endLine ? ">" : " ";
      return `${marker} ${String(lineNumber).padStart(width, " ")} | ${line}`;
    })
    .join("\n");

  return { code, startLine: displayStart, endLine: displayEnd };
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
  updateControls();
});

elements.repoUrl.addEventListener("input", (event) => {
  state.repoUrl = event.target.value;
  updateControls();
});

elements.apiBaseUrl.addEventListener("input", (event) => {
  state.apiBaseUrl = event.target.value || DEFAULT_API_BASE_URL;
  saveSettings();
});

elements.mappingApiUrl.addEventListener("input", (event) => {
  state.mappingApiUrl = event.target.value || DEFAULT_MAPPING_API_URL;
  saveSettings();
  updateControls();
});

elements.extractBtn.addEventListener("click", runExtraction);
elements.mapBtn.addEventListener("click", runMapping);
elements.downloadBtn.addEventListener("click", downloadJson);
elements.jsonInput.addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  setBusy("upload");
  try {
    await loadJson(file);
  } catch (error) {
    addStatus(error.message, "error");
  } finally {
    event.target.value = "";
    setBusy(null);
  }
});

elements.tabs.forEach((tab) => {
  tab.addEventListener("click", () => activateTab(tab.dataset.tab));
});

addStatus("Frontend ready", "done");
render();
