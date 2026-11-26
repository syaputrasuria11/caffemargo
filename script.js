/* Caffe Margo — interaksi ringan, tanpa dependency */
(function () {
  "use strict";

  /* ---- Tahun footer ---- */
  var yearEl = document.getElementById("year");
  if (yearEl) yearEl.textContent = String(new Date().getFullYear());

  /* ---- Header bayangan saat scroll ---- */
  var header = document.querySelector(".site-header");
  if (header) {
    var onScroll = function () {
      header.classList.toggle("is-scrolled", window.scrollY > 8);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
  }

  /* ---- Menu mobile ---- */
  var navToggle = document.querySelector(".nav-toggle");
  var nav = document.querySelector(".nav");
  if (navToggle && nav) {
    var setNav = function (open) {
      nav.classList.toggle("is-open", open);
      navToggle.classList.toggle("is-open", open);
      navToggle.setAttribute("aria-expanded", String(open));
      navToggle.setAttribute("aria-label", open ? "Tutup menu navigasi" : "Buka menu navigasi");
    };
    navToggle.addEventListener("click", function () {
      setNav(!nav.classList.contains("is-open"));
    });
    // tutup saat link diklik
    nav.addEventListener("click", function (e) {
      if (e.target.closest("a")) setNav(false);
    });
    // tutup dengan Escape
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && nav.classList.contains("is-open")) {
        setNav(false);
        navToggle.focus();
      }
    });
    // tutup bila resize ke desktop
    window.addEventListener("resize", function () {
      if (window.innerWidth > 720) setNav(false);
    });
  }

  /* ---- Filter kategori menu ---- */
  var tabs = Array.prototype.slice.call(document.querySelectorAll(".menu-tabs .tab"));
  var cards = Array.prototype.slice.call(document.querySelectorAll(".menu-card"));
  var grid = document.getElementById("menu-grid");

  function applyFilter(filter) {
    cards.forEach(function (card) {
      var show = filter === "semua" || card.getAttribute("data-category") === filter;
      card.hidden = !show;
    });
    tabs.forEach(function (tab) {
      var active = tab.getAttribute("data-filter") === filter;
      tab.classList.toggle("is-active", active);
      tab.setAttribute("aria-selected", String(active));
    });
    if (grid && filter !== "semua") {
      // panel dikendalikan tab yang aktif
      var activeTab = tabs.filter(function (t) { return t.classList.contains("is-active"); })[0];
      if (activeTab) grid.setAttribute("aria-labelledby", activeTab.id);
    } else if (grid) {
      var firstTab = tabs[0];
      if (firstTab) grid.setAttribute("aria-labelledby", firstTab.id);
    }
  }

  tabs.forEach(function (tab) {
    tab.addEventListener("click", function () {
      applyFilter(tab.getAttribute("data-filter"));
    });
  });

  // terapkan filter awal agar konsisten dengan tab yang aktif
  applyFilter("kopi");

  /* ---- Reveal on scroll ---- */
  var revealEls = Array.prototype.slice.call(document.querySelectorAll(".reveal"));
  var prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  if (prefersReduced || !("IntersectionObserver" in window)) {
    revealEls.forEach(function (el) { el.classList.add("is-visible"); });
  } else {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12, rootMargin: "0px 0px -8% 0px" });

    // beri sedikit jeda berurutan untuk efek rapi
    revealEls.forEach(function (el, i) {
      el.style.transitionDelay = (Math.min(i % 6, 5) * 0.05) + "s";
      io.observe(el);
    });
  }
})();
