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
const previewOverlay = document.getElementById("previewOverlay");
const previewFileName = document.getElementById("previewFileName");
const previewBody = document.getElementById("previewBody");
const previewDownloadBtn = document.getElementById("previewDownloadBtn");
const previewCloseBtn = document.getElementById("previewCloseBtn");
const pendingList = document.getElementById("pendingList");
const pendingEmptyMsg = document.getElementById("pendingEmptyMsg");
const pendingCount = document.getElementById("pendingCount");
const jobsToggleBtn = document.getElementById("jobsToggleBtn");
const pendingToggleBtn = document.getElementById("pendingToggleBtn");

// Lists longer than this collapse behind a "Show more" button.
const LIST_LIMIT = 5;
let jobsExpanded = false;
let pendingExpanded = false;
let pendingOrders = [];

function updateToggle(btn, total, expanded) {
  if (total <= LIST_LIMIT) {
    btn.classList.add("hidden");
    return;
  }
  btn.classList.remove("hidden");
  btn.textContent = expanded ? "Show less" : `Show more (${total - LIST_LIMIT} more)`;
}

const SESSION_KEY = "printq_admin_key";
const IMAGE_EXT = ["jpg", "jpeg", "png", "gif", "webp"];
let currentFilter = "active";
let allJobs = [];
let autoRefreshTimer = null;
let previewJobId = null;
let previewFileLabel = "";

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
  autoRefreshTimer = setInterval(() => {
    loadJobs();
    loadPendingOrders();
  }, 20000);
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
    adminKeyInput.value = ""; // don't leave the key sitting in the field
    showDashboard();
    loadJobs();
    loadPendingOrders();
  } catch (err) {
    sessionStorage.removeItem(SESSION_KEY);
    lockStatus.textContent = err.message === "Unauthorized" ? "Wrong admin key." : err.message;
    lockStatus.className = "status-msg err";
  }
}

function lockOut() {
  sessionStorage.removeItem(SESSION_KEY);
  adminKeyInput.value = "";
  lockStatus.textContent = "";
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
    jobsToggleBtn.classList.add("hidden");
    return;
  }
  jobsEmptyMsg.classList.add("hidden");
  updateToggle(jobsToggleBtn, jobs.length, jobsExpanded);
  const visibleJobs = jobsExpanded ? jobs : jobs.slice(0, LIST_LIMIT);

  for (const job of visibleJobs) {
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
    viewBtn.addEventListener("click", () => openPreview(job.id, job.file_name, viewBtn));
    actions.appendChild(viewBtn);

    const downloadBtn = document.createElement("button");
    downloadBtn.type = "button";
    downloadBtn.className = "btn-download";
    downloadBtn.textContent = "Download";
    downloadBtn.addEventListener("click", () => downloadFile(job.id, job.file_name, downloadBtn));
    actions.appendChild(downloadBtn);

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

function renderPendingOrders(orders) {
  pendingOrders = orders;
  pendingList.innerHTML = "";

  if (!orders.length) {
    pendingEmptyMsg.classList.remove("hidden");
    pendingCount.classList.add("hidden");
    pendingToggleBtn.classList.add("hidden");
    return;
  }
  pendingEmptyMsg.classList.add("hidden");
  pendingCount.textContent = String(orders.length);
  pendingCount.classList.remove("hidden");
  updateToggle(pendingToggleBtn, orders.length, pendingExpanded);
  const visibleOrders = pendingExpanded ? orders : orders.slice(0, LIST_LIMIT);

  for (const order of visibleOrders) {
    const itemCount = order.print_jobs?.length ?? 0;
    const card = document.createElement("div");
    card.className = "pending-card";

    const main = document.createElement("div");
    main.className = "pending-card-main";
    main.innerHTML = `
      <div class="pending-order-code">${escapeHtml(order.order_code)} — ₱${Number(order.total_amount).toFixed(2)}</div>
      <div class="pending-meta">${escapeHtml(order.student_name)} · ${escapeHtml(order.phone)} · ${itemCount} item(s) · ${escapeHtml(fulfillLine(order))}</div>
    `;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn-simulate";
    btn.textContent = "Confirm Cash Received";
    btn.addEventListener("click", () => confirmCash(order.order_code, btn));

    card.appendChild(main);
    card.appendChild(btn);
    pendingList.appendChild(card);
  }
}

async function loadPendingOrders() {
  try {
    const data = await callAdmin("listPendingOrders");
    renderPendingOrders(data.orders || []);
  } catch (err) {
    log(`Error loading pending payments: ${err.message}`);
  }
}

async function confirmCash(orderCode, btn) {
  btn.disabled = true;
  const originalText = btn.textContent;
  btn.textContent = "Confirming...";
  try {
    const data = await callAdmin("confirmCashPayment", { order_code: orderCode });
    log(data.message || `Cash confirmed for ${orderCode}`);
    loadPendingOrders();
    loadJobs();
  } catch (err) {
    log(`Error: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

function fileExt(fileName) {
  const dot = (fileName || "").lastIndexOf(".");
  return dot === -1 ? "" : fileName.slice(dot + 1).toLowerCase();
}

// Shared by the modal's Download button and the quick Download button on
// each card: fetches the signed URL as a blob so we can force a save-as-file
// with the correct filename, instead of relying on the browser's own inline
// viewer (which varies by file type and by browser).
async function downloadBlob(url, fileName) {
  const fileRes = await fetch(url);
  if (!fileRes.ok) throw new Error("Could not download the file");
  const blob = await fileRes.blob();
  const blobUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = blobUrl;
  a.download = fileName || "file";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(blobUrl);
}

async function downloadFile(jobId, fileName, btn) {
  btn.disabled = true;
  const originalText = btn.textContent;
  btn.textContent = "Downloading...";
  try {
    const data = await callAdmin("getFileUrl", { job_id: jobId });
    await downloadBlob(data.url, fileName);
  } catch (err) {
    log(`Error: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

// Opens the in-dashboard preview panel first (like Google Drive's file
// preview page) — download only happens as a deliberate second step from
// inside it, never as the first click.
async function openPreview(jobId, fileName, btn) {
  previewJobId = jobId;
  previewFileLabel = fileName || "file";
  previewFileName.textContent = previewFileLabel;
  previewBody.innerHTML = `<p class="preview-unavailable">Loading preview…</p>`;
  previewOverlay.classList.remove("hidden");

  btn.disabled = true;
  try {
    const data = await callAdmin("getFileUrl", { job_id: jobId });
    const ext = fileExt(fileName);

    if (IMAGE_EXT.includes(ext)) {
      previewBody.innerHTML = "";
      const img = document.createElement("img");
      img.src = data.url;
      img.alt = fileName;
      previewBody.appendChild(img);
    } else if (ext === "pdf") {
      previewBody.innerHTML = "";
      const iframe = document.createElement("iframe");
      iframe.src = data.url;
      iframe.title = fileName;
      previewBody.appendChild(iframe);
    } else {
      previewBody.innerHTML = `
        <p class="preview-unavailable">
          No inline preview is available for this file type (.${escapeHtml(ext || "?")}).<br />
          Browsers can't render Word documents directly — use Download below to open it
          in its own app.
        </p>
      `;
    }
  } catch (err) {
    previewBody.innerHTML = `<p class="preview-unavailable">Error: ${escapeHtml(err.message)}</p>`;
  } finally {
    btn.disabled = false;
  }
}

function closePreview() {
  previewOverlay.classList.add("hidden");
  previewBody.innerHTML = "";
  previewJobId = null;
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
refreshBtn.addEventListener("click", () => {
  loadJobs();
  loadPendingOrders();
});
lockOutBtn.addEventListener("click", lockOut);

previewCloseBtn.addEventListener("click", closePreview);
previewOverlay.addEventListener("click", (e) => {
  if (e.target === previewOverlay) closePreview();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !previewOverlay.classList.contains("hidden")) closePreview();
});
previewDownloadBtn.addEventListener("click", async () => {
  if (!previewJobId) return;
  previewDownloadBtn.disabled = true;
  const originalText = previewDownloadBtn.textContent;
  previewDownloadBtn.textContent = "Downloading...";
  try {
    const data = await callAdmin("getFileUrl", { job_id: previewJobId });
    await downloadBlob(data.url, previewFileLabel);
  } catch (err) {
    log(`Error: ${err.message}`);
  } finally {
    previewDownloadBtn.disabled = false;
    previewDownloadBtn.textContent = originalText;
  }
});

filterRow.addEventListener("click", (e) => {
  const btn = e.target.closest(".filter-btn");
  if (!btn) return;
  document.querySelectorAll(".filter-btn").forEach((b) => b.classList.remove("active"));
  btn.classList.add("active");
  currentFilter = btn.dataset.filter;
  jobsExpanded = false;
  renderJobs();
});

jobsToggleBtn.addEventListener("click", () => {
  jobsExpanded = !jobsExpanded;
  renderJobs();
});

pendingToggleBtn.addEventListener("click", () => {
  pendingExpanded = !pendingExpanded;
  renderPendingOrders(pendingOrders);
});

// Auto-login if a key is already stored for this tab session
if (getKey()) {
  callAdmin("listJobs")
    .then((data) => {
      allJobs = data.jobs || [];
      showDashboard();
      renderJobs();
      loadPendingOrders();
    })
    .catch(() => {
      sessionStorage.removeItem(SESSION_KEY);
      showLock();
    });
}
