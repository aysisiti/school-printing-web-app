import { API_BASE } from "./config.js";

const lockSection = document.getElementById("lock-section");
const dashboardSection = document.getElementById("dashboard-section");
const adminKeyInput = document.getElementById("adminKeyInput");
const unlockBtn = document.getElementById("unlockBtn");
const lockStatus = document.getElementById("lockStatus");
const refreshBtn = document.getElementById("refreshBtn");
const lockOutBtn = document.getElementById("lockOutBtn");
const filterRow = document.getElementById("filterRow");
const jobsList = document.getElementById("jobsList");
const jobsEmptyMsg = document.getElementById("jobsEmptyMsg");
const adminDebug = document.getElementById("adminDebug");

const SESSION_KEY = "printq_admin_key";
let currentFilter = "active";
let allJobs = [];
let autoRefreshTimer = null;

function log(msg) {
  adminDebug.textContent = msg;
}

function getKey() {
  return sessionStorage.getItem(SESSION_KEY) || "";
}

async function callAdmin(action, payload = {}) {
  const res = await fetch(`${API_BASE}/admin`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-admin-key": getKey(),
    },
    body: JSON.stringify({ action, ...payload }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

function showDashboard() {
  lockSection.classList.add("hidden");
  dashboardSection.classList.remove("hidden");
  startAutoRefresh();
}

function showLock() {
  dashboardSection.classList.add("hidden");
  lockSection.classList.remove("hidden");
  stopAutoRefresh();
}

function startAutoRefresh() {
  stopAutoRefresh();
  autoRefreshTimer = setInterval(loadJobs, 20000);
}

function stopAutoRefresh() {
  if (autoRefreshTimer) {
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  }
}

async function unlock() {
  const key = adminKeyInput.value.trim();
  if (!key) return;
  sessionStorage.setItem(SESSION_KEY, key);
  lockStatus.textContent = "Checking...";
  lockStatus.className = "status-msg";
  try {
    await callAdmin("listJobs");
    lockStatus.textContent = "";
    showDashboard();
    loadJobs();
  } catch (err) {
    sessionStorage.removeItem(SESSION_KEY);
    lockStatus.textContent = err.message === "Unauthorized" ? "Wrong admin key." : err.message;
    lockStatus.className = "status-msg err";
  }
}

function lockOut() {
  sessionStorage.removeItem(SESSION_KEY);
  showLock();
}

function specsLine(job) {
  const parts = [
    job.paper_size,
    job.orientation,
    job.duplex
      ? `duplex (front: ${job.side1_color}, back: ${job.side2_color})`
      : `single-sided (${job.side1_color})`,
    `${job.copies} copy/copies`,
    `${job.page_count} page(s)`,
  ];
  return parts.join(" · ") + ` — ₱${Number(job.line_price).toFixed(2)}`;
}

function fulfillLine(order) {
  if (order.fulfill === "delivery") {
    return `Delivery → ${order.location || "(no location given)"}`;
  }
  return "Pickup";
}

function renderJobs() {
  let jobs = allJobs;
  if (currentFilter === "active") {
    jobs = jobs.filter((j) => j.job_status === "queued" || j.job_status === "printing");
  } else if (currentFilter !== "all") {
    jobs = jobs.filter((j) => j.job_status === currentFilter);
  }

  jobsList.innerHTML = "";
  if (jobs.length === 0) {
    jobsEmptyMsg.classList.remove("hidden");
    return;
  }
  jobsEmptyMsg.classList.add("hidden");

  for (const job of jobs) {
    const order = job.orders || {};
    const card = document.createElement("div");
    card.className = "job-card";

    const top = document.createElement("div");
    top.className = "job-card-top";

    const left = document.createElement("div");
    left.innerHTML = `
      <div class="job-student">${escapeHtml(order.student_name || "Unknown")} · ${escapeHtml(order.phone || "")}</div>
      <div class="job-order-code">${escapeHtml(order.order_code || "")} · ${escapeHtml(job.file_name || "")}</div>
    `;

    const right = document.createElement("div");
    right.style.display = "flex";
    right.style.alignItems = "center";
    right.style.gap = "0.6rem";
    right.innerHTML = `
      <span class="job-queue-pos">${job.queue_position ? "#" + job.queue_position : "—"}</span>
      <span class="badge badge-${job.job_status}">${job.job_status}</span>
    `;

    top.appendChild(left);
    top.appendChild(right);

    const specs = document.createElement("div");
    specs.className = "job-specs";
    specs.textContent = specsLine(job);

    const fulfill = document.createElement("div");
    fulfill.className = "job-fulfill";
    fulfill.textContent = fulfillLine(order);

    const actions = document.createElement("div");
    actions.className = "job-actions";

    const viewBtn = document.createElement("button");
    viewBtn.type = "button";
    viewBtn.className = "btn-view";
    viewBtn.textContent = "View file";
    viewBtn.addEventListener("click", () => viewFile(job.id, viewBtn));
    actions.appendChild(viewBtn);

    if (job.job_status === "queued") {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn-advance";
      btn.textContent = "Start printing";
      btn.addEventListener("click", () => updateStatus(job.id, "printing", btn));
      actions.appendChild(btn);
    } else if (job.job_status === "printing") {
      const undoBtn = document.createElement("button");
      undoBtn.type = "button";
      undoBtn.className = "btn-undo";
      undoBtn.textContent = "Undo (back to queued)";
      undoBtn.addEventListener("click", () => updateStatus(job.id, "queued", undoBtn));
      actions.appendChild(undoBtn);

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn-done";
      btn.textContent = "Mark done";
      btn.addEventListener("click", () => updateStatus(job.id, "done", btn));
      actions.appendChild(btn);
    } else if (job.job_status === "done") {
      const undoBtn = document.createElement("button");
      undoBtn.type = "button";
      undoBtn.className = "btn-undo";
      undoBtn.textContent = "Undo (back to printing)";
      undoBtn.addEventListener("click", () => updateStatus(job.id, "printing", undoBtn));
      actions.appendChild(undoBtn);
    }

    card.appendChild(top);
    card.appendChild(specs);
    card.appendChild(fulfill);
    card.appendChild(actions);
    jobsList.appendChild(card);
  }
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c]);
}

async function loadJobs() {
  try {
    const data = await callAdmin("listJobs");
    allJobs = data.jobs || [];
    renderJobs();
    log(`Updated ${new Date().toLocaleTimeString()}`);
  } catch (err) {
    log(`Error: ${err.message}`);
    if (err.message === "Unauthorized") {
      lockOut();
    }
  }
}

async function viewFile(jobId, btn) {
  btn.disabled = true;
  try {
    const data = await callAdmin("getFileUrl", { job_id: jobId });
    window.open(data.url, "_blank", "noopener");
  } catch (err) {
    log(`Error: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
}

async function updateStatus(jobId, newStatus, btn) {
  btn.disabled = true;
  try {
    await callAdmin("updateJobStatus", { job_id: jobId, job_status: newStatus });
    await loadJobs();
  } catch (err) {
    log(`Error: ${err.message}`);
    btn.disabled = false;
  }
}

unlockBtn.addEventListener("click", unlock);
adminKeyInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") unlock();
});
refreshBtn.addEventListener("click", loadJobs);
lockOutBtn.addEventListener("click", lockOut);

filterRow.addEventListener("click", (e) => {
  const btn = e.target.closest(".filter-btn");
  if (!btn) return;
  document.querySelectorAll(".filter-btn").forEach((b) => b.classList.remove("active"));
  btn.classList.add("active");
  currentFilter = btn.dataset.filter;
  renderJobs();
});

// Auto-login if a key is already stored for this tab session
if (getKey()) {
  callAdmin("listJobs")
    .then((data) => {
      allJobs = data.jobs || [];
      showDashboard();
      renderJobs();
    })
    .catch(() => {
      sessionStorage.removeItem(SESSION_KEY);
      showLock();
    });
}
