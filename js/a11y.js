/* תפריט נגישות — ההגדרות נשמרות בדפדפן של הגולש */
(function () {
  "use strict";
  var KEY = "mkA11y";
  var root = document.documentElement;
  var FLAGS = ["contrast", "gray", "links", "font", "still", "spacing"];
  var SIZES = [90, 100, 112, 125, 140];
  var s;
  try { s = JSON.parse(localStorage.getItem(KEY) || "{}"); } catch (e) { s = {}; }
  var btn = document.getElementById("a11yBtn");
  var panel = document.getElementById("a11yPanel");
  if (!btn || !panel) return;

  function save() { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) {} }
  function apply() {
    root.style.fontSize = s.size && s.size !== 100 ? s.size + "%" : "";
    FLAGS.forEach(function (k) { root.classList.toggle("a11y-" + k, !!s[k]); });
    panel.querySelectorAll("[data-a11y]").forEach(function (b) { b.setAttribute("aria-pressed", s[b.dataset.a11y] ? "true" : "false"); });
    document.getElementById("a11ySizeVal").textContent = (s.size || 100) + "%";
    // מעדכן את גובה הכותרת (משתנה כשמגדילים טקסט)
    window.dispatchEvent(new Event("resize"));
  }
  function open() { panel.hidden = false; btn.setAttribute("aria-expanded", "true"); var f = panel.querySelector("button"); if (f) f.focus(); }
  function close() { panel.hidden = true; btn.setAttribute("aria-expanded", "false"); btn.focus(); }

  btn.setAttribute("aria-expanded", "false");
  btn.addEventListener("click", function () { panel.hidden ? open() : close(); });
  document.getElementById("a11yClose").addEventListener("click", close);
  document.getElementById("a11yReset").addEventListener("click", function () { s = {}; save(); apply(); });
  panel.addEventListener("click", function (e) {
    var t = e.target.closest("button"); if (!t) return;
    if (t.dataset.a11y) { s[t.dataset.a11y] = !s[t.dataset.a11y]; save(); apply(); }
    if (t.dataset.a11ySize) {
      var i = SIZES.indexOf(s.size || 100); if (i < 0) i = 1;
      i = Math.max(0, Math.min(SIZES.length - 1, i + Number(t.dataset.a11ySize)));
      s.size = SIZES[i]; save(); apply();
    }
  });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !panel.hidden) { e.stopPropagation(); close(); } }, true);
  document.addEventListener("click", function (e) { if (!panel.hidden && !panel.contains(e.target) && !btn.contains(e.target)) panel.hidden = true; });
  apply();
})();
