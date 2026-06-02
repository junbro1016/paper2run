const DEFAULT_API_BASE_URL = "https://paper2run.onrender.com";
const DEFAULT_RUNBOOK_API_URL = "https://paper2run-nevv.onrender.com/runbook";
const LEGACY_API_BASE_URLS = new Set(["https://paper2run-production.up.railway.app"]);
const SETTINGS_STORAGE_KEY = "paper2run.pipeline.frontend.settings";
const JOB_STORAGE_KEY = "paper2run.pipeline.frontend.lastJob";
const POLL_INITIAL_INTERVAL_MS = 5000;
const POLL_LATER_INTERVAL_MS = 12000;
const POLL_FAST_WINDOW_MS = 60000;
const FETCH_TIMEOUT_MS = 30000;
const MAX_TRANSIENT_FETCH_RETRIES = 5;

const PIPELINE_STEPS = ["Profile", "Extract", "Ground", "Verify"];

// Figure preview state (crop figures out of an uploaded PDF by bbox).
const paperPdf = { file: null, docFile: null, docPromise: null };
const figureCropCache = new Map(); // figure id -> dataURL | null (null = attempted, failed)
let pdfjsLibPromise = null;

const savedSettings = loadSavedSettings();

const state = {
  file: null,
  repoUrl: savedSettings.repoUrl || "",
  apiBaseUrl: normalizeApiBaseUrl(savedSettings.apiBaseUrl),
  job: null,
  result: null,
  runbook: null,
  runbookMeta: null,
  runbookBusy: false,
  runbookError: "",
  statuses: [],
  activeTab: "overview",
  busy: false,
  forceLanding: false,
  lastStageIndex: -1,
  polling: false,
  pollStartedAt: null,
  transientFetchFailures: 0,
  mathTypesetTimer: null,
};

const elements = {
  body: document.body,
  brandHome: document.querySelector("#brandHome"),
  newRunBtn: document.querySelector("#newRunBtn"),
  suggestions: [...document.querySelectorAll(".suggestion")],
  threadFile: document.querySelector("#threadFile"),
  threadFileMeta: document.querySelector("#threadFileMeta"),
  threadRepo: document.querySelector("#threadRepo"),
  procHeading: document.querySelector("#procHeading"),
  procStatus: document.querySelector("#procStatus"),
  procBackBtn: document.querySelector("#procBackBtn"),
  runForm: document.querySelector("#runForm"),
  pdfInput: document.querySelector("#pdfInput"),
  fileName: document.querySelector("#fileName"),
  fileMeta: document.querySelector("#fileMeta"),
  repoUrl: document.querySelector("#repoUrl"),
  apiBaseUrl: document.querySelector("#apiBaseUrl"),
  healthBtn: document.querySelector("#healthBtn"),
  apiHealth: document.querySelector("#apiHealth"),
  runBtn: document.querySelector("#runBtn"),
  clearBtn: document.querySelector("#clearBtn"),
  jsonInput: document.querySelector("#jsonInput"),
  downloadBtn: document.querySelector("#downloadBtn"),
  jobState: document.querySelector("#jobState"),
  jobMeta: document.querySelector("#jobMeta"),
  statusList: document.querySelector("#statusList"),
  paperTitle: document.querySelector("#paperTitle"),
  scoreMetric: document.querySelector("#scoreMetric"),
  extractedMetric: document.querySelector("#extractedMetric"),
  tabs: [...document.querySelectorAll(".tab")],
  emptyState: document.querySelector("#emptyState"),
  overviewGrid: document.querySelector("#overviewGrid"),
  equationList: document.querySelector("#equationList"),
  figureList: document.querySelector("#figureList"),
  algorithmList: document.querySelector("#algorithmList"),
  generateRunbookBtn: document.querySelector("#generateRunbookBtn"),
  runbookSummary: document.querySelector("#runbookSummary"),
  runbookContent: document.querySelector("#runbookContent"),
  figurePdfInput: document.querySelector("#figurePdfInput"),
};

// Calm, honest status copy keyed to the inferred step — no fake counters.
const STEP_CAPTIONS = [
  "Reading the paper's structure and sections.",
  "Extracting equations, figures, and algorithms.",
  "Mapping each claim to your repository code.",
  "Scoring and verifying the evidence.",
  "Finalizing the evidence report.",
];

elements.repoUrl.value = state.repoUrl;
elements.apiBaseUrl.value = state.apiBaseUrl;

wireEvents();
restoreSavedJob();
render();

function wireEvents() {
  elements.runForm.addEventListener("submit", (event) => {
    event.preventDefault();
    runPipeline();
  });

  elements.pdfInput.addEventListener("change", () => {
    state.file = elements.pdfInput.files?.[0] || null;
    renderFileMeta();
    updateControls();
  });

  elements.repoUrl.addEventListener("input", () => {
    state.repoUrl = elements.repoUrl.value.trim();
    saveSettings();
    updateControls();
  });

  elements.apiBaseUrl.addEventListener("input", () => {
    state.apiBaseUrl = elements.apiBaseUrl.value.trim();
    saveSettings();
  });

  elements.healthBtn.addEventListener("click", () => checkHealth());
  elements.clearBtn.addEventListener("click", clearAll);
  elements.downloadBtn.addEventListener("click", downloadResult);
  elements.generateRunbookBtn?.addEventListener("click", () => generateRunbook({ force: true }));

  elements.newRunBtn?.addEventListener("click", () => goToLanding());
  elements.brandHome?.addEventListener("click", () => goToLanding());
  elements.procBackBtn?.addEventListener("click", () => {
    state.polling = false;
    goToLanding();
  });

  elements.figurePdfInput?.addEventListener("change", () => {
    const file = elements.figurePdfInput.files?.[0];
    if (file) setPaperPdf(file);
    elements.figurePdfInput.value = "";
  });

  document.querySelector(".response-result")?.addEventListener("click", (event) => {
    const button = event.target.closest(".code-copy");
    if (button) {
      event.preventDefault();
      event.stopPropagation();
      const code = button.closest(".code-card")?.querySelector(".code-body code");
      const text = code?.dataset.raw ?? code?.textContent ?? "";
      navigator.clipboard?.writeText(text).then(
        () => {
          button.textContent = "Copied";
          window.setTimeout(() => (button.textContent = "Copy"), 1400);
        },
        () => {},
      );
      return;
    }

    const codeBody = event.target.closest(".code-scroll");
    if (!codeBody) return;
    const link = codeBody.closest(".code-card")?.dataset.link;
    if (link && link !== "#") {
      event.preventDefault();
      window.open(link, "_blank", "noreferrer");
    }
  });

  elements.suggestions.forEach((button) => {
    button.addEventListener("click", () => {
      const repo = button.dataset.repo || "";
      if (repo) {
        state.repoUrl = repo;
        elements.repoUrl.value = repo;
        saveSettings();
        updateControls();
      }
      elements.repoUrl.focus();
      if (!state.file) elements.pdfInput.click();
    });
  });

  elements.jsonInput.addEventListener("change", () => {
    const file = elements.jsonInput.files?.[0];
    if (file) loadResultJson(file);
    elements.jsonInput.value = "";
  });

  elements.tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      state.activeTab = tab.dataset.tab;
      renderTabs();
      if (state.activeTab === "runbook" && state.result && !state.runbook && !state.runbookBusy) {
        generateRunbook();
      }
      enhanceCodeBlocks();
    });
  });
}

function loadSavedSettings() {
  try {
    return JSON.parse(window.localStorage.getItem(SETTINGS_STORAGE_KEY) || "{}");
  } catch {
    return {};
  }
}

function normalizeApiBaseUrl(value) {
  const normalized = String(value || "").replace(/\/$/, "");
  if (!normalized || LEGACY_API_BASE_URLS.has(normalized)) {
    return DEFAULT_API_BASE_URL;
  }
  return normalized;
}

function saveSettings() {
  try {
    window.localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({
        apiBaseUrl: state.apiBaseUrl,
        repoUrl: state.repoUrl,
      }),
    );
  } catch {
    // Local storage is a convenience, not a requirement.
  }
}

function saveJobSnapshot(job = state.job) {
  if (!job?.job_id) return;
  try {
    window.localStorage.setItem(
      JOB_STORAGE_KEY,
      JSON.stringify({
        job_id: job.job_id,
        status: job.status,
        filename: job.filename,
        github_url: job.github_url || state.repoUrl,
        apiBaseUrl: state.apiBaseUrl,
        overall_grounding_score: job.overall_grounding_score,
        total_extracted: job.total_extracted,
        savedAt: Date.now(),
      }),
    );
  } catch {
    // Job recovery is a convenience, not a requirement.
  }
}

function restoreSavedJob() {
  try {
    const saved = JSON.parse(window.localStorage.getItem(JOB_STORAGE_KEY) || "{}");
    if (!saved.job_id) return;
    state.job = {
      job_id: saved.job_id,
      status: saved.status || "processing",
      filename: saved.filename,
      github_url: saved.github_url,
      overall_grounding_score: saved.overall_grounding_score,
      total_extracted: saved.total_extracted,
    };
    state.repoUrl = saved.github_url || state.repoUrl;
    state.apiBaseUrl = normalizeApiBaseUrl(saved.apiBaseUrl || state.apiBaseUrl);
    elements.repoUrl.value = state.repoUrl;
    elements.apiBaseUrl.value = state.apiBaseUrl;
    if (saved.status === "done") {
      addStatus(`Restored completed job: ${saved.job_id}. Fetching result.`, "pending");
      state.busy = true;
      fetchFullResult(saved.job_id).finally(() => setBusy(false));
    } else {
      addStatus(`Restored job: ${saved.job_id}`, "pending");
      state.polling = true;
      state.busy = true;
      state.pollStartedAt = saved.savedAt || Date.now();
      pollUntilDone(saved.job_id).finally(() => setBusy(false));
    }
  } catch {
    // Ignore corrupt saved job metadata.
  }
}

function apiUrl(path) {
  return `${state.apiBaseUrl.replace(/\/$/, "")}${path}`;
}

function addStatus(label, stateName = "pending") {
  state.statuses.unshift({
    label,
    state: stateName,
    at: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
  });
  state.statuses = state.statuses.slice(0, 10);
  renderStatus();
}

function renderStatus() {
  if (!state.statuses.length) {
    elements.statusList.innerHTML = `<li>Run activity will appear here.</li>`;
    return;
  }
  elements.statusList.innerHTML = state.statuses
    .map(
      (item) =>
        `<li data-state="${escapeHtml(item.state)}">${escapeHtml(item.at)} · ${escapeHtml(item.label)}</li>`,
    )
    .join("");
}

function setBusy(value) {
  state.busy = value;
  updateControls();
}

function updateControls() {
  const canRun = Boolean(state.file && state.repoUrl && state.apiBaseUrl && !state.busy);
  elements.runBtn.disabled = !canRun;
  elements.clearBtn.disabled = state.busy && state.polling;
  elements.downloadBtn.disabled = !state.result;
  elements.healthBtn.disabled = state.busy;
  if (elements.generateRunbookBtn) {
    elements.generateRunbookBtn.disabled = !state.result || state.runbookBusy;
  }
}

function renderFileMeta() {
  if (!state.file) {
    elements.fileName.textContent = "Choose a PDF file";
    elements.fileMeta.textContent = "No file selected yet.";
    return;
  }
  elements.fileName.textContent = state.file.name;
  elements.fileMeta.textContent = `${formatBytes(state.file.size)} · ${state.file.type || "application/pdf"}`;
}

async function runPipeline() {
  if (!state.file || !state.repoUrl) return;

  state.result = null;
  state.runbook = null;
  state.runbookMeta = null;
  state.runbookError = "";
  state.runbookBusy = false;
  state.job = null;
  state.forceLanding = false;
  state.lastStageIndex = -1;
  state.polling = true;
  state.pollStartedAt = Date.now();
  state.transientFetchFailures = 0;
  setBusy(true);
  render();

  try {
    addStatus("Uploading PDF and GitHub URL", "pending");
    const formData = new FormData();
    formData.append("file", state.file);
    formData.append("github_url", state.repoUrl);

    const startResponse = await fetchWithTimeout(apiUrl("/paper2run/run"), {
      method: "POST",
      body: formData,
    });

    const started = await readJsonResponse(startResponse);
    if (!startResponse.ok) {
      throw new Error(errorMessage(started, `Pipeline start failed with HTTP ${startResponse.status}`));
    }
    if (!started.job_id) {
      throw new Error("Pipeline response did not include a job_id.");
    }

    state.job = started;
    saveJobSnapshot(started);
    addStatus(`Job started: ${started.job_id}`, "done");
    render();

    await pollUntilDone(started.job_id);
  } catch (error) {
    state.polling = false;
    state.job = {
      ...(state.job || {}),
      status: "error",
      error: error.message,
    };
    addStatus(error.message, "error");
    render();
  } finally {
    setBusy(false);
  }
}

async function pollUntilDone(jobId) {
  while (state.polling) {
    let response;
    let job;
    try {
      response = await fetchWithTimeout(apiUrl(`/paper2run/jobs/${encodeURIComponent(jobId)}`));
      job = await readJsonResponse(response);
      state.transientFetchFailures = 0;
    } catch (error) {
      state.transientFetchFailures += 1;
      if (state.transientFetchFailures <= MAX_TRANSIENT_FETCH_RETRIES) {
        const waitMs = pollDelayMs();
        addStatus(
          `Temporary polling issue (${state.transientFetchFailures}/${MAX_TRANSIENT_FETCH_RETRIES}). Retrying in ${Math.round(
            waitMs / 1000,
          )}s.`,
          "pending",
        );
        await delay(waitMs);
        continue;
      }
      throw new Error(`Could not reach the pipeline API after retries: ${error.message}`);
    }
    if (!response.ok) {
      throw new Error(errorMessage(job, `Job polling failed with HTTP ${response.status}`));
    }

    state.job = job;
    saveJobSnapshot(job);
    logStageTransition();
    render();

    if (job.status === "done") {
      await fetchFullResult(jobId);
      state.polling = false;
      return;
    }

    if (job.status === "error") {
      throw new Error(`Backend pipeline failed: ${job.error || "Pipeline job failed."}`);
    }

    await delay(pollDelayMs());
  }
}

// Only record a log line when the inferred pipeline step actually advances,
// instead of repeating "Pipeline processing" on every poll.
function logStageTransition() {
  const index = currentStageIndex();
  if (index === state.lastStageIndex) return;
  state.lastStageIndex = index;
  if (index < PIPELINE_STEPS.length) {
    addStatus(`${PIPELINE_STEPS[index]} stage running`, "pending");
  }
}

async function fetchFullResult(jobId) {
  const response = await fetchWithRetry(apiUrl(`/paper2run/jobs/${encodeURIComponent(jobId)}/result`));
  const result = await readJsonResponse(response);
  if (!response.ok) {
    throw new Error(errorMessage(result, `Result fetch failed with HTTP ${response.status}`));
  }

  // Mark every step complete and let the live counters tick up to their final
  // values before the result view slides in, so it never snaps from 0.
  state.job = {
    ...(state.job || {}),
    status: "done",
    total_extracted: countExtracted(result),
    overall_grounding_score: result.overall_grounding_score,
  };
  addStatus("Pipeline finished", "done");
  render();
  await delay(550);

  state.result = result;
  state.runbook = result.runbook || null;
  state.runbookMeta = result.runbook_meta || null;
  state.runbookError = "";
  state.runbookBusy = false;
  saveJobSnapshot({ ...result, status: "done" });
  state.activeTab = "overview";
  addStatus("Result loaded", "done");
  render();
}

async function generateRunbook({ force = false } = {}) {
  if (!state.result || state.runbookBusy) return;
  if (state.runbook && !force) return;

  state.runbookBusy = true;
  state.runbookError = "";
  renderRunbook();
  updateControls();

  try {
    addStatus("Generating reproduction runbook", "pending");
    const response = await fetchWithRetry(DEFAULT_RUNBOOK_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildRunbookPayload()),
    });
    const payload = await readJsonResponse(response);
    if (!response.ok) {
      throw new Error(errorMessage(payload, `Runbook generation failed with HTTP ${response.status}`));
    }

    state.runbook = payload.runbook || payload;
    state.runbookMeta = {
      github_repository: payload.github_repository,
      source_files: payload.source_files,
      commands_used: payload.commands_used,
    };
    state.result = {
      ...state.result,
      runbook: state.runbook,
      runbook_meta: state.runbookMeta,
    };
    addStatus("Runbook generated", "done");
  } catch (error) {
    state.runbookError = error.message;
    addStatus(error.message, "error");
  } finally {
    state.runbookBusy = false;
    renderRunbook();
    updateControls();
  }
}

function buildRunbookPayload() {
  const githubUrl = resolvedGithubUrl();
  return {
    ...state.result,
    github_url: githubUrl,
    github_repository: {
      ...(state.result.github_repository || {}),
      url: githubUrl,
    },
  };
}

async function checkHealth({ silent = false } = {}) {
  if (!state.apiBaseUrl) return;
  elements.apiHealth.textContent = "Checking API health...";
  try {
    const response = await fetchWithTimeout(apiUrl("/health"));
    const payload = await readJsonResponse(response);
    if (!response.ok) {
      throw new Error(errorMessage(payload, `Health check failed with HTTP ${response.status}`));
    }
    elements.apiHealth.textContent = `API online · version ${payload.version || "unknown"}`;
    if (!silent) addStatus("API health check passed", "done");
  } catch (error) {
    elements.apiHealth.textContent = error.message;
    if (!silent) addStatus(error.message, "error");
  }
}

async function loadResultJson(file) {
  try {
    const text = await file.text();
    const result = JSON.parse(text);
    state.forceLanding = false;
    state.result = normalizeLoadedResult(result);
    state.runbook = state.result.runbook || null;
    state.runbookMeta = state.result.runbook_meta || null;
    state.runbookError = "";
    state.runbookBusy = false;
    figureCropCache.clear();
    paperPdf.docFile = null;
    paperPdf.docPromise = null;
    state.job = {
      job_id: state.result.job_id || "loaded-json",
      status: state.result.status || "done",
      filename: state.result.filename,
      github_url: state.result.github_url,
      overall_grounding_score: state.result.overall_grounding_score,
      total_extracted: countExtracted(state.result),
    };
    state.activeTab = "overview";
    addStatus(`Loaded result JSON: ${file.name}`, "done");
    render();
  } catch (error) {
    addStatus(`Could not load JSON: ${error.message}`, "error");
  }
}

function normalizeLoadedResult(data) {
  if (data.result && typeof data.result === "object") return data.result;
  return data;
}

function clearAll() {
  state.file = null;
  state.job = null;
  state.result = null;
  state.runbook = null;
  state.runbookMeta = null;
  state.runbookError = "";
  state.runbookBusy = false;
  state.statuses = [];
  state.polling = false;
  state.pollStartedAt = null;
  state.transientFetchFailures = 0;
  try {
    window.localStorage.removeItem(JOB_STORAGE_KEY);
  } catch {
    // Ignore local storage failures.
  }
  elements.pdfInput.value = "";
  renderFileMeta();
  render();
}

function downloadResult() {
  if (!state.result) return;
  const blob = new Blob([JSON.stringify(state.result, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  const stem = (state.result.filename || "paper2run-result").replace(/\.pdf$/i, "");
  anchor.href = url;
  anchor.download = `${stem}_paper2run_result.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function goToLanding() {
  state.forceLanding = true;
  renderStage();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function renderStage() {
  let stage;
  if (state.forceLanding) {
    stage = "landing";
  } else if (state.result) {
    stage = "result";
  } else if (state.busy || state.job) {
    stage = "processing";
  } else {
    stage = "landing";
  }
  document.body.dataset.stage = stage;
}

// The polling payload has no explicit stage field, so infer the current
// step from the status string and from which result fields are populated.
function currentStageIndex() {
  const job = state.job;
  if (state.result || job?.status === "done") return PIPELINE_STEPS.length;
  if (!job) return 0;

  const s = String(job.status || "").toLowerCase();
  if (/verif/.test(s)) return 3;
  if (/ground|map|match/.test(s)) return 2;
  if (/extract/.test(s)) return 1;
  if (/profil|plan/.test(s)) return 0;

  if (job.overall_grounding_score != null) return 3;
  if (job.total_extracted) return 2;
  if (job.plan_summary || job.profile_summary) return 1;
  return 0;
}

function renderThreadRequest() {
  const file = state.result?.filename || state.job?.filename || state.file?.name;
  if (elements.threadFile) elements.threadFile.textContent = file || "paper.pdf";
  if (elements.threadFileMeta) {
    elements.threadFileMeta.textContent = state.file
      ? `${formatBytes(state.file.size)} · PDF`
      : "PDF";
  }
  const repo = state.result?.github_url || state.job?.github_url || state.repoUrl;
  if (elements.threadRepo) {
    elements.threadRepo.textContent = repo ? repo.replace(/^https?:\/\//, "") : "repository";
    elements.threadRepo.href = repo || "#";
  }
}

function renderProcessing() {
  const job = state.job;
  const stageIndex = currentStageIndex();
  const isError = job?.status === "error";

  if (elements.procHeading) {
    const name = job?.filename || state.file?.name;
    elements.procHeading.textContent = isError
      ? "Pipeline failed"
      : `Grounding ${name || "your paper"}…`;
  }

  if (elements.procStatus) {
    elements.procStatus.textContent = isError
      ? job.error || "The pipeline could not finish."
      : STEP_CAPTIONS[Math.min(stageIndex, STEP_CAPTIONS.length - 1)];
    elements.procStatus.classList.toggle("is-error", Boolean(isError));
  }
}

function render() {
  renderStage();
  renderStatus();
  renderThreadRequest();
  renderProcessing();
  renderJob();
  renderHeader();
  renderTabs();
  renderOverview();
  renderEvidenceTabs();
  renderRunbook();
  updateControls();
  scheduleMathTypeset();
  enhanceCodeBlocks();
}

function renderJob() {
  const job = state.job;
  const status = job?.status || "idle";
  elements.jobState.textContent = status.toUpperCase();
  elements.jobState.className = `job-state is-${status}`;

  if (!job) {
    elements.jobMeta.textContent = "";
  } else {
    const parts = [
      job.job_id ? `job ${job.job_id}` : "",
      job.error ? `error: ${job.error}` : "",
    ].filter(Boolean);
    elements.jobMeta.textContent = parts.join(" · ");
  }
}

function renderHeader() {
  const title =
    state.result?.filename ||
    state.job?.filename ||
    state.file?.name ||
    "Upload a paper to begin";
  elements.paperTitle.textContent = title;

  const score = scoreFromState();
  elements.scoreMetric.textContent = score == null ? "-" : `${Math.round(score * 100)}%`;
  elements.extractedMetric.textContent = String(state.job?.total_extracted ?? countExtracted(state.result));
}

function renderTabs() {
  elements.tabs.forEach((tab) => {
    const active = tab.dataset.tab === state.activeTab;
    tab.classList.toggle("is-active", active);
    document.querySelector(`#${tab.dataset.tab}View`)?.classList.toggle("is-active", active);
  });
}

function renderOverview() {
  if (!state.result) {
    elements.emptyState.style.display = "";
    elements.overviewGrid.innerHTML = "";
    return;
  }

  elements.emptyState.style.display = "none";
  const profile = state.result.profile || state.job?.profile_summary || {};
  elements.overviewGrid.innerHTML = infoCard(
    "Paper Understanding Brief",
    `
      <div class="overview-brief">
        <section class="overview-summary">
          <div class="difficulty-band">
            <div>
              <span class="section-label">Overall difficulty</span>
              <strong>${escapeHtml(formatDifficulty(profile.difficulty_score))}</strong>
            </div>
            <div class="difficulty-meter" style="--difficulty: ${escapeAttribute(difficultyPercent(profile.difficulty_score))}%">
              <span></span>
            </div>
          </div>
          ${renderPaperSummary(profile)}
          <div class="pill-row">${overviewPills(profile).map(([key, value]) => metricPill(key, value)).join("")}</div>
        </section>
        <section class="skills-panel">
          <span class="section-label">Core competencies</span>
          ${renderSkillRadar(coreCompetencies(profile))}
        </section>
      </div>
    `,
    "is-wide is-brief",
  );
}

const STATUS_RANK = { verified: 0, weak: 1, no_match: 2, unknown: 3, hallucinated: 4 };

function statusRank(status) {
  return STATUS_RANK[String(status || "unknown").toLowerCase()] ?? 3;
}

function overviewPills(profile) {
  return [
    ["Paper Type", profile.paper_type],
    ["Trajectory", profile.trajectory],
    ["Pages", profile.page_count],
    ["Formalism", profile.formalism_role],
  ].filter(([, value]) => value != null && value !== "");
}

function renderPaperSummary(profile) {
  const equations = getExtractionItems(state.result, "equation");
  const figures = getExtractionItems(state.result, "figure");
  const algorithms = getExtractionItems(state.result, "algorithm");
  const summary = [
    profile.reasoning || "No profile summary was reported yet.",
    `The pipeline identified ${equations.length} equations, ${figures.length} figures, and ${algorithms.length} algorithmic components, which makes this paper best read as a blend of mathematical modeling, neural architecture design, and empirical systems work.`,
    keyComponentSentence(equations, figures, algorithms),
  ].filter(Boolean);

  return `<div class="summary-copy">${summary.map((line) => `<p>${escapeHtml(line)}</p>`).join("")}</div>`;
}

function keyComponentSentence(equations, figures, algorithms) {
  const equation = equations[0]?.content;
  const figure = normalizedMetadata(figures[0]).caption || figures[0]?.content;
  const algorithm = normalizedMetadata(algorithms[0]).algorithm_name || algorithms[0]?.content;
  const parts = [
    equation ? `Representative equation: ${equation}` : "",
    figure ? `Primary figure: ${figure}` : "",
    algorithm ? `Main algorithmic idea: ${algorithm}` : "",
  ].filter(Boolean);
  return parts.join(" ");
}

function difficultyPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 50;
  return Math.max(0, Math.min(100, number <= 10 ? number * 10 : number));
}

function formatDifficulty(value) {
  const percent = difficultyPercent(value);
  const label = percent >= 80 ? "Very High" : percent >= 65 ? "High" : percent >= 45 ? "Moderate" : "Accessible";
  return `${label}${Number.isFinite(Number(value)) ? ` · ${escapeHtml(value)}/10` : ""}`;
}

function coreCompetencies(profile) {
  const equations = getExtractionItems(state.result, "equation").length;
  const figures = getExtractionItems(state.result, "figure").length;
  const algorithms = getExtractionItems(state.result, "algorithm").length;
  const commands = getExtractionItems(state.result, "command").length;
  const difficulty = difficultyPercent(profile.difficulty_score) / 100;
  return [
    ["Mathematics", clampSkill(0.35 + equations * 0.07 + difficulty * 0.25)],
    ["Algorithm", clampSkill(0.35 + algorithms * 0.055 + difficulty * 0.15)],
    ["Deep Learning", clampSkill(0.62 + equations * 0.03 + figures * 0.025)],
    ["Systems", clampSkill(0.3 + commands * 0.055 + algorithms * 0.025)],
    ["Experimentation", clampSkill(0.38 + commands * 0.04 + figures * 0.03)],
    ["Implementation", clampSkill(0.42 + commands * 0.045 + algorithms * 0.035)],
  ];
}

function clampSkill(value) {
  return Math.max(0.18, Math.min(0.96, value));
}

function renderSkillRadar(skills) {
  const center = 120;
  const maxRadius = 86;
  const points = skills.map(([, value], index) => {
    const angle = -Math.PI / 2 + (Math.PI * 2 * index) / skills.length;
    const radius = maxRadius * value;
    return [center + Math.cos(angle) * radius, center + Math.sin(angle) * radius];
  });
  const polygon = points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const rings = [0.33, 0.66, 1]
    .map((scale) => {
      const ring = skills
        .map((_, index) => {
          const angle = -Math.PI / 2 + (Math.PI * 2 * index) / skills.length;
          return `${(center + Math.cos(angle) * maxRadius * scale).toFixed(1)},${(center + Math.sin(angle) * maxRadius * scale).toFixed(1)}`;
        })
        .join(" ");
      return `<polygon points="${ring}" class="radar-ring"></polygon>`;
    })
    .join("");
  const spokes = skills
    .map((_, index) => {
      const angle = -Math.PI / 2 + (Math.PI * 2 * index) / skills.length;
      const x = center + Math.cos(angle) * maxRadius;
      const y = center + Math.sin(angle) * maxRadius;
      return `<line x1="${center}" y1="${center}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" class="radar-spoke"></line>`;
    })
    .join("");
  // The SVG sits centered horizontally and 48px from the top of .radar-wrap
  // (inset: 48px 50%; translateX(-50%)). Map each label from SVG space into
  // that same frame so the chips line up with their vertices.
  const labelRadius = maxRadius + 34;
  const labels = skills
    .map(([label, value], index) => {
      const angle = -Math.PI / 2 + (Math.PI * 2 * index) / skills.length;
      const dx = Math.cos(angle) * labelRadius;
      const y = center + Math.sin(angle) * labelRadius;
      const sign = dx < 0 ? "-" : "+";
      return `
        <div class="skill-chip" style="--x:calc(50% ${sign} ${Math.abs(dx).toFixed(1)}px); --y:${(y + 48).toFixed(1)}px">
          <span>${escapeHtml(label)}</span>
          <strong>${Math.round(value * 100)}</strong>
        </div>
      `;
    })
    .join("");

  return `
    <div class="radar-wrap">
      <svg class="skill-radar" viewBox="0 0 240 240" role="img" aria-label="Core competency radar">
        ${rings}
        ${spokes}
        <polygon points="${polygon}" class="radar-area"></polygon>
        ${points.map(([x, y]) => `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4" class="radar-point"></circle>`).join("")}
      </svg>
      ${labels}
    </div>
  `;
}

function normalizedMetadata(item) {
  return item?.metadata && typeof item.metadata === "object" ? item.metadata : {};
}

function componentLocation(item) {
  const location = item?.location && typeof item.location === "object" ? item.location : {};
  return [
    location.section ? `section ${location.section}` : "",
    location.page != null ? `page ${location.page}` : "",
    item?.page != null ? `page ${item.page}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

// Pull a human number from ids like "eq_01" / "fig_2", else fall back to order.
function componentNumber(item, index) {
  const match = String(item?.id || "").match(/(\d+)\s*$/);
  return match ? parseInt(match[1], 10) : index + 1;
}

function componentTitle(item, type, index) {
  const metadata = normalizedMetadata(item);
  // Keep titles short — the full caption / math is shown in the card body.
  if (type === "equation") {
    return `Equation ${componentNumber(item, index)}`;
  }
  if (type === "figure") {
    return `Figure ${componentNumber(item, index)}`;
  }
  return (
    metadata.algorithm_name ||
    item.algorithm_name ||
    metadata.caption ||
    item.caption ||
    metadata.key_insight ||
    item.description ||
    item.id ||
    `${capitalize(type)} ${index + 1}`
  );
}

function capitalize(value) {
  const text = String(value || "");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const COMPONENT_ICONS = {
  equation: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 5H7l5 7-5 7h9"/></svg>',
  figure: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.6"/><path d="M21 16l-5-5L5 20"/></svg>',
  algorithm: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 4H6a2 2 0 0 0-2 2v4l-2 2 2 2v4a2 2 0 0 0 2 2h2M16 4h2a2 2 0 0 1 2 2v4l2 2-2 2v4a2 2 0 0 1-2 2h-2"/></svg>',
};

function componentIcon(type) {
  return COMPONENT_ICONS[type] || COMPONENT_ICONS.equation;
}

function renderComponentBody(item, type) {
  const metadata = normalizedMetadata(item);
  const parts = [];

  if (type === "equation") {
    const latex = metadata.latex || item.latex;
    if (latex) parts.push(`<div class="latex">\\[${escapeHtml(latex)}\\]</div>`);
  }

  if (type === "figure") {
    parts.push(renderFigurePanel(item));
  }

  if (type === "algorithm") {
    const steps = metadata.steps_summary || item.steps_summary;
    if (steps) parts.push(`<div class="text-block">${escapeHtml(steps)}</div>`);
    if (Array.isArray(metadata.inputs) || Array.isArray(metadata.outputs)) {
      parts.push(renderKeyValues({ inputs: metadata.inputs, outputs: metadata.outputs }));
    }
  }

  const description = [
    item.content,
    item.description,
    metadata.key_insight,
    metadata.caption && type !== "figure" ? metadata.caption : "",
    item.context,
  ]
    .filter(Boolean)
    .filter((value, index, array) => array.indexOf(value) === index)
    .join("\n\n");
  if (description) parts.push(`<div class="text-block">${escapeHtml(description)}</div>`);

  const meta = {
    role: item.role || metadata.role_label,
    figure_type: metadata.figure_type || item.figure_type,
    framework: metadata.framework || item.framework,
    confidence: item.confidence,
  };
  parts.push(renderKeyValues(meta));

  return parts.filter(Boolean).join("") || renderKeyValues(item);
}

function figureImageUrl(item) {
  const metadata = normalizedMetadata(item);
  let url = String(
    item.image_url ||
      metadata.image_url ||
      item.image ||
      metadata.image ||
      item.figure_url ||
      metadata.figure_url ||
      item.url ||
      metadata.url ||
      "",
  ).trim();
  if (!url) return "";
  if (/^(https?:|data:)/.test(url)) return url;
  // Resolve relative paths against the pipeline API host (figures may be served there).
  const base = String(state.apiBaseUrl || "").replace(/\/$/, "");
  if (!base) return "";
  return url.startsWith("/") ? `${base}${url}` : `${base}/${url}`;
}

function figureVisual(item, caption) {
  const id = item.id || "";
  const src = figureImageUrl(item) || figureCropCache.get(id) || "";
  if (src) {
    return `
      <figure class="figure-image" data-fig="${escapeAttribute(id)}">
        <img src="${escapeAttribute(src)}" alt="${escapeAttribute(caption)}" loading="lazy"
          onerror="this.closest('.figure-image').dataset.broken='1'" />
      </figure>
    `;
  }
  const loading = Boolean(getPaperPdfFile()) && hasFigureBox(item) && !figureCropCache.has(id);
  return `
    <div class="figure-visual${loading ? " is-loading" : ""}" data-fig="${escapeAttribute(id)}" aria-hidden="true">
      <span></span><span></span><span></span><span></span>
      <i></i><i></i><i></i>
    </div>
  `;
}

/* ---- Figure preview: crop the figure region out of the uploaded PDF ---- */
function figureBox(item) {
  const metadata = normalizedMetadata(item);
  const bbox = metadata.page_bbox || item.page_bbox;
  return Array.isArray(bbox) && bbox.length >= 4 ? bbox.map(Number) : null;
}

function figurePageNumber(item) {
  const metadata = normalizedMetadata(item);
  const location = item.location && typeof item.location === "object" ? item.location : {};
  const page = Number(location.page ?? item.page ?? metadata.page);
  return Number.isFinite(page) && page > 0 ? page : null;
}

function hasFigureBox(item) {
  return Boolean(figureBox(item) && figurePageNumber(item));
}

function getPaperPdfFile() {
  if (paperPdf.file) return paperPdf.file;
  if (state.file && /\.pdf$/i.test(state.file.name || "")) return state.file;
  return null;
}

function setPaperPdf(file) {
  if (!file) return;
  paperPdf.file = file;
  paperPdf.docFile = null;
  paperPdf.docPromise = null;
  figureCropCache.clear();
  renderEvidenceTabs();
  ensureFigureCrops();
}

const PDFJS_VERSION = "4.7.76";

async function loadPdfjs() {
  if (!pdfjsLibPromise) {
    pdfjsLibPromise = (async () => {
      const lib = await import(`https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.min.mjs`);
      // Load the worker through a same-origin blob that re-imports the CDN
      // module, so the cross-origin worker isn't blocked by the browser.
      const workerBlob = new Blob(
        [`import "https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.worker.min.mjs";`],
        { type: "text/javascript" },
      );
      lib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(workerBlob);
      return lib;
    })();
  }
  return pdfjsLibPromise;
}

async function getPdfDoc() {
  const file = getPaperPdfFile();
  if (!file) return null;
  if (!paperPdf.docPromise || paperPdf.docFile !== file) {
    paperPdf.docFile = file;
    paperPdf.docPromise = (async () => {
      const lib = await loadPdfjs();
      const data = await file.arrayBuffer();
      return lib.getDocument({ data }).promise;
    })();
  }
  return paperPdf.docPromise;
}

async function ensureFigureCrops() {
  if (!state.result || !getPaperPdfFile()) return;
  const figures = getExtractionItems(state.result, "figure");
  let doc = null;
  for (const figure of figures) {
    const id = figure.id;
    if (!id || figureImageUrl(figure) || figureCropCache.has(id)) continue;
    if (!hasFigureBox(figure)) {
      figureCropCache.set(id, null);
      continue;
    }
    try {
      doc = doc || (await getPdfDoc());
      if (!doc) return;
      const url = await cropFigure(doc, figurePageNumber(figure), figureBox(figure));
      figureCropCache.set(id, url || null);
      if (url) applyFigureCrop(id, url);
    } catch {
      figureCropCache.set(id, null);
    }
  }
}

async function cropFigure(doc, pageNo, bbox) {
  if (!pageNo || pageNo > doc.numPages) return null;
  const page = await doc.getPage(pageNo);
  const scale = 2;
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const task = page.render({ canvasContext: canvas.getContext("2d"), viewport });
  // Guard against environments where canvas rasterization stalls.
  await Promise.race([
    task.promise,
    new Promise((_, reject) =>
      setTimeout(() => {
        try {
          task.cancel();
        } catch {
          // ignore
        }
        reject(new Error("render-timeout"));
      }, 20000),
    ),
  ]);

  const [x0, y0, x1, y1] = bbox;
  const W = canvas.width;
  const H = canvas.height;
  const pad = 8;
  const sx = Math.max(0, x0 * W - pad);
  const sy = Math.max(0, y0 * H - pad);
  const sw = Math.min(W - sx, (x1 - x0) * W + pad * 2);
  const sh = Math.min(H - sy, (y1 - y0) * H + pad * 2);
  if (sw < 4 || sh < 4) return null;

  const out = document.createElement("canvas");
  out.width = Math.ceil(sw);
  out.height = Math.ceil(sh);
  out.getContext("2d").drawImage(canvas, sx, sy, sw, sh, 0, 0, out.width, out.height);
  return out.toDataURL("image/png");
}

function applyFigureCrop(id, url) {
  if (!url) return;
  const selector = window.CSS && CSS.escape ? CSS.escape(id) : id;
  document.querySelectorAll(`[data-fig="${selector}"]`).forEach((el) => {
    if (el.querySelector("img")) return;
    const figure = document.createElement("figure");
    figure.className = "figure-image";
    figure.dataset.fig = id;
    const img = document.createElement("img");
    img.src = url;
    img.alt = "";
    figure.appendChild(img);
    el.replaceWith(figure);
  });
}

function renderFigurePanel(item) {
  const metadata = normalizedMetadata(item);
  const caption = metadata.caption || item.caption || item.content || item.id || "Extracted figure";
  const insight = metadata.key_insight || item.content || item.description || "";
  return `
    <div class="figure-panel">
      ${figureVisual(item, caption)}
      <div>
        <strong>${escapeHtml(caption)}</strong>
        ${insight ? `<p>${escapeHtml(insight)}</p>` : ""}
      </div>
    </div>
  `;
}

function renderRepresentativeFigure(figure) {
  if (!figure) return `<div class="empty-note">No figure was extracted from this paper.</div>`;
  const metadata = normalizedMetadata(figure);
  const caption = metadata.caption || figure.caption || figure.content || figure.id || "Representative figure";
  const insight = metadata.key_insight || figure.content || figure.description || "";
  const location = componentLocation(figure);

  return `
    <article class="representative-figure">
      ${figureVisual(figure, caption)}
      <div>
        <div class="card-kicker">${escapeHtml(location || "Figure")}</div>
        <h3>${escapeHtml(caption)}</h3>
        ${insight ? `<p>${escapeHtml(insight)}</p>` : ""}
      </div>
    </article>
  `;
}

function renderEvidenceTabs() {
  renderEvidenceList("equation", elements.equationList);
  renderEvidenceList("figure", elements.figureList);
  renderEvidenceList("algorithm", elements.algorithmList);
}

function renderRunbook() {
  if (!elements.runbookContent) return;

  if (!state.result) {
    elements.runbookSummary.textContent =
      "Uses the repository README, requirements, and extracted commands to draft a reproducibility path.";
    elements.runbookContent.innerHTML = `<div class="empty-note">No pipeline result yet.</div>`;
    return;
  }

  if (state.runbookBusy) {
    elements.runbookSummary.textContent =
      "Reading repository docs and backend commands, then asking OpenAI for a reproduction plan.";
    elements.runbookContent.innerHTML = `
      <article class="runbook-loading">
        <span class="hero-badge proc-badge"><i class="proc-spin" aria-hidden="true"></i> Generating</span>
        <p>Combining README.md, requirements.txt, extracted commands, and paper evidence into a runbook.</p>
      </article>
    `;
    return;
  }

  if (state.runbookError) {
    elements.runbookSummary.textContent = "Runbook generation failed. You can retry when the API is available.";
    elements.runbookContent.innerHTML = `<div class="empty-note">${escapeHtml(state.runbookError)}</div>`;
    return;
  }

  if (!state.runbook) {
    const commands = getExtractionItems(state.result, "command").length;
    elements.runbookSummary.textContent = `${commands} backend command components detected. Generate a reproduction guide from repo docs and extracted evidence.`;
    elements.runbookContent.innerHTML = `
      <article class="runbook-empty">
        <h3>Ready to build a reproduction runbook</h3>
        <p>
          The runbook API will inspect the GitHub repository README and requirements files,
          combine them with backend-extracted command components, and ask OpenAI for an ordered
          reproduction guide.
        </p>
      </article>
    `;
    return;
  }

  const runbook = state.runbook;
  const meta = state.runbookMeta || {};
  const repo = meta.github_repository || state.result.github_repository || {};
  const sourceFiles = meta.source_files || {};
  const commandsUsed = Array.isArray(meta.commands_used) ? meta.commands_used : [];
  elements.runbookSummary.textContent = `${runbook.source_confidence || "unknown"} confidence · ${
    repo.model || "OpenAI"
  } · ${commandsUsed.length} commands considered`;

  elements.runbookContent.innerHTML = `
    <article class="runbook-hero">
      <div>
        <p class="eyebrow">Reproduction path</p>
        <h3>${escapeHtml(runbook.title || "Paper reproduction runbook")}</h3>
        <p>${escapeHtml(runbook.overview || "")}</p>
      </div>
      <div class="runbook-source-grid">
        ${runbookSourcePill("Repository", repo.url || resolvedGithubUrl() || "unknown")}
        ${runbookSourcePill("README", sourceFiles.readme?.found ? sourceFiles.readme.path : "not found")}
        ${runbookSourcePill(
          "Requirements",
          sourceFiles.requirements?.found ? sourceFiles.requirements.path : "not found",
        )}
        ${runbookSourcePill("Commit", repo.commit ? String(repo.commit).slice(0, 10) : "HEAD")}
      </div>
    </article>
    ${renderRunbookEnvironment(runbook.environment)}
    ${renderRunbookStepSection("Setup", runbook.setup)}
    ${renderRunbookStepSection("Data preparation", runbook.data_preparation)}
    ${renderRunbookStepSection("Reproduction steps", runbook.reproduction_steps)}
    ${renderRunbookStepSection("Evaluation", runbook.evaluation)}
    ${renderRunbookList("Expected outputs", runbook.expected_outputs)}
    ${renderRunbookStepSection("Troubleshooting", runbook.troubleshooting)}
    ${renderRunbookList("Assumptions", runbook.assumptions)}
    ${renderRunbookList("Open questions", runbook.open_questions)}
    ${renderRunbookList("Source notes", runbook.source_notes)}
  `;
  enhanceCodeBlocks();
}

function renderRunbookEnvironment(environment) {
  if (!environment || typeof environment !== "object") return "";
  return `
    <section class="runbook-section">
      <h3>Environment</h3>
      ${renderKeyValues({
        package_manager: environment.package_manager,
        python: environment.python,
        frameworks: Array.isArray(environment.frameworks) ? environment.frameworks : [],
        hardware: environment.hardware,
      })}
    </section>
  `;
}

function renderRunbookStepSection(title, steps) {
  if (!Array.isArray(steps) || !steps.length) return "";
  return `
    <section class="runbook-section">
      <h3>${escapeHtml(title)}</h3>
      <div class="runbook-step-list">
        ${steps.map((step, index) => renderRunbookStep(step, index)).join("")}
      </div>
    </section>
  `;
}

function renderRunbookStep(step, index) {
  const commands = Array.isArray(step.commands) ? step.commands.filter(Boolean) : [];
  return `
    <article class="runbook-step">
      <span class="rank-badge">${escapeHtml(index + 1)}</span>
      <div>
        <h4>${escapeHtml(step.title || `Step ${index + 1}`)}</h4>
        ${step.notes ? `<p>${escapeHtml(step.notes)}</p>` : ""}
        ${
          commands.length
            ? commands
                .map((command) => `
                  <div class="code-card">
                    <div class="code-head"><span>Command</span><button class="code-copy" type="button">Copy</button></div>
                    <pre class="code-body"><code data-raw="${escapeAttribute(command)}">${escapeHtml(command)}</code></pre>
                  </div>
                `)
                .join("")
            : ""
        }
        ${step.source ? `<div class="component-meta">Source: ${escapeHtml(step.source)}</div>` : ""}
      </div>
    </article>
  `;
}

function renderRunbookList(title, values) {
  if (!Array.isArray(values) || !values.length) return "";
  return `
    <section class="runbook-section">
      <h3>${escapeHtml(title)}</h3>
      <ul class="runbook-list">
        ${values.map((value) => `<li>${escapeHtml(value)}</li>`).join("")}
      </ul>
    </section>
  `;
}

function runbookSourcePill(label, value) {
  return `
    <span class="metric-pill runbook-source-pill">
      <small>${escapeHtml(label)}</small>
      <strong>${escapeHtml(value)}</strong>
    </span>
  `;
}

function renderEvidenceList(type, container) {
  if (!container) return;
  const items = getExtractionItems(state.result, type);
  if (!items.length) {
    container.innerHTML = `<div class="empty-note">No ${escapeHtml(type)} extraction result yet.</div>`;
    return;
  }

  let prefix = "";
  if (
    type === "figure" &&
    !getPaperPdfFile() &&
    items.some((figure) => hasFigureBox(figure) && !figureImageUrl(figure))
  ) {
    prefix = `
      <label class="figure-pdf-prompt" for="figurePdfInput">
        <span class="figure-pdf-icon" aria-hidden="true">⇪</span>
        <span class="figure-pdf-copy">
          <strong>Attach the paper PDF to preview figures</strong>
          <small>Figures are located by page region — the PDF is read in your browser only.</small>
        </span>
      </label>
    `;
  }

  container.innerHTML = prefix + items.map((item, index) => renderEvidenceCard(type, item, index)).join("");
  if (type === "figure") ensureFigureCrops();
}

function renderEvidenceCard(type, item, index) {
  const mappings = mappingsForComponent(item).sort(
    (a, b) => statusRank(a.verification_status) - statusRank(b.verification_status),
  );
  const title = componentTitle(item, type, index);

  return `
    <article class="evidence-card component-card" data-kind="${escapeAttribute(type)}">
      <div class="evidence-paper">
        <div class="evidence-head">
          <div class="evidence-title">
            <span class="evidence-icon" data-kind="${escapeAttribute(type)}" aria-hidden="true">${componentIcon(type)}</span>
            <div>
              <div class="card-kicker">${escapeHtml(type)} · ${escapeHtml(item.id || `${type}_${index + 1}`)}</div>
              <h3>${escapeHtml(String(title).slice(0, 180))}</h3>
            </div>
          </div>
        </div>
        <div class="component-meta">${escapeHtml(componentMeta(item) || `${type} component`)}</div>
        <div class="component-body">${renderComponentBody(item, type)}</div>
      </div>
      <div class="evidence-code">
        <div class="code-pane-inner">
          <div class="pane-label">Grounded code mapping</div>
          <div class="grounded-scroll">
            ${
              mappings.length
                ? mappings.map((mapping) => renderMappingEvidence(mapping)).join("")
                : `<div class="empty-note">No code mapping was reported for this ${escapeHtml(type)}.</div>`
            }
          </div>
        </div>
      </div>
    </article>
  `;
}

function renderMappingEvidence(mapping) {
  const status = mapping.verification_status || "unknown";
  const matches = Array.isArray(mapping.matches) ? mapping.matches : [];
  const bestConfidence = matches.length
    ? Math.max(...matches.map((match) => Number(match.confidence) || 0))
    : 0;

  return `
    <section class="mapping-card" data-status="${escapeHtml(status)}">
      <div class="mapping-head">
        <div>
          <h3>${escapeHtml(mapping.component_id || "component")}</h3>
          <div class="mapping-meta">Best confidence ${escapeHtml(formatPercent(bestConfidence))}</div>
        </div>
        <span class="status-badge" data-status="${escapeHtml(status)}">${escapeHtml(status)}</span>
      </div>
      ${
        mapping.reviewer_note
          ? `<div class="text-block reviewer-note">${escapeHtml(mapping.reviewer_note)}</div>`
          : ""
      }
      <div class="match-list">
        ${
          matches.length
            ? matches.map((match, index) => renderMatch(match, index)).join("")
            : `<div class="empty-note">No match found.</div>`
        }
      </div>
    </section>
  `;
}

function renderMatch(match, index = 0) {
  const githubUrl = state.result?.github_url || state.job?.github_url || state.repoUrl;
  const link = buildGithubLineUrl(githubUrl, match.file, match.line_start, match.line_end);
  const file = match.file || "unknown file";
  const fileName = String(file).split("/").pop();
  const lineLabel =
    match.line_start != null ? `L${match.line_start}${match.line_end ? `–${match.line_end}` : ""}` : "";
  const snippet = match.matched_code_snippet || "";

  const hasCode = Boolean(snippet) || Number(match.line_start) > 0;

  return `
    <div class="code-card"
      data-file="${escapeAttribute(file)}"
      data-start="${escapeAttribute(match.line_start ?? "")}"
      data-end="${escapeAttribute(match.line_end ?? "")}"
      data-repo="${escapeAttribute(githubUrl || "")}"
      data-link="${escapeAttribute(link)}"
      data-snippet="${escapeAttribute(snippet)}">
      <div class="code-card-head">
        <span class="code-dot" aria-hidden="true"></span>
        <span class="code-file" title="${escapeAttribute(file)}">${escapeHtml(fileName)}</span>
        ${lineLabel ? `<span class="code-lines">${escapeHtml(lineLabel)}</span>` : ""}
        <span class="code-conf">${escapeHtml(formatPercent(match.confidence))}</span>
        <span class="code-spacer"></span>
        <button class="code-copy" type="button" title="Copy snippet">Copy</button>
        <a class="code-gh" href="${escapeAttribute(link)}" target="_blank" rel="noreferrer">GitHub ↗</a>
      </div>
      ${match.semantic_link ? `<div class="code-semantic">${escapeHtml(match.semantic_link)}</div>` : ""}
      ${
        hasCode
          ? `<a class="code-open" href="${escapeAttribute(link)}" target="_blank" rel="noreferrer" title="Open this code location on GitHub">
              <div class="code-scroll" data-state="loading">
                <pre class="code-gutter" aria-hidden="true"></pre>
                <pre class="code-body"><code>${escapeHtml(snippet) || "// loading code from GitHub…"}</code></pre>
              </div>
            </a>`
          : `<div class="code-none">No matching code location was provided.</div>`
      }
    </div>
  `;
}

const fileCache = new Map();
const branchCache = new Map();

function parseRepo(repoUrl) {
  const match = String(repoUrl || "").match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  return match ? { owner: match[1], repo: match[2] } : null;
}

async function resolveBranch(owner, repo) {
  const key = `${owner}/${repo}`;
  if (branchCache.has(key)) return branchCache.get(key);
  let branch = "main";
  try {
    const response = await fetch(`https://api.github.com/repos/${owner}/${repo}`);
    if (response.ok) branch = (await response.json()).default_branch || "main";
  } catch {
    // Fall back to common branch names below.
  }
  branchCache.set(key, branch);
  return branch;
}

async function fetchRepoFile(owner, repo, path) {
  const key = `${owner}/${repo}/${path}`;
  if (fileCache.has(key)) return fileCache.get(key);

  const branch = await resolveBranch(owner, repo);
  const candidates = [...new Set([branch, "main", "master"])];
  let text = null;
  for (const ref of candidates) {
    try {
      const response = await fetch(
        `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}`,
      );
      if (response.ok) {
        text = await response.text();
        break;
      }
    } catch {
      // Try the next candidate ref.
    }
  }
  fileCache.set(key, text);
  return text;
}

function detectLanguage(file) {
  const ext = String(file).split(".").pop().toLowerCase();
  const map = {
    py: "python",
    js: "javascript",
    mjs: "javascript",
    ts: "typescript",
    tsx: "typescript",
    jsx: "javascript",
    java: "java",
    cc: "cpp",
    cpp: "cpp",
    cxx: "cpp",
    h: "cpp",
    hpp: "cpp",
    c: "c",
    go: "go",
    rs: "rust",
    rb: "ruby",
    sh: "bash",
    bash: "bash",
    yaml: "yaml",
    yml: "yaml",
    json: "json",
    md: "markdown",
    lua: "lua",
    scala: "scala",
    swift: "swift",
    kt: "kotlin",
  };
  return map[ext] || null;
}

function paintCode(card, codeText, startLine) {
  const scroll = card.querySelector(".code-scroll");
  const codeEl = card.querySelector(".code-body code");
  const gutter = card.querySelector(".code-gutter");
  if (!scroll || !codeEl) return;

  const lines = codeText.replace(/\n$/, "").split("\n");
  const base = Number(startLine) || 1;
  gutter.textContent = lines.map((_, i) => base + i).join("\n");

  const lang = detectLanguage(card.dataset.file);
  if (window.hljs) {
    try {
      const html =
        lang && window.hljs.getLanguage(lang)
          ? window.hljs.highlight(codeText, { language: lang }).value
          : window.hljs.highlightAuto(codeText).value;
      codeEl.innerHTML = html;
    } catch {
      codeEl.textContent = codeText;
    }
  } else {
    codeEl.textContent = codeText;
  }
  codeEl.dataset.raw = codeText;
  scroll.dataset.state = "ready";
}

async function enhanceCard(card) {
  if (card.dataset.enhanced) return;
  card.dataset.enhanced = "1";
  if (!card.querySelector(".code-scroll")) return;

  const snippet = card.dataset.snippet || "";
  const start = Number(card.dataset.start);
  const end = Number(card.dataset.end);
  const repoInfo = parseRepo(card.dataset.repo);

  // Default to the snippet the pipeline returned; upgrade to the real file when possible.
  if (snippet) paintCode(card, snippet, start || 1);

  if (!repoInfo || !card.dataset.file || !Number.isFinite(start) || start <= 0) return;

  const text = await fetchRepoFile(repoInfo.owner, repoInfo.repo, card.dataset.file);
  if (!text) return;
  const all = text.split("\n");
  const from = Math.max(1, start);
  const to = Number.isFinite(end) && end >= from ? end : from;
  const slice = all.slice(from - 1, to).join("\n");
  if (slice.trim()) paintCode(card, slice, from);
}

function enhanceCodeBlocks() {
  document.querySelectorAll(".code-card:not([data-enhanced])").forEach((card) => enhanceCard(card));
}

function renderRuntimeItem(entry) {
  const title = entry.agent || entry.stage || entry.name || entry.node || "runtime";
  return `
    <article class="runtime-item">
      <div>
        <strong>${escapeHtml(title)}</strong>
        <div class="component-meta">${entry.duration_seconds != null ? `${escapeHtml(entry.duration_seconds)}s` : ""}</div>
      </div>
      <div>${renderKeyValues(entry)}</div>
    </article>
  `;
}

function infoCard(title, body, extraClass = "") {
  return `
    <section class="info-card ${extraClass}">
      <h3>${escapeHtml(title)}</h3>
      ${body || `<div class="empty-note">No data yet.</div>`}
    </section>
  `;
}

function renderPlan(plan) {
  if (!Array.isArray(plan) || !plan.length) {
    return `<div class="empty-note">No plan summary available.</div>`;
  }

  return `<div class="plan-list">${plan
    .map((item, index) => {
      const title = item.extractor || item.name || item.agent || item.stage || `Step ${index + 1}`;
      const body = item.focus || item.reason || item.description || item.summary || "";
      return `
        <div class="plan-item">
          <span class="rank-badge">${escapeHtml(item.priority ?? index + 1)}</span>
          <div>
            <strong>${escapeHtml(title)}</strong>
            <div class="component-meta">${escapeHtml(body)}</div>
            ${renderKeyValues(item)}
          </div>
        </div>
      `;
    })
    .join("")}</div>`;
}

function renderKeyValues(object) {
  if (!object || typeof object !== "object") return "";
  const entries = Object.entries(object).filter(([, value]) => value != null && value !== "");
  if (!entries.length) return "";
  return `
    <div class="kv-grid">
      ${entries
        .map(
          ([key, value]) => `
            <div class="kv-item">
              <small>${escapeHtml(formatKey(key))}</small>
              ${formatStructuredValue(value)}
            </div>
          `,
        )
        .join("")}
    </div>
  `;
}

function summaryObject() {
  return {
    job_id: state.result?.job_id || state.job?.job_id,
    filename: state.result?.filename || state.job?.filename,
    github_url: state.result?.github_url || state.job?.github_url || state.repoUrl,
    status: state.result?.status || state.job?.status,
    overall_grounding_score: scoreFromState() == null ? null : formatPercent(scoreFromState()),
    total_extracted: state.job?.total_extracted ?? countExtracted(state.result),
  };
}

function getExtractionItems(result, type) {
  const key = `${type}_extractor`;
  const direct = extractionItems(result?.extractions?.[key]);
  if (direct.length) return direct;
  return extractionGroups(result)
    .filter(([groupKey]) => groupKey.includes(type))
    .flatMap(([, items]) => items);
}

function componentIds(item) {
  return [
    item?.id,
    item?.component_id,
    item?.figure_id,
    item?.algorithm_id,
    item?.command_id,
    item?.eq_number != null ? `eq_${item.eq_number}` : null,
    item?.fig_number != null ? `fig_${item.fig_number}` : null,
  ]
    .filter(Boolean)
    .map(String);
}

function mappingsForComponent(item) {
  const ids = new Set(componentIds(item));
  const mappings = Array.isArray(state.result?.mappings) ? state.result.mappings : [];
  return mappings.filter((mapping) => ids.has(String(mapping.component_id)));
}

function extractionGroups(result) {
  const extractions = result?.extractions;
  if (!extractions || typeof extractions !== "object") return [];
  return Object.entries(extractions)
    .map(([key, value]) => [key, extractionItems(value)])
    .filter(([, value]) => value.length);
}

function firstExtractionGroup(result) {
  return extractionGroups(result)[0]?.[0] || null;
}

function findComponent(componentId) {
  if (!componentId) return null;
  for (const [, items] of extractionGroups(state.result)) {
    const found = items.find((item) => {
      const ids = [
        item.id,
        item.component_id,
        item.figure_id,
        item.algorithm_id,
        item.command_id,
        item.eq_number != null ? `eq_${item.eq_number}` : null,
        item.fig_number != null ? `fig_${item.fig_number}` : null,
      ].filter(Boolean);
      return ids.map(String).includes(String(componentId));
    });
    if (found) return found;
  }
  return null;
}

function countExtracted(result) {
  return extractionGroups(result).reduce((sum, [, items]) => sum + items.length, 0);
}

function extractionItems(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value.items)) return value.items;
  if (Array.isArray(value.results)) return value.results;
  if (Array.isArray(value.extractions)) return value.extractions;
  return [];
}

function componentMeta(component) {
  const location = component.location && typeof component.location === "object" ? component.location : {};
  const metadata = component.metadata && typeof component.metadata === "object" ? component.metadata : {};
  return [
    component.id,
    component.type,
    location.section,
    location.page != null ? `page ${location.page}` : "",
    metadata.role_label,
    component.confidence != null ? `confidence ${formatPercent(component.confidence)}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

function scoreFromState() {
  const score = state.result?.overall_grounding_score ?? state.job?.overall_grounding_score;
  return Number.isFinite(Number(score)) ? Number(score) : null;
}

function statusLine(job) {
  const parts = [
    "Pipeline processing",
    job.total_extracted != null ? `${job.total_extracted} extracted` : "",
  ].filter(Boolean);
  return parts.join(" · ");
}

function pollDelayMs() {
  const startedAt = state.pollStartedAt || Date.now();
  return Date.now() - startedAt < POLL_FAST_WINDOW_MS ? POLL_INITIAL_INTERVAL_MS : POLL_LATER_INTERVAL_MS;
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    window.clearTimeout(timeoutId);
  }
}

async function fetchWithRetry(url, options = {}) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_TRANSIENT_FETCH_RETRIES; attempt += 1) {
    try {
      return await fetchWithTimeout(url, options);
    } catch (error) {
      lastError = error;
      if (attempt < MAX_TRANSIENT_FETCH_RETRIES) {
        const waitMs = pollDelayMs();
        addStatus(`Temporary fetch issue (${attempt}/${MAX_TRANSIENT_FETCH_RETRIES}). Retrying in ${Math.round(waitMs / 1000)}s.`, "pending");
        await delay(waitMs);
      }
    }
  }
  throw lastError;
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { detail: text };
  }
}

function errorMessage(payload, fallback) {
  if (!payload) return fallback;
  if (typeof payload.error === "string") return payload.error;
  if (typeof payload.detail === "string") return payload.detail;
  if (Array.isArray(payload.detail)) return payload.detail.map((item) => item.msg || JSON.stringify(item)).join("; ");
  return fallback;
}

function buildGithubLineUrl(repoUrl, file, lineStart, lineEnd) {
  if (!repoUrl || !file) return "#";
  const normalized = repoUrl.replace(/\/$/, "").replace(/\.git$/, "");
  const line = lineStart ? `#L${lineStart}${lineEnd ? `-L${lineEnd}` : ""}` : "";
  return `${normalized}/blob/HEAD/${file}${line}`;
}

function resolvedGithubUrl() {
  return (
    state.result?.github_repository?.url ||
    state.result?.github_url ||
    state.job?.github_url ||
    state.repoUrl ||
    ""
  );
}

function formatKey(key) {
  return String(key).replaceAll("_", " ");
}

function formatValue(value) {
  if (Array.isArray(value)) return value.map(formatValue).join(", ");
  if (typeof value === "object" && value !== null) return JSON.stringify(value);
  if (typeof value === "number" && value >= 0 && value <= 1) return formatPercent(value);
  return String(value);
}

function formatStructuredValue(value) {
  if (Array.isArray(value)) {
    const visible = value.slice(0, 12);
    const extra = value.length - visible.length;
    return `
      <div class="chip-list">
        ${visible.map((item) => `<span class="chip">${escapeHtml(formatValue(item))}</span>`).join("")}
        ${extra > 0 ? `<span class="chip is-muted">+${extra}</span>` : ""}
      </div>
    `;
  }
  if (typeof value === "object" && value !== null) {
    return `<pre class="inline-json">${escapeHtml(JSON.stringify(value, null, 2))}</pre>`;
  }
  return `<span>${escapeHtml(formatValue(value))}</span>`;
}

function metricPill(label, value) {
  return `
    <span class="metric-pill">
      <small>${escapeHtml(label)}</small>
      <strong>${escapeHtml(formatValue(value))}</strong>
    </span>
  `;
}

function formatExtractorType(key) {
  return String(key).replace(/_extractor$/, "").replaceAll("_", " ");
}

function formatPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  return `${Math.round(number * 100)}%`;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll("`", "&#096;");
}

function scheduleMathTypeset() {
  window.clearTimeout(state.mathTypesetTimer);
  state.mathTypesetTimer = window.setTimeout(() => {
    if (window.MathJax?.typesetPromise) {
      window.MathJax.typesetPromise().catch(() => {});
    }
  }, 50);
}
