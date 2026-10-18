import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import QRCode from "https://esm.sh/qrcode@1.5.3";
import { SUPABASE_URL, SUPABASE_ANON_KEY, API_BASE, STORAGE_BUCKET } from "./config.js";

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ---------------------------------------------------------------
// Pricing preview (client-side only, for UX). The server recomputes
// this authoritatively in createCheckout — the client's number is
// never trusted for the actual charge.
// ---------------------------------------------------------------
const BW_RATE = 5;
const COLOR_RATE = 10;
const SIZE_SURCHARGE = { A4: 0, Letter: 0, Legal: 2, A3: 5 };
const DELIVERY_FEE = 20;

function calcLinePrice({ pages, copies, duplex, side1, side2, paperSize }) {
  const sheets = duplex ? Math.ceil(pages / 2) : pages;
  let ratePerSheet;
  if (!duplex || side1 === side2) {
    ratePerSheet = side1 === "color" ? COLOR_RATE : BW_RATE;
  } else {
    ratePerSheet = BW_RATE + COLOR_RATE;
  }
  const surcharge = SIZE_SURCHARGE[paperSize] ?? 0;
  return sheets * copies * (ratePerSheet + surcharge);
}

// ---------------------------------------------------------------
// Elements
// ---------------------------------------------------------------
const itemFile = document.getElementById("itemFile");
const itemPages = document.getElementById("itemPages");
const itemCopies = document.getElementById("itemCopies");
const itemPaperSize = document.getElementById("itemPaperSize");
const itemDuplex = document.getElementById("itemDuplex");
const side1Row = document.getElementById("side1Row");
const side2Row = document.getElementById("side2Row");
const itemPricePreview = document.getElementById("itemPricePreview");
const addItemBtn = document.getElementById("addItemBtn");

const cartList = document.getElementById("cartList");
const cartEmptyMsg = document.getElementById("cartEmptyMsg");
const cartTotal = document.getElementById("cartTotal");

const nameInput = document.getElementById("name");
const phoneInput = document.getElementById("phone");
const locationRow = document.getElementById("locationRow");
const locationInput = document.getElementById("location");
const checkoutBtn = document.getElementById("checkoutBtn");
const checkoutStatus = document.getElementById("checkoutStatus");

const checkStatusBtn = document.getElementById("checkStatusBtn");
const statusPrintId = document.getElementById("statusPrintId");
const statusResult = document.getElementById("statusResult");

const debugOutput = document.getElementById("debugOutput");
const returnBanner = document.getElementById("returnBanner");

const qrOverlay = document.getElementById("qrOverlay");
const qrOrderCode = document.getElementById("qrOrderCode");
const qrAmount = document.getElementById("qrAmount");
const qrCanvas = document.getElementById("qrCanvas");
const qrWaiting = document.getElementById("qrWaiting");
const qrCloseBtn = document.getElementById("qrCloseBtn");
const qrDownloadBtn = document.getElementById("qrDownloadBtn");
const qrOpenAppBtn = document.getElementById("qrOpenAppBtn");
const qrWalletPicker = document.getElementById("qrWalletPicker");
const qrShareBtn = document.getElementById("qrShareBtn");
const qrPickerMsg = document.getElementById("qrPickerMsg");

// Custom-scheme app links only make sense on a phone/tablet. On a PC they
// would do nothing (or show a confusing browser prompt), so desktop users
// only get the Download button plus a hint.
const IS_MOBILE =
  /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const IS_ANDROID = /Android/i.test(navigator.userAgent);

// gcash:// is documented by PayMongo's GCash deep-link guide. The Maya
// scheme/package are best-effort (not officially documented).
const WALLETS = {
  // GCash's app doesn't answer a bare gcash:// intent on Android (that sent
  // testers to the Play Store even with the app installed), so on Android we
  // launch it by package name instead. Maya's paymaya:// scheme works.
  gcash: { name: "GCash", scheme: "gcash", pkg: "com.globe.gcash.android", launchByPackage: true },
  maya: { name: "Maya", scheme: "paymaya", pkg: "com.paymaya" },
};

let pollTimer = null;

function log(msg) {
  debugOutput.textContent += (debugOutput.textContent ? "\n" : "") + msg;
}

function getSelectedValue(name) {
  const el = document.querySelector(`input[name="${name}"]:checked`);
  return el ? el.value : null;
}

// ---------------------------------------------------------------
// Cart state (in memory — cleared on page reload)
// ---------------------------------------------------------------
let cart = [];
let nextCartId = 1;

function readItemForm() {
  const file = itemFile.files[0];
  const pages = Number(itemPages.value);
  const copies = Number(itemCopies.value);
  const paperSize = itemPaperSize.value;
  const orientation = getSelectedValue("orientation");
  const duplex = itemDuplex.checked;
  const side1 = getSelectedValue("side1");
  const side2 = duplex ? getSelectedValue("side2") : null;

  if (!file || !pages || pages <= 0 || !copies || copies <= 0 || !orientation || !side1) {
    return null;
  }
  if (duplex && !side2) return null;

  return { file, pages, copies, paperSize, orientation, duplex, side1, side2 };
}

function updateItemPricePreview() {
  const values = readItemForm();
  if (!values) {
    itemPricePreview.textContent = "";
    return;
  }
  const price = calcLinePrice(values);
  itemPricePreview.textContent = `Estimated: ₱${price}`;
}

[itemPages, itemCopies, itemPaperSize, itemDuplex].forEach((el) =>
  el.addEventListener("input", updateItemPricePreview)
);
document.querySelectorAll('input[name="orientation"], input[name="side1"], input[name="side2"]').forEach((el) =>
  el.addEventListener("change", updateItemPricePreview)
);

itemDuplex.addEventListener("change", () => {
  side2Row.classList.toggle("hidden", !itemDuplex.checked);
  document.getElementById("side1Label").textContent = itemDuplex.checked ? "Front side color:" : "Color:";
  updateItemPricePreview();
});

document.querySelectorAll('input[name="fulfill"]').forEach((r) => {
  r.addEventListener("change", () => {
    const v = getSelectedValue("fulfill");
    if (v === "delivery") {
      locationRow.classList.remove("hidden");
      locationInput.required = true;
    } else {
      locationRow.classList.add("hidden");
      locationInput.required = false;
      locationInput.value = "";
    }
  });
});

function renderCart() {
  cartList.innerHTML = "";

  if (cart.length === 0) {
    cartEmptyMsg.classList.remove("hidden");
    cartTotal.classList.add("hidden");
    checkoutBtn.disabled = true;
    return;
  }

  cartEmptyMsg.classList.add("hidden");
  cartTotal.classList.remove("hidden");

  let subtotal = 0;
  for (const item of cart) {
    subtotal += item.price;

    const li = document.createElement("li");
    li.className = "cart-item";

    const colorLabel = item.duplex
      ? item.side1 === item.side2
        ? `Duplex (${item.side1 === "color" ? "Colored" : "B&W"} both sides)`
        : `Duplex (Front ${item.side1 === "color" ? "Color" : "B&W"} / Back ${item.side2 === "color" ? "Color" : "B&W"})`
      : item.side1 === "color"
      ? "Colored"
      : "Black & White";

    li.innerHTML = `
      <div class="cart-item-main">
        <span class="cart-item-file">${escapeHtml(item.file.name)}</span>
        <span class="cart-item-specs">${item.paperSize} · ${item.orientation} · ${colorLabel} · ${item.pages} pg × ${item.copies} copies</span>
      </div>
      <div style="display:flex; flex-direction:column; align-items:flex-end; gap:4px;">
        <span class="cart-item-price">₱${item.price}</span>
        <button type="button" class="cart-item-remove" data-id="${item.id}" aria-label="Remove">✕ remove</button>
      </div>
    `;
    cartList.appendChild(li);
  }

  const fulfill = getSelectedValue("fulfill");
  const deliveryNote = fulfill === "delivery" ? ` + ₱${DELIVERY_FEE} delivery` : "";
  const grandTotal = subtotal + (fulfill === "delivery" ? DELIVERY_FEE : 0);
  cartTotal.textContent = `Total: ₱${grandTotal}${deliveryNote ? ` (₱${subtotal}${deliveryNote})` : ""}`;
  checkoutBtn.disabled = false;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

cartList.addEventListener("click", (e) => {
  const btn = e.target.closest(".cart-item-remove");
  if (!btn) return;
  const id = Number(btn.dataset.id);
  cart = cart.filter((item) => item.id !== id);
  renderCart();
});

document.querySelectorAll('input[name="fulfill"]').forEach((r) => r.addEventListener("change", renderCart));

addItemBtn.addEventListener("click", () => {
  const values = readItemForm();
  if (!values) {
    alert("Please complete all fields for this print job before adding it to the cart.");
    return;
  }

  const price = calcLinePrice(values);
  cart.push({
    id: nextCartId++,
    file: values.file,
    pages: values.pages,
    copies: values.copies,
    paperSize: values.paperSize,
    orientation: values.orientation,
    duplex: values.duplex,
    side1: values.side1,
    side2: values.side2,
    price,
  });

  renderCart();

  // Reset the item form for the next job
  itemFile.value = "";
  itemPages.value = "";
  itemCopies.value = "1";
  itemDuplex.checked = false;
  side2Row.classList.add("hidden");
  document.getElementById("side1Label").textContent = "Color:";
  itemPricePreview.textContent = "";
});

// ---------------------------------------------------------------
// Checkout: upload every cart file, then call createCheckout once
// ---------------------------------------------------------------
checkoutBtn.addEventListener("click", async () => {
  const name = nameInput.value.trim();
  const phone = phoneInput.value.trim();
  const fulfill = getSelectedValue("fulfill");
  const location = locationInput.value.trim();

  if (!name || !phone || !fulfill) {
    setCheckoutStatus("Please fill in your name, phone, and fulfillment method.", "err");
    return;
  }
  if (fulfill === "delivery" && !location) {
    setCheckoutStatus("Please enter a delivery location.", "err");
    return;
  }
  if (cart.length === 0) {
    setCheckoutStatus("Your cart is empty.", "err");
    return;
  }

  checkoutBtn.disabled = true;
  setCheckoutStatus("Uploading files...", "");

  try {
    const items = [];
    for (const cartItem of cart) {
      const safeName = cartItem.file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      const path = `${Date.now()}-${cartItem.id}-${safeName}`;

      const { error: uploadErr } = await supabase.storage
        .from(STORAGE_BUCKET)
        .upload(path, cartItem.file, { contentType: cartItem.file.type || "application/octet-stream" });

      if (uploadErr) {
        throw new Error(`Failed to upload ${cartItem.file.name}: ${uploadErr.message}`);
      }

      items.push({
        file_path: path,
        file_name: cartItem.file.name,
        page_count: cartItem.pages,
        paper_size: cartItem.paperSize,
        orientation: cartItem.orientation,
        duplex: cartItem.duplex,
        side1_color: cartItem.side1,
        side2_color: cartItem.duplex ? cartItem.side2 : null,
        copies: cartItem.copies,
      });
    }

    setCheckoutStatus("Creating your order...", "");
    log(`Calling createCheckout with ${items.length} item(s)...`);

    const res = await fetch(`${API_BASE}/createCheckout`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_ANON_KEY,
        Authorization: "Bearer " + SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ student_name: name, phone, fulfill, location: fulfill === "delivery" ? location : undefined, items }),
    });

    const text = await res.text();
    log(`createCheckout response (${res.status}): ${text}`);

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error("Server returned an invalid response.");
    }

    if (!res.ok) {
      throw new Error(data.error || "Failed to create checkout.");
    }
    if (!data.qr_string) {
      throw new Error("No QR code returned.");
    }

    setCheckoutStatus(`Order ${data.order_code} created.`, "ok");
    await showPaymentQr(data.order_code, data.total_amount, data.qr_string);
  } catch (err) {
    setCheckoutStatus(err.message || "Something went wrong.", "err");
  } finally {
    checkoutBtn.disabled = false;
  }
});

// ---------------------------------------------------------------
// QR payment modal: render the Xendit QR Ph string as a scannable
// QR code, then poll getOrderStatus every few seconds until the
// webhook flips payment_stat away from "pending".
// ---------------------------------------------------------------
async function showPaymentQr(orderCode, totalAmount, qrString) {
  qrOrderCode.textContent = orderCode;
  qrAmount.textContent = `Amount: ₱${Number(totalAmount).toFixed(2)}`;
  qrWaiting.textContent = "Waiting for payment confirmation…";
  qrWaiting.className = "status-msg";
  qrOverlay.classList.remove("hidden");
  resetQrActions();

  try {
    await QRCode.toCanvas(qrCanvas, qrString, { width: 220, margin: 1 });
  } catch (err) {
    log(`QR render error: ${err.message}`);
  }

  stopPolling();
  pollTimer = setInterval(() => pollPaymentStatus(orderCode), 3000);
  pollPaymentStatus(orderCode); // check immediately too
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function pollPaymentStatus(orderCode) {
  try {
    const res = await fetch(`${API_BASE}/getOrderStatus`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_ANON_KEY,
        Authorization: "Bearer " + SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ order_code: orderCode }),
    });
    const data = await res.json();
    if (!res.ok) return;

    if (data.payment_stat === "confirmed") {
      stopPolling();
      qrWaiting.textContent = "Payment confirmed! Closing in a moment…";
      qrWaiting.className = "status-msg ok";
      setTimeout(() => {
        qrOverlay.classList.add("hidden");
        statusPrintId.value = orderCode;
        checkOrderStatus(orderCode);
        resetCartAfterOrder();
      }, 1500);
    } else if (data.payment_stat === "failed") {
      stopPolling();
      qrWaiting.textContent = "Payment failed. You can close this and try again.";
      qrWaiting.className = "status-msg err";
    }
    // "pending" — keep polling silently
  } catch (err) {
    log(`Status poll error: ${err.message}`);
  }
}

qrCloseBtn.addEventListener("click", () => {
  stopPolling();
  qrOverlay.classList.add("hidden");
});

function resetCartAfterOrder() {
  cart = [];
  renderCart();
  setCheckoutStatus("", "");
}

function setCheckoutStatus(msg, kind) {
  checkoutStatus.textContent = msg;
  checkoutStatus.className = "status-msg" + (kind ? " " + kind : "");
}

// ---------------------------------------------------------------
// Status checker — calls the getOrderStatus Edge Function
// ---------------------------------------------------------------
checkStatusBtn.addEventListener("click", () => checkOrderStatus(statusPrintId.value.trim()));

async function checkOrderStatus(pid) {
  if (!pid) {
    statusResult.innerHTML = `<p class="status-msg err">Enter a Print ID.</p>`;
    return;
  }

  statusResult.innerHTML = `<p class="status-msg">Checking...</p>`;

  try {
    const res = await fetch(`${API_BASE}/getOrderStatus`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_ANON_KEY,
        Authorization: "Bearer " + SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ order_code: pid }),
    });
    const data = await res.json();

    if (!res.ok) {
      statusResult.innerHTML = `<p class="status-msg err">${escapeHtml(data.error || "Order not found.")}</p>`;
      return;
    }

    const paymentBadge = `<span class="badge badge-${data.payment_stat}">${data.payment_stat}</span>`;
    const itemsHtml = (data.items || [])
      .map((job) => {
        const colorLabel = job.duplex
          ? job.side1_color === job.side2_color
            ? `Duplex (${job.side1_color === "color" ? "Colored" : "B&W"})`
            : `Duplex (Front ${job.side1_color === "color" ? "Color" : "B&W"} / Back ${job.side2_color === "color" ? "Color" : "B&W"})`
          : job.side1_color === "color"
          ? "Colored"
          : "Black & White";
        const posText = job.queue_position != null ? `#${job.queue_position} in queue` : "—";
        return `
          <div class="order-job">
            <span>${escapeHtml(job.file_name)}<br><small>${job.paper_size} · ${colorLabel} · ${job.copies}x — ₱${job.line_price}</small></span>
            <span><span class="badge badge-${job.job_status}">${job.job_status.replace("_", " ")}</span><br><small>${posText}</small></span>
          </div>
        `;
      })
      .join("");

    statusResult.innerHTML = `
      <div class="order-summary">
        <div class="order-summary-head">
          <strong>${escapeHtml(data.order_code)}</strong>
          ${paymentBadge}
        </div>
        <div>Fulfillment: ${data.fulfill} · Total: ₱${data.total_amount}</div>
        ${itemsHtml}
      </div>
    `;
  } catch (err) {
    statusResult.innerHTML = `<p class="status-msg err">${escapeHtml(err.message || "Something went wrong.")}</p>`;
  }
}

// ---------------------------------------------------------------
// Handle coming back from the Xendit checkout page. createCheckout
// sets the redirect to "?order=ORD-xxxx&status=success|failed", so
// pick that up here and show the order instead of leaving the
// student stranded with no confirmation of what happened.
// ---------------------------------------------------------------
function handleReturnFromPayment() {
  const params = new URLSearchParams(window.location.search);
  const orderCode = params.get("order");
  const status = params.get("status");
  if (!orderCode) return;

  statusPrintId.value = orderCode;

  returnBanner.classList.remove("hidden", "success", "failure");
  if (status === "success") {
    returnBanner.classList.add("success");
    returnBanner.innerHTML = `<strong>Payment received — Print ID: ${escapeHtml(orderCode)}</strong>Keep this ID to check your print status any time. Checking its status now — if it still shows "pending" for a moment, click "Check Status" again in a few seconds.`;
    checkOrderStatus(orderCode);
  } else {
    returnBanner.classList.add("failure");
    returnBanner.innerHTML = `<strong>Payment not completed — Print ID: ${escapeHtml(orderCode)}</strong>Your cart items were saved under this order, but payment didn't go through. You can check its status below, or place a new order.`;
  }

  // Clean the URL so refreshing the page doesn't re-show this banner
  window.history.replaceState({}, document.title, window.location.pathname);
}

renderCart();
handleReturnFromPayment();


// ---------------------------------------------------------------
// QR modal extras: download the QR, and (on phones) open an e-wallet
// app without leaving/closing this page. We can't pass the QR into the
// wallet app, so the flow is: Download QR -> Open app -> Scan QR ->
// upload from gallery. Polling keeps running in the background and we
// re-poll the moment the student comes back to this tab.
// ---------------------------------------------------------------
function resetQrActions() {
  qrWalletPicker.classList.add("hidden");
  qrPickerMsg.textContent = "";
  qrOpenAppBtn.classList.toggle("hidden", !IS_MOBILE);
}

function canvasToBlob() {
  return new Promise((resolve) => qrCanvas.toBlob(resolve, "image/png"));
}

qrDownloadBtn.addEventListener("click", async () => {
  const blob = await canvasToBlob();
  if (!blob) return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${qrOrderCode.textContent || "payment"}-qr.png`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

qrOpenAppBtn.addEventListener("click", async () => {
  qrWalletPicker.classList.toggle("hidden");
  // Offer the OS share sheet (lists every installed app) when supported.
  try {
    const blob = await canvasToBlob();
    const file = new File([blob], "payment-qr.png", { type: "image/png" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      qrShareBtn.classList.remove("hidden");
    }
  } catch { /* share not available */ }
});

qrWalletPicker.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-wallet]");
  if (!btn) return;
  const w = WALLETS[btn.dataset.wallet];
  if (!w) return;

  if (IS_ANDROID) {
    // No Play Store fallback for GCash: Chrome sends people to the store
    // whenever the intent can't be matched, even if the app IS installed,
    // which is misleading. We show a "open it manually" message instead.
    const fallback = encodeURIComponent(`https://play.google.com/store/apps/details?id=${w.pkg}`);
    window.location.href = w.launchByPackage
      ? `intent:#Intent;action=android.intent.action.MAIN;category=android.intent.category.LAUNCHER;package=${w.pkg};end`
      : `intent://#Intent;scheme=${w.scheme};package=${w.pkg};S.browser_fallback_url=${fallback};end`;
  } else {
    window.location.href = `${w.scheme}://`;
  }

  // If we're still visible shortly after, the app probably isn't installed.
  setTimeout(() => {
    if (document.visibilityState === "visible") {
      qrPickerMsg.textContent = `Couldn't open ${w.name}. Open it manually and upload the downloaded QR.`;
    }
  }, 2000);
});

qrShareBtn.addEventListener("click", async () => {
  try {
    const blob = await canvasToBlob();
    const file = new File([blob], `${qrOrderCode.textContent || "payment"}-qr.png`, { type: "image/png" });
    await navigator.share({ files: [file], title: "Payment QR" });
  } catch { /* user cancelled or unsupported */ }
});

// Coming back from a wallet app: check payment right away instead of
// waiting for the next 3-second tick (browsers throttle background timers).
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && pollTimer && qrOrderCode.textContent) {
    pollPaymentStatus(qrOrderCode.textContent);
  }
});
