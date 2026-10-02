/* ==========================================================
   עמדת ייצור (טאבלט בפס) · משה קילופים
   - כניסה עם משתמש העמדה (production_staff) או מנהל
   - תור ההזמנות: production_queue()  (בלי מחירים, בלי טלפונים)
   - "הוכן": mark_prepared(order_id)  (רק בייצור ← הוכנה)
   - עדכון בזמן אמת: ערוץ production, ורענון גיבוי כל 30 שניות
   ========================================================== */
(function () {
  "use strict";

  const { SUPABASE_URL, SUPABASE_KEY } = window.MK_CONFIG;
  const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const num = n => new Intl.NumberFormat("he-IL", { maximumFractionDigits: 1 }).format(n || 0);
  const NEW_MS = 10 * 60 * 1000;
  // תמונות המוצרים: אותו קטלוג של האתר (js/products.js), לפי שם המוצר
  const IMG = new Map((window.MK_PRODUCTS || []).map(p => [p.name, p.image]));
  const thumb = name => IMG.has(name)
    ? `<img class="ph" src="../img/thumbs/${esc(IMG.get(name))}" alt="" width="56" height="56" loading="lazy">`
    : `<span class="ph"></span>`;           // הזמנה "חדשה" = אושרה ב-10 הדקות האחרונות

  const state = { orders: [], seen: new Set(), first: true, channel: null, busy: false, pendingId: null, wake: null };

  /* ---------- עזר ---------- */
  let toastTimer;
  function toast(msg, isError) {
    const t = $("#toast"); t.textContent = msg; t.classList.toggle("error", !!isError); t.classList.add("show");
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), 3500);
  }
  function showAlert(msg) {
    const a = $("#alert"); a.textContent = msg; a.hidden = false;
    clearTimeout(showAlert.t); showAlert.t = setTimeout(() => { a.hidden = true; }, 15000);
  }
  function show(view) { ["loginView", "deniedView", "appView"].forEach(id => { $("#" + id).hidden = id !== view; }); }
  function ago(ts) {
    if (!ts) return "";
    const m = Math.round((Date.now() - new Date(ts)) / 60000);
    if (m < 1) return "עכשיו"; if (m < 60) return `לפני ${m} דק׳`;
    const h = Math.floor(m / 60); return h < 24 ? `לפני ${h} שע׳` : `לפני ${Math.floor(h / 24)} ימים`;
  }
  function dayLabel(iso) {
    if (!iso) return "";
    const d = new Date(iso + "T12:00:00"), t = new Date(); t.setHours(12, 0, 0, 0);
    const diff = Math.round((d - t) / 86400000);
    if (diff === 0) return "היום"; if (diff === 1) return "מחר"; if (diff < 0) return "באיחור";
    return d.toLocaleDateString("he-IL", { weekday: "long", day: "numeric", month: "numeric" });
  }

  /* צליל (Web Audio, בלי קובץ) */
  let audio;
  function unlockAudio() { try { audio = audio || new (window.AudioContext || window.webkitAudioContext)(); audio.resume(); } catch (_) {} }
  function chime() {
    try {
      unlockAudio();
      [[0, 659], [0.2, 880], [0.4, 1047]].forEach(([t, f]) => {
        const o = audio.createOscillator(), g = audio.createGain();
        o.type = "sine"; o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, audio.currentTime + t);
        g.gain.exponentialRampToValueAtTime(0.35, audio.currentTime + t + 0.03);
        g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + t + 0.35);
        o.connect(g).connect(audio.destination); o.start(audio.currentTime + t); o.stop(audio.currentTime + t + 0.36);
      });
    } catch (_) {}
  }

  /* המסך לא נכבה בזמן עבודה (אם הדפדפן תומך) */
  async function keepAwake() {
    try { if ("wakeLock" in navigator && !state.wake) { state.wake = await navigator.wakeLock.request("screen"); state.wake.addEventListener("release", () => { state.wake = null; }); } } catch (_) {}
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { keepAwake(); load(); } });

  /* ==========================================================
     כניסה
     ========================================================== */
  async function onSession(session) {
    if (!session) { stopRealtime(); show("loginView"); return; }
    const [{ data: isProd }, { data: isAdmin }] = await Promise.all([db.rpc("is_production"), db.rpc("is_admin")]);
    if (!isProd && !isAdmin) { $("#deniedEmail").textContent = session.user.email; show("deniedView"); return; }
    show("appView");
    if (!audio || audio.state !== "running") $("#soundGate").hidden = false;
    await load();
    startRealtime(session);
  }

  $("#loginForm").addEventListener("submit", async e => {
    e.preventDefault(); unlockAudio();
    $("#loginError").textContent = ""; $("#loginBtn").disabled = true;
    const { error } = await db.auth.signInWithPassword({ email: $("#email").value.trim(), password: $("#password").value });
    $("#loginBtn").disabled = false;
    if (error) $("#loginError").textContent = "משתמש או סיסמה לא נכונים";
  });
  db.auth.onAuthStateChange((event, session) => {
    if (event === "TOKEN_REFRESHED" && session) { try { db.realtime.setAuth(session.access_token); } catch (_) {} return; }
    setTimeout(() => onSession(session), 0);
  });
  $("#soundBtn").addEventListener("click", () => { unlockAudio(); $("#soundGate").hidden = true; keepAwake(); });

  /* ==========================================================
     תור ההזמנות
     ========================================================== */
  async function load() {
    if ($("#appView").hidden || state.busy) return;
    const { data, error } = await db.rpc("production_queue");
    if (error) { setStatus(false, "שגיאה בטעינה"); return; }
    const before = new Set(state.orders.map(o => o.order_id));
    state.orders = data || [];
    const fresh = state.orders.filter(o => !before.has(o.order_id));
    const freshIds = state.first ? new Set() : new Set(fresh.map(o => o.order_id));
    if (!state.first && fresh.length) { chime(); toast(fresh.length === 1 ? `הזמנה חדשה: ${fresh[0].customer_name}` : `${fresh.length} הזמנות חדשות`); }
    state.first = false;
    render(freshIds);
    $("#updated").textContent = "עודכן " + new Date().toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" });
  }

  function render(freshIds) {
    const list = state.orders;
    $("#count").textContent = list.length ? `${list.length} הזמנות` : "אין הזמנות";
    $("#empty").hidden = list.length > 0;
    document.title = list.length ? `(${list.length}) עמדת ייצור` : "עמדת ייצור · משה קילופים";

    $("#queue").innerHTML = list.map(o => {
      const isNew = freshIds.has(o.order_id) || (o.approved_at && Date.now() - new Date(o.approved_at) < NEW_MS);
      const due = dayLabel(o.delivery_date);
      const items = (o.items || []).map(i => `<li><span class="q">${num(i.quantity)}</span>${thumb(i.product)}<span class="p">${esc(i.product)}</span><span class="u">${esc(i.unit || "")}</span></li>`).join("");
      return `<article class="ticket${isNew ? " is-new" : ""}${due === "באיחור" || due === "היום" ? " is-urgent" : ""}" data-id="${o.order_id}">
        <header>
          <div class="who"><strong>${esc(o.customer_name)}</strong><span>הזמנה ${o.order_id}</span></div>
          <div class="when">${due ? `<span class="due">${esc(due)}</span>` : ""}<span class="muted">אושרה ${esc(ago(o.approved_at))}</span></div>
        </header>
        ${isNew ? `<span class="new-flag">חדשה</span>` : ""}
        <ul class="items">${items}</ul>
        ${o.notes ? `<p class="notes">${esc(o.notes)}</p>` : ""}
        <button type="button" class="btn btn-done btn-xl" data-done="${o.order_id}">הוכן ✓</button>
      </article>`;
    }).join("");

    const pick = new Map();
    list.forEach(o => (o.items || []).forEach(i => {
      const k = i.product; const cur = pick.get(k) || { q: 0, u: i.unit };
      cur.q += Number(i.quantity); pick.set(k, cur);
    }));
    $("#pickBody").innerHTML = [...pick.entries()].sort((a, b) => b[1].q - a[1].q)
      .map(([p, v]) => `<tr><td><span class="pk">${thumb(p)}${esc(p)}</span></td><td class="q">${num(v.q)}</td></tr>`).join("") || `<tr><td class="muted">אין</td></tr>`;
  }

  /* ----- "הוכן" ----- */
  $("#queue").addEventListener("click", e => {
    const b = e.target.closest("[data-done]"); if (!b) return;
    unlockAudio();
    if (!navigator.onLine) { toast("אין חיבור לאינטרנט", true); return; }
    const o = state.orders.find(x => x.order_id === Number(b.dataset.done)); if (!o) return;
    state.pendingId = o.order_id;
    $("#cTitle").textContent = `הזמנה ${o.order_id} הוכנה?`;
    $("#cText").textContent = o.customer_name;
    $("#confirm").hidden = false;
    $("#cYes").focus();
  });
  $("#cNo").addEventListener("click", () => { $("#confirm").hidden = true; state.pendingId = null; });
  $("#confirm").addEventListener("click", e => { if (e.target.id === "confirm") $("#cNo").click(); });

  $("#cYes").addEventListener("click", async () => {
    const id = state.pendingId; if (!id) return;
    $("#cYes").disabled = true; state.busy = true;
    const { data: ok, error } = await db.rpc("mark_prepared", { p_order_id: id });
    $("#cYes").disabled = false; state.busy = false; $("#confirm").hidden = true; state.pendingId = null;
    if (error) { toast("הסימון נכשל: " + error.message, true); return; }
    if (ok) {
      const card = document.querySelector(`.ticket[data-id="${id}"]`);
      if (card) card.classList.add("leaving");
      toast(`הזמנה ${id} סומנה כמוכנה`);
      setTimeout(load, 450);
    } else {
      toast(`הזמנה ${id} כבר לא בייצור (אולי בוטלה או סומנה)`, true);
      load();
    }
  });

  /* ==========================================================
     זמן אמת + גיבוי
     ========================================================== */
  function setStatus(on, text) { const s = $("#status"); s.classList.toggle("on", on); s.textContent = text || (on ? "מחובר" : "מנותק"); }

  async function startRealtime(session) {
    stopRealtime();
    try { await db.realtime.setAuth(session.access_token); } catch (_) {}
    state.channel = db.channel("production", { config: { private: true } })
      .on("broadcast", { event: "order_changed" }, ({ payload }) => {
        const p = payload || {};
        if (p.old_status === "בייצור" && p.status === "בוטלה") { chime(); showAlert(`הזמנה ${p.order_id} בוטלה. אל תכינו אותה.`); }
        else if (p.old_status === "בייצור" && p.status !== "הוכנה" && p.status !== "בייצור") showAlert(`הזמנה ${p.order_id} הוצאה מהייצור.`);
        clearTimeout(startRealtime.t); startRealtime.t = setTimeout(load, 300);
      })
      .subscribe(st => setStatus(st === "SUBSCRIBED"));
  }
  function stopRealtime() { if (state.channel) { db.removeChannel(state.channel); state.channel = null; } setStatus(false); }

  setInterval(load, 30000);
  window.addEventListener("online", () => { $("#offline").hidden = true; load(); });
  window.addEventListener("offline", () => { $("#offline").hidden = false; setStatus(false, "אין אינטרנט"); });
  if (!navigator.onLine) $("#offline").hidden = false;

  /* שעון, מסך מלא, יציאה */
  function tick() { $("#clock").textContent = new Date().toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" }); }
  tick(); setInterval(tick, 15000);
  setInterval(() => { if (state.orders.length) render(new Set()); }, 60000); // רענון "לפני X דק׳"
  $("#fullBtn").addEventListener("click", () => {
    const el = document.documentElement;
    if (!document.fullscreenElement) (el.requestFullscreen || el.webkitRequestFullscreen || (() => {})).call(el);
    else (document.exitFullscreen || (() => {})).call(document);
    keepAwake();
  });
  document.addEventListener("click", async e => {
    if (!e.target.closest("[data-logout]")) return;
    if (!confirm("לצאת מהעמדה?")) return;
    stopRealtime(); await db.auth.signOut();
  });
})();
