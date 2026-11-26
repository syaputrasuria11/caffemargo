/* shared/api.js — klien API Caffe Margo (backend `caffemargo-backend`).
   Dipakai Caffe + kasir. Menggantikan order bus localStorage (`shared/orders.js`).
   Base URL: window.CAFFEMARGO_API atau default. Token admin dari kasir auth. */
(function (global) {
  "use strict";

  function apiBase() { return (global.CAFFEMARGO_API || "http://127.0.0.1:8081").replace(/\/+$/, ""); }

  function formatIDR(n) {
    n = Math.round(Number(n) || 0);
    return "Rp " + String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  }

  function token() {
    try { return sessionStorage.getItem("caffemargo.token") || null; } catch (e) { return null; }
  }

  async function api(path, opts) {
    opts = opts || {};
    var headers = Object.assign({}, opts.headers || {});
    if (opts.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
    var t = token(); if (t && !headers["Authorization"]) headers["Authorization"] = "Bearer " + t;
    var res = await fetch(apiBase() + path, Object.assign({}, opts, { headers: headers }));
    var data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok) { var err = new Error((data && data.error) || ("HTTP " + res.status)); err.status = res.status; err.data = data; throw err; }
    return data;
  }

  global.CaffeAPI = {
    apiBase: apiBase,
    api: api,
    token: token,
    formatIDR: formatIDR,
    getMenu: function () { return api("/menu"); },
    postOrder: function (order) { return api("/orders", { method: "POST", body: JSON.stringify(order) }); },
    listOrders: function (status) { return api("/orders" + (status ? ("?status=" + encodeURIComponent(status)) : "")); },
    getOrder: function (id) { return api("/orders/" + encodeURIComponent(id)); },
    orderStatus: function (id) { return api("/orders/" + encodeURIComponent(id) + "/status"); },
    revenuePaid: function () { return api("/orders/revenue-paid"); },
    setStatus: function (id, status) { return api("/orders/" + encodeURIComponent(id), { method: "PATCH", body: JSON.stringify({ status: status }) }); },
    confirmPaid: function (id) { return api("/orders/" + encodeURIComponent(id) + "/paid", { method: "PATCH" }); },
    login: function (username, password) { return api("/login", { method: "POST", body: JSON.stringify({ username: username, password: password }) }); },
    logout: function () { return api("/logout", { method: "POST" }); },
    me: function () { return api("/me"); }
  };
})(window);
