/* ordering.js — pemesanan di menu Caffe Margo.
   Alur: pilih menu → "Tambah Pesan" → atur jumlah +/- → "Pesan" →
   total + metode (Cash / QRIS / Transfer) → order masuk ke web kasir.

   STATUS BAYAR terpisah:
   - Order MASUK kasir dengan paid=false / paymentConfirmed=false.
   - ADMIN (kasir) menekan "Konfirmasi sudah bayar" di web kasir setelah
     pembeli menunjukkan pembayaran (cash/QRIS/transfer) → paid=true.
   - Tidak ada tombol "sudah bayar" di halaman menu pembeli.

   QRIS: tampil barcode QRIS saja; tidak ada tombol scan manual.
   (Deteksi scan + verifikasi pembayaran sungguhan butuh payment provider.)

   Transfer: pilih DANA / GoPay / BRI (rekening) + nomor.

   Aplikasi TERPISAH dari web kasir; order lewat shared/orders.js. */
(function () {
  "use strict";

  if (!window.CaffeOrders) { console.warn("CaffeOrders tidak tersedia."); return; }

  /* Transfer options (nomor dari Caffe Margo). */
  var TRANSFER_OPTIONS = [
    { id: "dana",  label: "DANA",          type: "E-wallet", number: "081376944172",    name: "caffemargo" },
    { id: "gopay", label: "GoPay",         type: "E-wallet", number: "081376944172",    name: "caffemargo" },
    { id: "bri",   label: "BRI (rekening)", type: "Bank BRI", number: "753501034929539", name: "caffemargo" }
  ];

  var fmt = window.CaffeOrders.formatIDR;
  var cart = {};
  var panel, listEl, totalEl, countEl, nameInput, noteInput, payBtn, toastEl, fab;
  var payFieldset, transferSub, payView, payTitle, payBody, payQr;
  var currentOrder = null;

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

  function tempOf(card) { return null; }
  function keyOf(id, temp) { return id; }
  function tempLabel(t) { return ""; }

  function refreshCard(card) {
    var id = card.getAttribute("data-order-id");
    var key = keyOf(id, tempOf(card));
    var item = cart[key];
    var qty = item ? item.qty : 0;
    var qtyEl = card.querySelector(".ord-qty");
    var stepper = card.querySelector(".ord-stepper");
    if (qtyEl) qtyEl.textContent = String(qty);
    if (stepper) stepper.hidden = qty === 0;
  }

  function bump(id, name, price, delta, card) {
    var temp = tempOf(card);
    var key = keyOf(id, temp);
    var displayName = temp ? (name + " (" + tempLabel(temp) + ")") : name;
    var item = cart[key] || { id: id, name: displayName, baseName: name, price: price, qty: 0, temperature: temp };
    item.qty = Math.max(0, item.qty + delta);
    if (item.qty === 0) { delete cart[key]; } else { cart[key] = item; }
    refreshCard(card);
    render();
  }

  /* ---------- panel ---------- */
  function transferSubHtml() {
    return TRANSFER_OPTIONS.map(function (o, i) {
      return '<label class="ord-pay-opt ord-transfer-opt">' +
        '<input type="radio" name="ord-transfer" value="' + o.id + '"' + (i === 0 ? " checked" : "") + "> " +
        escapeHtml(o.label) + " <span class=\"ord-transfer-num\">" + escapeHtml(o.number) + "</span></label>";
    }).join("");
  }

  function buildPanel() {
    panel = document.createElement("div");
    panel.className = "ord-panel";
    panel.hidden = true;
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Pesanan & pembayaran");
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
        '</div>' +
      '</fieldset>' +

      /* Nama WAJIB; hanya Catatan yang opsional */
      '<label class="ord-field"><span>Nama</span><input type="text" id="ord-name" placeholder="Nama Anda" required aria-required="true"></label>' +
      '<p class="ord-name-error" id="ord-name-error" role="alert" hidden>Nama wajib diisi.</p>' +
      '<label class="ord-field"><span>Catatan (opsional)</span><input type="text" id="ord-note" placeholder="mis. tanpa gula"></label>' +

      '<fieldset class="ord-pay-field" id="ord-pay-field"><legend>Metode pembayaran</legend>' +
        '<div class="ord-pay-options" role="radiogroup" aria-label="Metode pembayaran">' +
          '<label class="ord-pay-opt"><input type="radio" name="ord-method" value="cash" checked> Cash</label>' +
          '<label class="ord-pay-opt"><input type="radio" name="ord-method" value="qris"> QRIS</label>' +
          '<label class="ord-pay-opt"><input type="radio" name="ord-method" value="transfer"> Transfer</label>' +
        '</div>' +
      '</fieldset>' +

      /* sub-metode transfer */
      '<fieldset class="ord-pay-field ord-transfer-sub" id="ord-transfer-sub" hidden><legend>Transfer ke</legend>' +
        '<div class="ord-pay-options ord-transfer-options" role="radiogroup" aria-label="Metode transfer">' + transferSubHtml() + '</div>' +
      '</fieldset>' +

      /* info pembayaran (QRIS QR / info transfer) */
      '<div class="ord-payview" id="ord-payview" hidden>' +
        '<div class="ord-pay-title" id="ord-pay-title"></div>' +
        '<div class="ord-qr" id="ord-qr"></div>' +
        '<div class="ord-pay-body" id="ord-pay-body"></div>' +
      '</div>' +

      '<button type="button" class="ord-pay" id="ord-pay">Pesan</button>' +
      '<p class="ord-hint">Order masuk ke web kasir dengan status <strong>belum bayar</strong>. Admin kasir menekan <strong>Konfirmasi sudah bayar</strong> setelah Anda menunjukkan pembayaran.</p>';
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

    panel.querySelector(".ord-close").addEventListener("click", closePanel);
    payBtn.addEventListener("click", confirmOrder);

    // tampilkan sub-metode saat Transfer dipilih
    panel.addEventListener("change", function (e) {
      if (e.target && e.target.name === "ord-method") {
        transferSub.hidden = e.target.value !== "transfer";
      }
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
  function openPanel() { render(); panel.hidden = false; }
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
  function selectedTemp() { return (panel.querySelector('input[name="ord-temp"]:checked') || {}).value || "hot"; }
  function selectedTransfer() { return (panel.querySelector('input[name="ord-transfer"]:checked') || {}).value || "dana"; }

  /* ---------- klik Pesan ---------- */
  function confirmOrder() {
    var items = Object.keys(cart).map(function (k) { return cart[k]; });
    if (!items.length) return;
    // NAMA WAJIB diisi; hanya Catatan yang opsional
    var customerName = (nameInput.value || "").trim();
    var nameError = panel.querySelector("#ord-name-error");
    if (!customerName) {
      if (nameError) nameError.hidden = false;
      nameInput.setAttribute("aria-invalid", "true");
      nameInput.focus();
      return;
    }
    if (nameError) nameError.hidden = true;
    nameInput.removeAttribute("aria-invalid");

    var total = items.reduce(function (s, it) { return s + it.qty * it.price; }, 0);
    var method = selectedMethod();

    currentOrder = {
      id: "ORD-" + Date.now().toString(36).toUpperCase(),
      createdAt: new Date().toISOString(),
      customer: customerName,
      temperature: selectedTemp(),
      note: (noteInput.value || "").trim(),
      items: items.map(function (it) { var o = { id: it.id, name: it.name, price: it.price, qty: it.qty }; if (it.temperature) { o.temperature = it.temperature; } if (it.baseName) { o.baseName = it.baseName; } return o; }),
      total: total,
      paymentMethod: method,
      paid: false,                 // belum terkonfirmasi bayar
      paymentConfirmed: false,     // kasir yang konfirmasi
      status: "baru",
      source: "caffe-margo"
    };

    if (method === "cash") {
      // CASH: otomatis terkonfirmasi bayar; tanpa barcode QRIS; tidak perlu konfirmasi kasir
      currentOrder.paid = true;
      currentOrder.paymentConfirmed = true;
      currentOrder.paymentConfirmedBy = "cash";
      hidePayView();
      submitOrder(); closePanel();
      showToast("Pesanan tunai masuk ke kasir & sudah terkonfirmasi bayar.");
    } else if (method === "qris") {
      showQris();                  // barcode QRIS saja; tidak ada tombol scan
      submitOrder();               // order masuk kasir (belum bayar); kasir konfirmasi setelah dipindai
      showToast("Pesanan masuk ke kasir. Scan QRIS; kasir konfirmasi pembayaran.");
    } else if (method === "transfer") {
      var subId = selectedTransfer();
      var opt = TRANSFER_OPTIONS.filter(function (o) { return o.id === subId; })[0] || TRANSFER_OPTIONS[0];
      currentOrder.transferMethod = opt.id;
      currentOrder.transferDetail = { type: opt.type, label: opt.label, number: opt.number, name: opt.name };
      showTransfer(opt);
      submitOrder();
      showToast("Pesanan masuk ke kasir. Transfer ke " + opt.label + "; kasir konfirmasi pembayaran.");
    }
  }

  /* QRIS: hanya barcode */
  function showQris() {
    hidePayViewParts();
    payView.hidden = false;
    payTitle.textContent = "Scan QRIS";
    payBody.innerHTML =
      '<p>Scan barcode QRIS ini untuk membayar <strong>' + fmt(currentOrder.total) + '</strong>.</p>' +
      '<p class="ord-pay-note">Order sudah masuk ke kasir (belum bayar). Setelah dipindai, kasir menekan <strong>Konfirmasi sudah bayar</strong>.</p>';
    renderQR(payQr, qrisPayload(currentOrder));
    payBtn.hidden = true;          // tidak ada tombol scan/bayar di halaman pembeli
  }

  /* Transfer: info nomor (label persis sesuai metode) */
  function showTransfer(opt) {
    hidePayViewParts();
    payView.hidden = false;
    payTitle.textContent = "Transfer — " + opt.label;
    var numLabel = opt.id === "bri" ? "no rek" : (opt.id === "gopay" ? "no gopay" : "no");
    payBody.innerHTML =
      '<p>Transfer <strong>' + fmt(currentOrder.total) + '</strong> ke:</p>' +
      '<div class="ord-rek">' +
        '<div><span>Metode</span><strong>' + escapeHtml(opt.label) + '</strong></div>' +
        '<div class="ord-rek-line"><span>' + escapeHtml(numLabel + ' :') + '</span><strong class="ord-rek-no">' + escapeHtml(opt.number) + '</strong></div>' +
        '<div class="ord-rek-line"><span>atas nama :</span><strong>' + escapeHtml(opt.name) + '</strong></div>' +
      '</div>' +
      '<p class="ord-pay-note">Order sudah masuk ke kasir (belum bayar). Setelah transfer, tunjukkan bukti; kasir menekan <strong>Konfirmasi sudah bayar</strong>.</p>';
    payBtn.hidden = true;
  }

  /* ---------- kirim order ---------- */
  function submitOrder() {
    var order = currentOrder;
    window.CaffeOrders.addOrder(order);
    var id = order.id;
    var alreadyPaid = order.paid === true || order.paymentConfirmed === true;
    // reset keranjang
    cart = {}; currentOrder = null;
    document.querySelectorAll(".ord-qty").forEach(function (el) { el.textContent = "0"; });
    document.querySelectorAll(".ord-stepper").forEach(function (el) { el.hidden = true; });
    document.querySelectorAll(".ord-add").forEach(function (el) { el.hidden = false; });
    document.querySelectorAll(".ord-temp").forEach(function (el) { el.hidden = true; });
    nameInput.value = ""; noteInput.value = "";
    payBtn.disabled = true;
    render();
    // QRIS/Transfer (belum bayar): tunggu konfirmasi kasir untuk menghilangkan tampilan pembayaran
    pendingOrderId = alreadyPaid ? null : id;
  }
  var pendingOrderId = null;

  /* ---------- helpers ---------- */
  function hidePayView() { payView.hidden = true; payQr.innerHTML = ""; payBody.innerHTML = ""; payTitle.textContent = ""; payBtn.hidden = false; transferSub.hidden = true; }
  function hidePayViewParts() { payQr.innerHTML = ""; payBody.innerHTML = ""; }
  function qrisPayload(o) { return ["QRIS", "CAFFEMARGO", o.id, "Rp" + o.total, o.items.map(function (it) { return it.name + "x" + it.qty; }).join(","), "DEMO"].join("|"); }

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

  function init() {
    buildPanel(); enhanceCards(); render();
    document.addEventListener("click", function (e) { if (e.target.closest(".menu-tabs")) setTimeout(enhanceCards, 0); });
    // kasir konfirmasi pembayaran -> order selesai, sembunyikan barcode QRIS / info transfer
    window.CaffeOrders.subscribe(function (list) {
      if (!pendingOrderId) return;
      var o = list.filter(function (x) { return x.id === pendingOrderId; })[0];
      if (o && (o.paid === true || o.paymentConfirmed === true)) {
        pendingOrderId = null;
        hidePayView(); closePanel();
        showToast("Pembayaran dikonfirmasi kasir. Pesanan selesai.");
      }
    });
  }
  if (document.readyState === "loading") { document.addEventListener("DOMContentLoaded", init); } else { init(); }
})();
