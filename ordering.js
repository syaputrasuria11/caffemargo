/* ordering.js — pemesanan di menu Caffe Margo, dikirim ke BACKEND `caffemargo-backend`.
   Alur: pilih menu → "Tambah Pesan" → +/- → "Pesan" → Pilihan Ice/Hot + Nama WAJIB + Catatan opsional
   → metode (Cash/QRIS/Transfer) → order dikirim ke server + database.

   - Total & `paid` ditentukan SERVER. 
   - Order masuk kasir; pembayaran dikonfirmasi admin kasir (`PATCH /paid`). 
   - Cash auto-paid; QRIS/Transfer pending. 
   - QRIS: hanya barcode QRIS; tidak ada tombol scan; info pembayaran dihilangkan saat kasir konfirmasi. 
   - Transfer: DANA/GoPay/BRI + nomor. 
   - Menggantikan `shared/orders.js` localStorage; memakai `shared/api.js`. */
(function () {
  "use strict";

  if (!window.CaffeAPI) { console.warn("CaffeAPI tidak tersedia."); return; }
  var API = window.CaffeAPI;

  var TRANSFER_OPTIONS = [
    { id: "dana",  label: "DANA",          type: "E-wallet", number: "081376944172",    name: "caffemargo" },
    { id: "gopay", label: "GoPay",         type: "E-wallet", number: "081376944172",    name: "caffemargo" },
    { id: "bri",   label: "BRI (rekening)", type: "Bank BRI", number: "753501034929539", name: "caffemargo" }
  ];

  var fmt = API.formatIDR;
  var cart = {};
  var panel, listEl, totalEl, countEl, nameInput, noteInput, payBtn, toastEl, fab;
  var payFieldset, transferSub, payView, payTitle, payBody, payQr, ordTempField;
  var currentOrder = null, pendingOrderId = null, pollTimer = null;

  /* ---------- menu cards ---------- */
  function enhanceCards() {
    document.querySelectorAll(".menu-card").forEach(function (card) {
      if (card.querySelector(".order-controls")) return;
      var nameEl = card.querySelector("h3");
      var priceEl = card.querySelector(".price");
      if (!nameEl || !priceEl) return;
      var name = nameEl.textContent.trim();
      var price = parsePrice(priceEl.textContent);
      var id = slug(name);
      card.setAttribute("data-order-id", id);
      card.setAttribute("data-order-name", name);
      card.setAttribute("data-order-price", String(price));

      var wrap = document.createElement("div");
      wrap.className = "order-controls";
      wrap.innerHTML =
        '<button type="button" class="ord-add">Tambah Pesan</button>' +
        '<div class="ord-stepper" hidden>' +
          '<button type="button" class="ord-btn ord-minus" aria-label="Kurangi ' + escapeAttr(name) + '">−</button>' +
          '<span class="ord-qty" aria-live="polite">0</span>' +
          '<button type="button" class="ord-btn ord-plus" aria-label="Tambah jumlah ' + escapeAttr(name) + '">+</button>' +
        '</div>';
      card.appendChild(wrap);
      wrap.querySelector(".ord-add").addEventListener("click", function () { bump(id, name, price, +1, card); });
      wrap.querySelector(".ord-plus").addEventListener("click", function () { bump(id, name, price, +1, card); });
      wrap.querySelector(".ord-minus").addEventListener("click", function () { bump(id, name, price, -1, card); });
    });
  }

  function bump(id, name, price, delta, card) {
    var item = cart[id] || { id: id, name: name, price: price, qty: 0 };
    item.qty = Math.max(0, item.qty + delta);
    if (item.qty === 0) { delete cart[id]; } else { cart[id] = item; }
    var qtyEl = card.querySelector(".ord-qty");
    var stepper = card.querySelector(".ord-stepper");
    if (qtyEl) qtyEl.textContent = String(item.qty);
    if (stepper) stepper.hidden = item.qty === 0;
    render();
  }

  /* ---------- panel ---------- */
  function transferSubHtml() {
    return TRANSFER_OPTIONS.map(function (o, i) {
      return '<label class="ord-pay-opt ord-transfer-opt"><input type="radio" name="ord-transfer" value="' + o.id + '"' + (i === 0 ? " checked" : "") + "> " +
        escapeHtml(o.label) + ' <span class="ord-transfer-num">' + escapeHtml(o.number) + "</span></label>";
    }).join("");
  }

  function buildPanel() {
    panel = document.createElement("div");
    panel.className = "ord-panel"; panel.hidden = true;
    panel.setAttribute("role", "dialog"); panel.setAttribute("aria-label", "Pesanan & pembayaran");
    panel.innerHTML =
      '<div class="ord-panel-head"><h3>Pesanan Anda</h3><button type="button" class="ord-close" aria-label="Tutup">✕</button></div>' +
      '<div class="ord-list" id="ord-list"></div>' +
      '<div class="ord-empty" id="ord-empty">Belum ada item. Tambahkan dari menu.</div>' +
      '<div class="ord-total-row"><span>Total</span><strong id="ord-total">Rp 0</strong></div>' +
      /* pilihan suhu minuman (di atas Nama) */
      '<fieldset class="ord-pay-field ord-temp-field"><legend>Pilihan suhu</legend>' +
        '<div class="ord-pay-options ord-temp" role="radiogroup" aria-label="Pilihan Ice atau Hot">' +
          '<label class="ord-pay-opt"><input type="radio" name="ord-temp" value="hot" checked> Hot</label>' +
          '<label class="ord-pay-opt"><input type="radio" name="ord-temp" value="iced"> Ice</label>' +
        '</div></fieldset>' +
      /* Nama WAJIB; hanya Catatan opsional */
      '<label class="ord-field"><span>Nama</span><input type="text" id="ord-name" placeholder="Nama Anda" required aria-required="true"></label>' +
      '<p class="ord-name-error" id="ord-name-error" role="alert" hidden>Nama wajib diisi.</p>' +
      '<label class="ord-field"><span>Catatan (opsional)</span><input type="text" id="ord-note" placeholder="mis. tanpa gula"></label>' +
      '<fieldset class="ord-pay-field" id="ord-pay-field"><legend>Metode pembayaran</legend>' +
        '<div class="ord-pay-options" role="radiogroup" aria-label="Metode pembayaran">' +
          '<label class="ord-pay-opt"><input type="radio" name="ord-method" value="cash" checked> Cash</label>' +
          '<label class="ord-pay-opt"><input type="radio" name="ord-method" value="qris"> QRIS</label>' +
          '<label class="ord-pay-opt"><input type="radio" name="ord-method" value="transfer"> Transfer</label>' +
        '</div></fieldset>' +
      '<fieldset class="ord-pay-field ord-transfer-sub" id="ord-transfer-sub" hidden><legend>Transfer ke</legend>' +
        '<div class="ord-pay-options ord-transfer-options" role="radiogroup" aria-label="Metode transfer">' + transferSubHtml() + '</div></fieldset>' +
      '<div class="ord-payview" id="ord-payview" hidden>' +
        '<div class="ord-pay-title" id="ord-pay-title"></div>' +
        '<div class="ord-qr" id="ord-qr"></div>' +
        '<div class="ord-pay-body" id="ord-pay-body"></div></div>' +
      '<button type="button" class="ord-pay" id="ord-pay">Pesan</button>' +
      '<p class="ord-hint">Order masuk ke kasir dengan status <strong>belum bayar</strong>. Admin kasir menekan <strong>Konfirmasi sudah bayar</strong> setelah pembayaran. (Total & status bayar ditentukan server.)</p>';
    document.body.appendChild(panel);

    listEl = panel.querySelector("#ord-list");
    totalEl = panel.querySelector("#ord-total");
    nameInput = panel.querySelector("#ord-name");
    noteInput = panel.querySelector("#ord-note");
    payBtn = panel.querySelector("#ord-pay");
    payFieldset = panel.querySelector("#ord-pay-field");
    transferSub = panel.querySelector("#ord-transfer-sub");
    payView = panel.querySelector("#ord-payview");
    payTitle = panel.querySelector("#ord-pay-title");
    payBody = panel.querySelector("#ord-pay-body");
    payQr = panel.querySelector("#ord-qr");
    ordTempField = panel.querySelector(".ord-temp-field");

    panel.querySelector(".ord-close").addEventListener("click", closePanel);
    payBtn.addEventListener("click", confirmOrder);
    panel.addEventListener("change", function (e) {
      if (e.target && e.target.name === "ord-method") transferSub.hidden = e.target.value !== "transfer";
    });

    fab = document.createElement("button");
    fab.type = "button"; fab.className = "ord-fab"; fab.setAttribute("aria-label", "Pesan");
    fab.innerHTML = '<span class="ord-fab-label">Pesan</span><span class="ord-fab-count" id="ord-count">0</span><span class="ord-fab-total" id="ord-fab-total">Rp 0</span>';
    document.body.appendChild(fab);
    countEl = fab.querySelector("#ord-count");
    fab.addEventListener("click", togglePanel);

    toastEl = document.createElement("div"); toastEl.className = "ord-toast"; toastEl.hidden = true; document.body.appendChild(toastEl);
  }

  function togglePanel() { panel.hidden ? openPanel() : closePanel(); }
  function openPanel() { resetPayView(); render(); panel.hidden = false; }
  function closePanel() { panel.hidden = true; }

  function render() {
    var items = Object.keys(cart).map(function (k) { return cart[k]; });
    var totalQty = 0, total = 0; listEl.innerHTML = "";
    items.forEach(function (it) {
      totalQty += it.qty; total += it.qty * it.price;
      var row = document.createElement("div"); row.className = "ord-row";
      row.innerHTML = '<div class="ord-row-info"><strong>' + escapeHtml(it.name) + '</strong><span>' + fmt(it.price) + ' × ' + it.qty + '</span></div><div class="ord-row-price">' + fmt(it.price * it.qty) + '</div>';
      listEl.appendChild(row);
    });
    panel.querySelector("#ord-empty").hidden = items.length > 0;
    totalEl.textContent = fmt(total);
    countEl.textContent = String(totalQty);
    fab.querySelector("#ord-fab-total").textContent = fmt(total);
    fab.classList.toggle("has-items", totalQty > 0);
    payBtn.disabled = items.length === 0;
  }

  function selectedMethod() { return (panel.querySelector('input[name="ord-method"]:checked') || {}).value || "cash"; }
  function selectedTransfer() { return (panel.querySelector('input[name="ord-transfer"]:checked') || {}).value || "dana"; }
  function selectedTemp() { return (panel.querySelector('input[name="ord-temp"]:checked') || {}).value || "hot"; }

  /* ---------- klik Pesan ---------- */
  async function confirmOrder() {
    var items = Object.keys(cart).map(function (k) { return cart[k]; });
    if (!items.length) return;
    var customerName = (nameInput.value || "").trim();
    var nameError = panel.querySelector("#ord-name-error");
    if (!customerName) { if (nameError) nameError.hidden = false; nameInput.setAttribute("aria-invalid", "true"); nameInput.focus(); return; }
    if (nameError) nameError.hidden = true; nameInput.removeAttribute("aria-invalid");

    var method = selectedMethod();
    var payload = {
      customer: customerName,
      note: (noteInput.value || "").trim(),
      temperature: selectedTemp(),
      payment_method: method,
      source: "caffe-margo",
      items: items.map(function (it) { return { id: it.id, name: it.name, price: it.price, qty: it.qty }; })
    };
    if (method === "transfer") {
      var subId = selectedTransfer();
      var opt = TRANSFER_OPTIONS.filter(function (o) { return o.id === subId; })[0] || TRANSFER_OPTIONS[0];
      payload.transfer_method = opt.id;
    }

    payBtn.disabled = true;
    try {
      var saved = await API.postOrder(payload);   // total & paid ditentukan SERVER
      currentOrder = saved;
      resetCart();

      if (method === "cash") {
        hidePayView(); closePanel(); showToast("Pesanan masuk ke kasir & sudah terkonfirmasi bayar.");
      } else if (method === "qris") {
        showQris(saved); startPending(saved.id); showToast("Pesanan masuk ke kasir. Scan QRIS; kasir konfirmasi pembayaran.");
      } else if (method === "transfer") {
        var subId2 = saved.transfer_method || selectedTransfer();
        var opt2 = TRANSFER_OPTIONS.filter(function (o) { return o.id === subId2; })[0] || TRANSFER_OPTIONS[0];
        showTransfer(saved, opt2); startPending(saved.id); showToast("Pesanan masuk ke kasir. Transfer ke " + opt2.label + "; kasir konfirmasi pembayaran.");
      }
    } catch (err) {
      payBtn.disabled = false;
      showToast("Gagal mengirim pesanan: " + (err.message || "kesalahan server"));
    }
  }

  function resetCart() {
    cart = {}; currentOrder = null;
    document.querySelectorAll(".ord-qty").forEach(function (el) { el.textContent = "0"; });
    document.querySelectorAll(".ord-stepper").forEach(function (el) { el.hidden = true; });
    nameInput.value = ""; noteInput.value = "";
    render();
  }

  /* QRIS: hanya barcode */
  function showQris(o) {
    hidePayViewParts(); payView.hidden = false; payFieldset.hidden = true; ordTempField.hidden = true; transferSub.hidden = true;
    payTitle.textContent = "Scan QRIS";
    payBody.innerHTML = '<p>Scan barcode QRIS ini untuk membayar <strong>' + fmt(o.total || 0) + '</strong>.</p>' +
      '<p class="ord-pay-note">Order masuk kasir (belum bayar). Setelah dipindai, kasir menekan <strong>Konfirmasi sudah bayar</strong>.</p>';
    renderQR(payQr, qrisPayload(o)); payBtn.hidden = true;
  }

  function showTransfer(o, opt) {
    hidePayViewParts(); payView.hidden = false; payFieldset.hidden = true; ordTempField.hidden = true; transferSub.hidden = true;
    payTitle.textContent = "Transfer — " + opt.label;
    var numLabel = opt.id === "bri" ? "no rek" : (opt.id === "gopay" ? "no gopay" : "no");
    payBody.innerHTML = '<p>Transfer <strong>' + fmt(o.total || 0) + '</strong> ke:</p>' +
      '<div class="ord-rek"><div><span>Metode</span><strong>' + escapeHtml(opt.label) + '</strong></div>' +
      '<div class="ord-rek-line"><span>' + escapeHtml(numLabel + ' :') + '</span><strong class="ord-rek-no">' + escapeHtml(opt.number) + '</strong></div>' +
      '<div class="ord-rek-line"><span>atas nama :</span><strong>' + escapeHtml(opt.name) + '</strong></div></div>' +
      '<p class="ord-pay-note">Order masuk kasir (belum bayar). Setelah transfer, tunjukkan bukti; kasir menekan <strong>Konfirmasi sudah bayar</strong>.</p>';
    payBtn.hidden = true;
  }

  /* tunggu konfirmasi kasir -> sembunyikan info pembayaran + selesai */
  function startPending(id) {
    stopPending(); pendingOrderId = id;
    pollTimer = setInterval(async function () {
      try {
        var s = await API.orderStatus(pendingOrderId);
        if (s && (s.paid === true || s.payment_confirmed === true)) {
          stopPending(); hidePayView(); closePanel(); showToast("Pembayaran dikonfirmasi kasir. Pesanan selesai.");
        }
      } catch (e) { /* diamkan; coba lagi */ }
    }, 2000);
  }
  function stopPending() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } pendingOrderId = null; }

  /* ---------- helpers ---------- */
  function resetPayView() {
    payView.hidden = true; payFieldset.hidden = false; payBtn.hidden = false; ordTempField.hidden = false; transferSub.hidden = true;
    payTitle.textContent = ""; payBody.innerHTML = ""; payQr.innerHTML = "";
    var nameError = panel.querySelector("#ord-name-error"); if (nameError) nameError.hidden = true;
  }
  function hidePayView() { payView.hidden = true; payQr.innerHTML = ""; payBody.innerHTML = ""; payTitle.textContent = ""; payBtn.hidden = false; ordTempField.hidden = false; transferSub.hidden = true; }
  function hidePayViewParts() { payQr.innerHTML = ""; payBody.innerHTML = ""; }
  function qrisPayload(o) { return ["QRIS", "CAFFEMARGO", o.id, "Rp" + (o.total || 0), (o.items || []).map(function (it) { return it.name + "x" + it.qty; }).join(","), "DEMO"].join("|"); }

  function renderQR(el, text) {
    el.innerHTML = "";
    if (window.QRCode) { try { new QRCode(el, { text: text, width: 200, height: 200, colorDark: "#231A13", colorLight: "#FFFFFF", correctLevel: QRCode.CorrectLevel.M }); return; } catch (e) {} }
    var fb = document.createElement("div"); fb.className = "ord-qr-fallback";
    fb.innerHTML = '<div class="ord-qr-placeholder" aria-hidden="true"></div><p>Barcode QRIS (perlu koneksi untuk memuat QR). Referensi: <code>' + escapeHtml(text) + "</code></p>";
    el.appendChild(fb);
  }

  function showToast(msg) { toastEl.textContent = msg; toastEl.hidden = false; clearTimeout(showToast._t); showToast._t = setTimeout(function () { toastEl.hidden = true; }, 3500); }
  function parsePrice(s) { return parseInt(String(s).replace(/[^\d]/g, ""), 10) || 0; }
  function slug(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); }
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function escapeAttr(s) { return escapeHtml(s); }

  /* ---------- init ---------- */
  function init() { buildPanel(); enhanceCards(); render(); document.addEventListener("click", function (e) { if (e.target.closest(".menu-tabs")) setTimeout(enhanceCards, 0); }); }
  if (document.readyState === "loading") { document.addEventListener("DOMContentLoaded", init); } else { init(); }
})();
