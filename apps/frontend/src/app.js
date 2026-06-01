const DEFAULT_API_BASE_URL = "https://paper2run.onrender.com";
const LEGACY_API_BASE_URLS = new Set(["https://paper2run-production.up.railway.app"]);
const SETTINGS_STORAGE_KEY = "paper2run.pipeline.frontend.settings";
const JOB_STORAGE_KEY = "paper2run.pipeline.frontend.lastJob";
const POLL_INITIAL_INTERVAL_MS = 5000;
const POLL_LATER_INTERVAL_MS = 12000;
const POLL_FAST_WINDOW_MS = 60000;
const FETCH_TIMEOUT_MS = 30000;
const MAX_TRANSIENT_FETCH_RETRIES = 5;

const PIPELINE_STEPS = ["Profile", "Extract", "Ground", "Verify"];

const savedSettings = loadSavedSettings();

const state = {
  file: null,
  repoUrl: savedSettings.repoUrl || "",
  apiBaseUrl: normalizeApiBaseUrl(savedSettings.apiBaseUrl),
  job: null,
  result: null,
  statuses: [],
  activeTab: "overview",
  activeExtractionGroup: "equations",
  flaggedOnly: false,
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
  procMeta: document.querySelector("#procMeta"),
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
  flaggedMetric: document.querySelector("#flaggedMetric"),
  tabs: [...document.querySelectorAll(".tab")],
  emptyState: document.querySelector("#emptyState"),
  overviewGrid: document.querySelector("#overviewGrid"),
  extractionTabs: document.querySelector("#extractionTabs"),
  extractionList: document.querySelector("#extractionList"),
  flaggedOnly: document.querySelector("#flaggedOnly"),
  mappingSummary: document.querySelector("#mappingSummary"),
  mappingList: document.querySelector("#mappingList"),
  runtimeList: document.querySelector("#runtimeList"),
};

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

  elements.newRunBtn?.addEventListener("click", () => goToLanding());
  elements.brandHome?.addEventListener("click", () => goToLanding());
  elements.procBackBtn?.addEventListener("click", () => {
    state.polling = false;
    goToLanding();
  });

  elements.mappingList?.addEventListener("click", (event) => {
    const button = event.target.closest(".code-copy");
    if (!button) return;
    const code = button.closest(".code-card")?.querySelector(".code-body code");
    const text = code?.dataset.raw ?? code?.textContent ?? "";
    navigator.clipboard?.writeText(text).then(
      () => {
        button.textContent = "Copied";
        window.setTimeout(() => (button.textContent = "Copy"), 1400);
      },
      () => {},
    );
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

  elements.flaggedOnly.addEventListener("change", () => {
    state.flaggedOnly = elements.flaggedOnly.checked;
    renderMappings();
  });

  elements.tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      state.activeTab = tab.dataset.tab;
      renderTabs();
      if (state.activeTab === "grounding") enhanceCodeBlocks();
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
        flagged_count: job.flagged_count,
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
      flagged_count: saved.flagged_count,
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
    flagged_count: Array.isArray(result.flagged_ids) ? result.flagged_ids.length : 0,
    overall_grounding_score: result.overall_grounding_score,
  };
  addStatus("Pipeline finished", "done");
  render();
  await delay(550);

  state.result = result;
  saveJobSnapshot({ ...result, status: "done" });
  state.activeTab = "overview";
  state.activeExtractionGroup = firstExtractionGroup(result) || "equations";
  addStatus("Result loaded", "done");
  render();
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
    state.job = {
      job_id: state.result.job_id || "loaded-json",
      status: state.result.status || "done",
      filename: state.result.filename,
      github_url: state.result.github_url,
      overall_grounding_score: state.result.overall_grounding_score,
      flagged_count: Array.isArray(state.result.flagged_ids) ? state.result.flagged_ids.length : null,
      total_extracted: countExtracted(state.result),
    };
    state.activeTab = "overview";
    state.activeExtractionGroup = firstExtractionGroup(state.result) || "equations";
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

  if (stage === "processing") startProcTimer();
  else stopProcTimer();
}

let procTimer = null;

function startProcTimer() {
  if (procTimer) return;
  updateProcMeta();
  procTimer = window.setInterval(updateProcMeta, 1000);
}

function stopProcTimer() {
  if (!procTimer) return;
  window.clearInterval(procTimer);
  procTimer = null;
}

// A quiet elapsed-time line so a slow backend never looks frozen.
function updateProcMeta() {
  if (!elements.procMeta) return;
  if (state.job?.status === "error") {
    elements.procMeta.textContent = "";
    return;
  }
  const started = state.pollStartedAt || Date.now();
  const seconds = Math.max(0, Math.floor((Date.now() - started) / 1000));
  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  const note =
    seconds > 90
      ? "Still working — large repositories can take a few minutes."
      : "This runs asynchronously; results appear automatically.";
  elements.procMeta.textContent = `${clock} elapsed · ${note}`;
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

// Calm, honest status copy keyed to the inferred step — no fake counters.
const STEP_CAPTIONS = [
  "Reading the paper's structure and sections.",
  "Extracting equations, figures, and algorithms.",
  "Mapping each claim to your repository code.",
  "Scoring and verifying the evidence.",
  "Finalizing the evidence report.",
];

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
  renderExtractions();
  renderMappings();
  renderRuntime();
  updateControls();
  scheduleMathTypeset();
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
  elements.flaggedMetric.textContent = String(
    state.job?.flagged_count ?? (Array.isArray(state.result?.flagged_ids) ? state.result.flagged_ids.length : 0),
  );
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
  const plan = Array.isArray(state.result.plan) ? state.result.plan : state.job?.plan_summary || [];
  const overviewStats = [
    ["Paper Type", profile.paper_type],
    ["Trajectory", profile.trajectory],
    ["Layout", profile.layout],
    ["Pages", profile.page_count],
    ["Difficulty", profile.difficulty_score],
    ["Formalism", profile.formalism_role],
  ].filter(([, value]) => value != null && value !== "");

  elements.overviewGrid.innerHTML = [
    infoCard(
      "Profile",
      `
        <div class="profile-hero">
          <p>${escapeHtml(profile.reasoning || "No profile reasoning reported yet.")}</p>
          <div class="pill-row">${overviewStats.map(([key, value]) => metricPill(key, value)).join("")}</div>
        </div>
        ${renderKeyValues({ sections_present: profile.sections_present })}
      `,
      "is-wide is-profile",
    ),
    infoCard("Run Summary", renderKeyValues(summaryObject()), "is-summary"),
    infoCard("Plan", renderPlan(plan), "is-wide"),
  ].join("");
}

function renderExtractions() {
  const groups = extractionGroups(state.result);
  if (!groups.length) {
    elements.extractionTabs.innerHTML = "";
    elements.extractionList.innerHTML = `<div class="empty-note">No extraction result yet.</div>`;
    return;
  }

  if (!groups.some(([key]) => key === state.activeExtractionGroup)) {
    state.activeExtractionGroup = groups[0][0];
  }

  elements.extractionTabs.innerHTML = groups
    .map(
      ([key, items]) =>
        `<button class="subtab ${key === state.activeExtractionGroup ? "is-active" : ""}" type="button" data-group="${escapeHtml(
          key,
        )}">${escapeHtml(formatExtractorType(key))} · ${items.length}</button>`,
    )
    .join("");

  elements.extractionTabs.querySelectorAll(".subtab").forEach((button) => {
    button.addEventListener("click", () => {
      state.activeExtractionGroup = button.dataset.group;
      renderExtractions();
      scheduleMathTypeset();
    });
  });

  const activeItems = groups.find(([key]) => key === state.activeExtractionGroup)?.[1] || [];
  elements.extractionList.innerHTML = activeItems.length
    ? activeItems.map((item, index) => renderComponentCard(item, index)).join("")
    : `<div class="empty-note">No items in this extraction group.</div>`;
}

const STATUS_RANK = { verified: 0, weak: 1, no_match: 2, unknown: 3, hallucinated: 4 };

function statusRank(status) {
  return STATUS_RANK[String(status || "unknown").toLowerCase()] ?? 3;
}

function renderMappings() {
  const mappings = Array.isArray(state.result?.mappings) ? state.result.mappings : [];
  const flagged = new Set(state.result?.flagged_ids || []);
  const visible = state.flaggedOnly
    ? mappings.filter((mapping) => flagged.has(mapping.component_id) || mapping.verification_status !== "verified")
    : mappings.slice();

  // Surface trustworthy evidence first; push hallucinated/no-match to the bottom.
  visible.sort((a, b) => statusRank(a.verification_status) - statusRank(b.verification_status));

  elements.mappingSummary.textContent = `${mappings.length} mappings · ${flagged.size} flagged`;

  if (!visible.length) {
    elements.mappingList.innerHTML = `<div class="empty-note">No grounding mappings yet.</div>`;
    return;
  }

  elements.mappingList.innerHTML = visible.map((mapping) => renderMappingCard(mapping)).join("");
  if (state.activeTab === "grounding") enhanceCodeBlocks();
}

function renderRuntime() {
  const runtime = Array.isArray(state.result?.runtime_log)
    ? state.result.runtime_log
    : Array.isArray(state.job?.runtime_log)
      ? state.job.runtime_log
      : [];

  if (!runtime.length) {
    elements.runtimeList.innerHTML = `<div class="empty-note">Runtime log will appear after the pipeline reports it.</div>`;
    return;
  }

  elements.runtimeList.innerHTML = runtime.map((entry) => renderRuntimeItem(entry)).join("");
}

function renderComponentCard(item, index) {
  const metadata = item.metadata && typeof item.metadata === "object" ? item.metadata : {};
  const location = item.location && typeof item.location === "object" ? item.location : {};
  const title =
    item.algorithm_name ||
    item.command_type ||
    item.figure_id ||
    item.caption ||
    item.content ||
    item.role ||
    item.id ||
    `Item ${index + 1}`;
  const meta = [
    item.id ? `id ${item.id}` : "",
    item.type ? `type ${item.type}` : "",
    item.page != null ? `page ${item.page}` : "",
    location.page != null ? `page ${location.page}` : "",
    location.section ? `section ${location.section}` : "",
    item.confidence != null ? `confidence ${formatPercent(item.confidence)}` : "",
    item.role ? `role ${item.role}` : "",
    metadata.role_label ? `role ${metadata.role_label}` : "",
    item.figure_type ? `type ${item.figure_type}` : "",
    item.framework ? `framework ${item.framework}` : "",
  ].filter(Boolean);

  const body = [
    metadata.latex ? `<div class="latex">\\[${escapeHtml(metadata.latex)}\\]</div>` : "",
    item.latex ? `<div class="latex">\\[${escapeHtml(item.latex)}\\]</div>` : "",
    item.raw_command ? `<pre class="code-block">${escapeHtml(item.raw_command)}</pre>` : "",
    item.content ? `<div class="text-block">${escapeHtml(item.content)}</div>` : "",
    item.steps_summary ? `<div class="text-block">${escapeHtml(item.steps_summary)}</div>` : "",
    item.description ? `<div class="text-block">${escapeHtml(item.description)}</div>` : "",
    item.caption ? `<div class="text-block">${escapeHtml(item.caption)}</div>` : "",
    item.key_insight ? `<div class="text-block">${escapeHtml(item.key_insight)}</div>` : "",
    item.context ? `<div class="text-block">${escapeHtml(item.context)}</div>` : "",
  ]
    .filter(Boolean)
    .join("");

  return `
    <article class="component-card">
      <div class="card-kicker">${escapeHtml(formatExtractorType(item.type || state.activeExtractionGroup))}</div>
      <h3>${escapeHtml(String(title).slice(0, 140))}</h3>
      <div class="component-meta">${escapeHtml(meta.join(" · ") || "extracted component")}</div>
      <div class="component-body">${body || renderKeyValues(item)}</div>
    </article>
  `;
}

function renderMappingCard(mapping) {
  const status = mapping.verification_status || "unknown";
  const component = findComponent(mapping.component_id);
  const matches = Array.isArray(mapping.matches) ? mapping.matches : [];
  const componentTitle = component
    ? component.caption ||
      component.description ||
      component.algorithm_name ||
      component.raw_command ||
      component.content ||
      component.id
    : mapping.component_id;
  const bestConfidence = matches.length
    ? Math.max(...matches.map((match) => Number(match.confidence) || 0))
    : 0;

  return `
    <article class="mapping-card" data-status="${escapeHtml(status)}">
      <div class="mapping-head">
        <div>
          <h3>${escapeHtml(mapping.component_type || "component")} · ${escapeHtml(mapping.component_id)}</h3>
          <div class="mapping-meta">${escapeHtml(String(componentTitle || "No component preview").slice(0, 240))}</div>
        </div>
        <span class="status-badge" data-status="${escapeHtml(status)}">${escapeHtml(status)}</span>
      </div>
      <div class="mapping-grid">
        <section class="paper-pane">
          <div class="pane-label">Paper component</div>
          <p>${escapeHtml(String(componentTitle || "No component preview").slice(0, 420))}</p>
          ${component ? `<div class="component-meta">${escapeHtml(componentMeta(component))}</div>` : ""}
        </section>
        <section class="code-pane">
          <div class="pane-label">Code grounding · ${escapeHtml(formatPercent(bestConfidence))}</div>
          ${
            mapping.reviewer_note
              ? `<div class="text-block">${escapeHtml(mapping.reviewer_note)}</div>`
              : ""
          }
          <div class="match-list">
            ${
              matches.length
                ? matches.map((match) => renderMatch(match)).join("")
                : `<div class="empty-note">No match found.</div>`
            }
          </div>
        </section>
      </div>
    </article>
  `;
}

function renderMatch(match) {
  const githubUrl = state.result?.github_url || state.job?.github_url || state.repoUrl;
  const link = buildGithubLineUrl(githubUrl, match.file, match.line_start, match.line_end);
  const file = match.file || "unknown file";
  const fileName = String(file).split("/").pop();
  const lineLabel =
    match.line_start != null ? `L${match.line_start}${match.line_end ? `–${match.line_end}` : ""}` : "";
  const snippet = match.matched_code_snippet || "";

  return `
    <figure class="code-card"
      data-file="${escapeAttribute(file)}"
      data-start="${escapeAttribute(match.line_start ?? "")}"
      data-end="${escapeAttribute(match.line_end ?? "")}"
      data-repo="${escapeAttribute(githubUrl || "")}"
      data-snippet="${escapeAttribute(snippet)}">
      <figcaption class="code-card-head">
        <span class="code-dot" aria-hidden="true"></span>
        <span class="code-file" title="${escapeAttribute(file)}">${escapeHtml(fileName)}</span>
        ${lineLabel ? `<span class="code-lines">${escapeHtml(lineLabel)}</span>` : ""}
        <span class="code-conf">${escapeHtml(formatPercent(match.confidence))}</span>
        <span class="code-spacer"></span>
        <button class="code-copy" type="button" title="Copy snippet">Copy</button>
        <a class="code-gh" href="${escapeAttribute(link)}" target="_blank" rel="noreferrer">GitHub ↗</a>
      </figcaption>
      ${match.semantic_link ? `<div class="code-semantic">${escapeHtml(match.semantic_link)}</div>` : ""}
      <div class="code-scroll" data-state="loading">
        <pre class="code-gutter" aria-hidden="true"></pre>
        <pre class="code-body"><code>${escapeHtml(snippet) || "// loading code from GitHub…"}</code></pre>
      </div>
    </figure>
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

  const snippet = card.dataset.snippet || "";
  const start = Number(card.dataset.start);
  const end = Number(card.dataset.end);
  const repoInfo = parseRepo(card.dataset.repo);

  // Default to the snippet the pipeline returned; upgrade to the real file when possible.
  if (snippet) paintCode(card, snippet, start || 1);

  if (!repoInfo || !card.dataset.file || !Number.isFinite(start)) return;

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
    flagged_count: state.job?.flagged_count ?? state.result?.flagged_ids?.length ?? 0,
    total_extracted: state.job?.total_extracted ?? countExtracted(state.result),
  };
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
    job.flagged_count != null ? `${job.flagged_count} flagged` : "",
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
