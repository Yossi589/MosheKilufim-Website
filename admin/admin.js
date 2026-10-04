/* ==========================================================
   מסך ניהול הזמנות · משה קילופים
   1. התחברות (Supabase Auth) ובדיקת is_admin()
   2. לשונית "ממתינות לאישור": אישור ושליחה לייצור, או ביטול
   3. לשונית "לקוחות חדשים": פניות מהאתר → פתיחת כרטיס לקוח
   4. לשונית "הזמנות לפי יום": סטטוס, נהג, ליקוט
   5. התראות בזמן אמת (ערוץ admin) + צליל + התראת דפדפן
   כל ההרשאות נאכפות בבסיס הנתונים (RLS + is_admin), לא כאן.
   ========================================================== */
(function () {
  "use strict";

  const { SUPABASE_URL, SUPABASE_KEY } = window.MK_CONFIG;
  const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

  const STATUSES = ["ממתינה לאישור", "מאושרת", "בייצור", "הוכנה", "בדרך", "נמסרה", "בוטלה"];
  const PENDING = "ממתינה לאישור";
  const APPROVED_ST = "מאושרת"; // אושרה, מחכה לכפתור "העבר לייצור"
  const EDITABLE = [PENDING, APPROVED_ST, "בייצור"];
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const num = n => new Intl.NumberFormat("he-IL", { maximumFractionDigits: 1 }).format(n || 0);
  const BASE_TITLE = document.title;

  /* מודולים: כל מודול והלשוניות שלו. מלאי ועובדים יתווספו בהמשך */
  const MODULES = {
    orders:    { title: "ניהול הזמנות", sub: "מההזמנה ועד הייצור: מה מחכה לך, מה בפס, ומה יוצא לחשבשבת", tabs: ["pending", "production", "day", "hash", "stats"] },
    customers: { title: "ניהול לקוחות", sub: "לקוחות חדשים לאישור, כרטיסי לקוח ומפתחות חשבשבת", tabs: ["requests", "customers"] }
  };
  const ALL_VIEWS = ["pending", "production", "requests", "day", "stats", "hash", "customers"];

  const state = {
    module: "home", tab: "pending", day: nextDeliveryDay(), dayMode: "delivery", customers: [], editing: null,
    orders: [], drivers: [], products: new Map(),
    pending: [], requests: [], counts: { pending: 0, requests: 0 },
    channel: null, currentRequest: null
  };

  /* ---------- תאריכים ---------- */
  function todayISO() { return toISO(new Date()); }
  function toISO(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
  function dayRange(iso) {
    const [y, m, d] = iso.split("-").map(Number);
    return [new Date(y, m - 1, d).toISOString(), new Date(y, m - 1, d + 1).toISOString()];
  }
  function shiftDay(iso, delta) { const [y, m, d] = iso.split("-").map(Number); return toISO(new Date(y, m - 1, d + delta)); }
  function nextDeliveryDay() { // מחר, ואם מחר שבת אז ראשון
    const d = new Date(); d.setDate(d.getDate() + 1); if (d.getDay() === 6) d.setDate(d.getDate() + 1); return toISO(d);
  }
  /* מתי ההזמנה תופיע בטאבלט: יום לפני האספקה (ולאספקה בראשון: שישי). כמו production_queue */
  function tabletFrom(iso) {
    if (!iso) return "מיד באישור";
    const [y, m, d] = iso.split("-").map(Number);
    const prep = new Date(y, m - 1, d - 1); if (prep.getDay() === 6) prep.setDate(prep.getDate() - 1);
    return toISO(prep) <= todayISO() ? "מיד באישור" : fmtDate(toISO(prep));
  }
  const fmtDate = iso => iso ? new Date(iso + "T12:00:00").toLocaleDateString("he-IL", { weekday: "short", day: "numeric", month: "numeric" }) : "";
  const fmtTime = ts => new Date(ts).toLocaleString("he-IL", { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" });
  function ago(ts) {
    const m = Math.round((Date.now() - new Date(ts)) / 60000);
    if (m < 1) return "עכשיו"; if (m < 60) return `לפני ${m} דק׳`;
    const h = Math.round(m / 60); if (h < 24) return `לפני ${h} שע׳`;
    return `לפני ${Math.round(h / 24)} ימים`;
  }

  /* ---------- משוב ---------- */
  let toastTimer;
  function toast(msg, isError) {
    const t = $("#toast"); t.textContent = msg; t.classList.toggle("error", !!isError); t.classList.add("show");
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), 3500);
  }
  const loading = on => { $("#loading").hidden = !on; };

  /* צליל קצר בלי קובץ (Web Audio) */
  let audio;
  function beep() {
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      [0, 0.18].forEach((t, i) => {
        const o = audio.createOscillator(), g = audio.createGain();
        o.frequency.value = i ? 1046 : 784; o.type = "sine";
        g.gain.setValueAtTime(0.0001, audio.currentTime + t);
        g.gain.exponentialRampToValueAtTime(0.25, audio.currentTime + t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + t + 0.16);
        o.connect(g).connect(audio.destination); o.start(audio.currentTime + t); o.stop(audio.currentTime + t + 0.17);
      });
    } catch (_) { /* בלי צליל */ }
  }
  function notify(title, body) {
    beep(); toast(`${title}: ${body}`);
    if ("Notification" in window && Notification.permission === "granted" && document.hidden) {
      try { new Notification(title, { body, icon: "../img/favicon-64.png", tag: title }); } catch (_) {}
    }
  }

  /* ---------- מסכים ולשוניות ---------- */
  function show(view) { ["loginView", "deniedView", "appView"].forEach(id => { $("#" + id).hidden = id !== view; }); }
  function setTab(tab) {
    state.tab = tab;
    $$(".tab").forEach(b => { const on = b.dataset.tab === tab; b.classList.toggle("is-active", on); b.setAttribute("aria-selected", on); });
    ALL_VIEWS.forEach(t => { $("#view-" + t).hidden = t !== tab; });
    $$(".flow-step").forEach(b => b.classList.toggle("is-current", b.dataset.go === tab));
    refreshTab();
  }

  /* ניווט: #  = מסך פתיחה,  #orders = ניהול הזמנות,  #customers = ניהול לקוחות */
  function route() {
    const mod = location.hash.replace("#", "");
    if (!MODULES[mod]) { showHome(); return; }
    state.module = mod;
    $("#homeView").hidden = true; $("#moduleView").hidden = false; $("#homeBtn").hidden = false;
    $("#moduleTitle").textContent = MODULES[mod].title;
    $("#modTitle").textContent = MODULES[mod].title;
    $("#modSub").textContent = MODULES[mod].sub;
    $$(".mod-head [data-mod]").forEach(b => { b.hidden = b.dataset.mod !== mod; });
    $$(".tab").forEach(b => { b.hidden = b.dataset.mod !== mod; });
    $$(".cards[data-mod]").forEach(c => { c.hidden = c.dataset.mod !== mod; });
    let tab = MODULES[mod].tabs.includes(state.tab) ? state.tab : MODULES[mod].tabs[0];
    if (mod === "customers" && !MODULES.customers.tabs.includes(state.tab)) tab = state.counts.requests ? "requests" : "customers";
    setTab(tab);
    window.scrollTo(0, 0);
  }
  function showHome() {
    state.module = "home";
    $("#homeView").hidden = false; $("#moduleView").hidden = true; $("#homeBtn").hidden = true;
    $("#moduleTitle").textContent = "משה קילופים · ניהול";
    const h = new Date().getHours();
    $("#homeGreeting").textContent = h >= 5 && h < 12 ? "בוקר טוב" : h < 17 && h >= 12 ? "צהריים טובים" : h >= 17 && h < 21 ? "ערב טוב" : "שלום";
    $("#homeDate").textContent = new Date().toLocaleDateString("he-IL", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
    window.scrollTo(0, 0);
  }
  window.addEventListener("hashchange", () => { if (!$("#appView").hidden) route(); });
  function displayName(user) {
    const m = user.user_metadata || {};
    return m.display_name || m.full_name || m.name || (user.email || "").split("@")[0];
  }
  function refreshTab() {
    if (state.tab === "pending") return loadPending();
    if (state.tab === "requests") return loadRequests();
    if (state.tab === "stats") return loadStats();
    if (state.tab === "hash") return loadHash();
    if (state.tab === "customers") return loadCustomers();
    if (state.tab === "production") return loadProduction();
    return loadDay();
  }

  /* ==========================================================
     התחברות
     ========================================================== */
  async function onSession(session) {
    if (!session) { stopRealtime(); show("loginView"); return; }
    const { data: isAdmin, error } = await db.rpc("is_admin");
    if (error || !isAdmin) { $("#deniedEmail").textContent = session.user.email; show("deniedView"); return; }
    $("#userEmail").textContent = session.user.email;
    $("#homeName").textContent = displayName(session.user);
    show("appView");
    setupNotifyButton();
    await Promise.all([loadDrivers(), loadProducts()]);
    await loadCounts();
    route();
    startRealtime(session);
  }

  $("#loginForm").addEventListener("submit", async e => {
    e.preventDefault();
    $("#loginError").textContent = ""; $("#loginBtn").disabled = true;
    const { error } = await db.auth.signInWithPassword({ email: $("#email").value.trim(), password: $("#password").value });
    $("#loginBtn").disabled = false;
    if (error) $("#loginError").textContent = "מייל או סיסמה לא נכונים";
  });
  db.auth.onAuthStateChange((event, session) => {
    if (event === "TOKEN_REFRESHED" && session) { try { db.realtime.setAuth(session.access_token); } catch (_) {} return; }
    setTimeout(() => onSession(session), 0);
  });

  function setupNotifyButton() {
    const b = $("#notifyBtn");
    if (!("Notification" in window) || Notification.permission !== "default") { b.hidden = true; return; }
    b.hidden = false;
    b.onclick = async () => { await Notification.requestPermission(); b.hidden = true; beep(); };
  }

  /* ==========================================================
     נתוני עזר
     ========================================================== */
  async function loadDrivers() {
    const { data, error } = await db.from("drivers").select("driver_id, name, area, is_active").order("name");
    if (error) { toast("שגיאה בטעינת נהגים", true); return; }
    state.drivers = data;
    $("#driverFilter").innerHTML = `<option value="">כל הנהגים</option><option value="none">בלי נהג</option>` +
      data.map(d => `<option value="${d.driver_id}">${esc(d.name)}</option>`).join("");
  }
  async function loadProducts() {
    const { data } = await db.from("product").select("product_id, name, unit, base_price, is_active").order("name");
    state.productList = data || [];
    state.products = new Map((data || []).map(p => [p.product_id, p.name]));
  }

  async function count(table, build) {
    const q = build(db.from(table).select("*", { count: "exact", head: true }));
    const { count: n, error } = await q;
    return error ? null : n;
  }
  async function loadCounts() {
    const [from] = dayRange(todayISO());
    const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
    const [pending, production, prepared, requests, exported, customers, custMonth, noKey, approved] = await Promise.all([
      count("orders", q => q.eq("status", PENDING)),
      count("orders", q => q.eq("status", "בייצור")),
      count("orders", q => q.gte("prepared_at", from)),
      count("customer_requests", q => q.eq("status", "חדשה")),
      count("orders", q => q.eq("delivery_date", nextDeliveryDay()).in("status", [APPROVED_ST, "בייצור", "הוכנה", "בדרך", "נמסרה"]).is("hash_exported_at", null)),
      count("customers", q => q),
      count("customers", q => q.gte("created_at", monthStart.toISOString())),
      count("customers", q => q.is("hash_key", null)),
      count("orders", q => q.eq("status", APPROVED_ST))
    ]);
    $("#flowPendingHint").textContent = approved ? `${approved} מאושרות ממתינות לקילוף` : "לבדוק ולאשר";
    $("#sumToExport").textContent = exported ?? "–";
    $("#sumToExportHint").textContent = `לאספקה ב${fmtDate(nextDeliveryDay())}`;
    $("#flowPending").classList.toggle("hot", !!pending);
    $("#sumCustomers").textContent = customers ?? "–";
    $("#sumCustMonth").textContent = custMonth ?? "–";
    $("#sumNoKey").textContent = noKey ?? "–";
    $("#tileOrders").innerHTML = pending ? `<span class="hot">${pending}</span>ממתינות לאישור` : `${production ?? 0} בייצור · ${prepared ?? 0} הוכנו היום`;
    $("#tileCustomers").innerHTML = requests ? `<span class="hot">${requests}</span>לקוחות חדשים לאישור` : `${customers ?? 0} לקוחות במערכת`;
    const prev = state.counts;
    state.counts = { pending: pending || 0, requests: requests || 0 };
    $("#sumPending").textContent = pending ?? "–";
    $("#sumProduction").textContent = production ?? "–";
    $("#sumPrepared").textContent = prepared ?? "–";
    $("#sumRequests").textContent = requests ?? "–";
    setBadge("#badgePending", state.counts.pending);
    setBadge("#badgeRequests", state.counts.requests);
    const total = state.counts.pending + state.counts.requests;
    document.title = total ? `(${total}) ${BASE_TITLE}` : BASE_TITLE;
    return prev;
  }
  function setBadge(sel, n) { const b = $(sel); b.hidden = !n; b.textContent = n; }

  const orderTotalPacks = o => (o.order_lines || []).reduce((s, l) => s + Number(l.quantity), 0);
  const itemsText = lines => (lines || []).map(l => `${esc(l.product?.name)} × ${num(l.quantity)}`).join("<br>");
  const sourceTag = s => s ? `<span class="tag">${esc(s)}</span>` : "";

  /* ==========================================================
     לשונית: ממתינות לאישור
     ========================================================== */
  async function loadPending() {
    loading(true);
    const { data, error } = await db.from("orders")
      .select(`order_id, order_date, delivery_date, notes, source, status, driver_id,
               customers ( name, phone_number, adress ),
               order_lines ( quantity, product ( name ) )`)
      .eq("status", PENDING)
      .order("order_date", { ascending: true });
    loading(false);
    if (error) { toast("שגיאה בטעינה: " + error.message, true); return; }
    state.pending = data;
    $("#pendingEmpty").hidden = data.length > 0;
    $("#approveAll").hidden = data.length < 2;
    $("#approveAll").textContent = `אשר את כל ה-${data.length}`;
    // הכרטיסים ממוספרים לפי סדר הקבלה במערכת: 1 = ההזמנה הראשונה שהתקבלה
    $("#pendingList").innerHTML = data.map((o, i) => {
      const c = o.customers || {};
      return `<article class="ocard" data-id="${o.order_id}">
        <span class="oc-num" title="מספר ${i + 1} לפי סדר הקבלה">${i + 1}</span>
        <header>
          <div class="oc-who"><strong>${esc(c.name)}</strong><span class="muted">הזמנה ${o.order_id} · ${sourceTag(o.source)} · ${ago(o.order_date)}</span></div>
          <div class="oc-due"><span class="muted">אספקה</span><strong>${o.delivery_date ? esc(fmtDate(o.delivery_date)) : "לא צוין"}</strong></div>
        </header>
        <ul class="oc-items">${(o.order_lines || []).map(l => `<li><b>${num(l.quantity)}</b><span>${esc(l.product?.name)}</span></li>`).join("")}</ul>
        ${o.notes ? `<p class="oc-note">${esc(o.notes)}</p>` : ""}
        <p class="oc-meta muted small"><bdi>${esc(c.phone_number || "")}</bdi> · ${esc(c.adress || "")}</p>
        <footer>
          <button type="button" class="btn btn-primary" data-approve="${o.order_id}">אשר</button>
          <button type="button" class="btn" data-edit-order="${o.order_id}">עריכה</button>
          <button type="button" class="btn btn-link-danger" data-cancel="${o.order_id}">ביטול</button>
        </footer>
      </article>`;
    }).join("");
    await loadApproved();
  }

  /* ----- מאושרות: שורות מתחת לכרטיסים. קבועות (כחול) בסוף. כפתור אחד ("שלח לקילוף") מוריד הכול לטאבלט ----- */
  let lastPrepare = 0;
  async function loadApproved() {
    // יצירת ההזמנות הקבועות ליום האספקה הקרוב (פעם בדקה לכל היותר; אם כבר נוצרו - לא נוצר כלום)
    if (Date.now() - lastPrepare > 60000) {
      lastPrepare = Date.now();
      const { error: pe } = await db.rpc("prepare_standing_orders");
      if (pe) console.warn("prepare_standing_orders:", pe.message);
    }
    const { data, error } = await db.from("orders")
      .select(`order_id, order_date, approved_at, delivery_date, notes, source, standing_id,
               customers ( name ),
               order_lines ( quantity, product ( name ) )`)
      .eq("status", APPROVED_ST)
      .order("delivery_date", { ascending: true, nullsFirst: true })
      .order("approved_at", { ascending: true });
    if (error) { toast("שגיאה בטעינת המאושרות: " + error.message, true); return; }
    const next = nextDeliveryDay();
    const isStanding = o => !!o.standing_id || o.source === "קבועה";
    const now = data.filter(o => !o.delivery_date || o.delivery_date <= next);
    const later = data.filter(o => o.delivery_date && o.delivery_date > next);
    const nowSorted = [...now.filter(o => !isStanding(o)), ...now.filter(isStanding)];
    state.approved = data;

    const row = (o, cls) => {
      const st = isStanding(o);
      const items = (o.order_lines || []).map(l => `${esc(l.product?.name)} <b>×${num(l.quantity)}</b>`).join(" · ");
      return `<tr data-id="${o.order_id}" class="${cls}${st ? " is-standing" : ""}">
        <td class="num">${o.order_id}</td>
        <td class="cust"><strong>${esc(o.customers?.name)}</strong>${st ? ` <span class="tag tag-standing">הזמנה קבועה</span>` : sourceTag(o.source)}${o.notes ? `<br><small class="muted">${esc(o.notes)}</small>` : ""}</td>
        <td>${o.delivery_date ? esc(fmtDate(o.delivery_date)) : "לא צוין"}</td>
        <td class="items-cell">${items}</td>
        <td class="num">${num(orderTotalPacks(o))}</td>
        <td class="muted small">${o.approved_at ? esc(ago(o.approved_at)) : ""}</td>
        <td><div class="row-btns">
          <button type="button" class="btn btn-sm" data-edit-order="${o.order_id}">עריכה</button>
          ${st ? "" : `<button type="button" class="btn btn-sm" data-unapprove="${o.order_id}">החזר לאישור</button>`}
          <button type="button" class="btn btn-sm btn-link-danger" data-cancel-approved="${o.order_id}">${st ? "דלג הפעם" : "ביטול"}</button>
        </div></td>
      </tr>`;
    };
    $("#approvedBody").innerHTML = nowSorted.length
      ? `<tr class="group-row"><td colspan="7">לאספקה ב${esc(fmtDate(next))} · נשלחות לקילוף בלחיצה על "שלח לקילוף"</td></tr>` + nowSorted.map(o => row(o, "")).join("")
      : "";
    $("#approvedEmpty").hidden = nowSorted.length > 0;
    // לימים הבאים: טבלה נפרדת, עמומה, מתחת לקו מפריד
    $("#laterBlock").hidden = !later.length;
    $("#laterCount").textContent = later.length ? `(${later.length})` : "";
    $("#laterBody").innerHTML = later.map(o => row(o, "later")).join("");
    $("#approvedCount").textContent = `${now.length} לאספקה ב${fmtDate(next)}${later.length ? ` · ${later.length} לימים הבאים` : ""}`;
    const nStanding = now.filter(isStanding).length;
    const rb = $("#releaseBtn");
    rb.disabled = !now.length;
    rb.textContent = now.length ? `שלח לקילוף (${now.length})` : "שלח לקילוף";
    const h = new Date().getHours();
    $("#approvedHint").textContent = (h < 12
      ? "הזמנות למחר מתקבלות עד 12:00. אחרי 12 לוחצים \"שלח לקילוף\" וכל הרשימה יורדת לטאבלט בבת אחת."
      : "עברה השעה 12:00 — אפשר לשלוח לקילוף.") + (nStanding ? ` כולל ${nStanding} הזמנות קבועות.` : "");
  }

  $("#releaseBtn").addEventListener("click", async () => {
    const n = (state.approved || []).filter(o => !o.delivery_date || o.delivery_date <= nextDeliveryDay()).length;
    if (!n || !confirm(`לשלוח לקילוף ${n} הזמנות לאספקה ב${fmtDate(nextDeliveryDay())}?\nהן יופיעו בטאבלט מיד.`)) return;
    const rb = $("#releaseBtn"); rb.disabled = true; rb.textContent = "מעביר…";
    const { data, error } = await db.rpc("release_to_production");
    if (error) { toast("השליחה לקילוף נכשלה: " + error.message, true); await loadApproved(); return; }
    toast(`${data.released} הזמנות נשלחו לקילוף` + (data.standing ? ` (מתוכן ${data.standing} קבועות)` : ""));
    await Promise.all([loadCounts(), loadPending()]);
  });

  async function onApprovedClick(e) {
    const u = e.target.closest("[data-unapprove]"), c = e.target.closest("[data-cancel-approved]");
    if (!u && !c) return;
    const id = Number(u ? u.dataset.unapprove : c.dataset.cancelApproved);
    const o = (state.approved || []).find(x => x.order_id === id);
    const standing = o && (o.standing_id || o.source === "קבועה");
    if (c && !confirm(standing ? `לדלג על ההזמנה הקבועה של ${o.customers?.name || ""} הפעם? (ההזמנה הקבועה עצמה נשארת)` : `לבטל את הזמנה ${id}?`)) return;
    (u || c).disabled = true;
    const ok = await setStatus(id, u ? PENDING : "בוטלה");
    if (ok) toast(u ? `הזמנה ${id} חזרה לאישור` : standing ? `דילגנו על הזמנה ${id}` : `הזמנה ${id} בוטלה`);
    await Promise.all([loadCounts(), loadPending()]);
  }
  $("#approvedBody").addEventListener("click", onApprovedClick);
  $("#laterBody").addEventListener("click", onApprovedClick);

  $("#approveAll").addEventListener("click", async () => {
    const ids = state.pending.map(o => o.order_id);
    if (!ids.length || !confirm(`לאשר ${ids.length} הזמנות? הן יעברו לרשימת המאושרות.`)) return;
    $("#approveAll").disabled = true;
    const { data, error } = await db.from("orders").update({ status: APPROVED_ST }).in("order_id", ids).eq("status", PENDING).select("order_id");
    $("#approveAll").disabled = false;
    if (error) { toast("האישור נכשל: " + error.message, true); return; }
    toast(`${(data || []).length} הזמנות אושרו`);
    await Promise.all([loadCounts(), loadPending()]);
  });

  async function setStatus(id, status) {
    const { data, error } = await db.from("orders").update({ status }).eq("order_id", id).select("order_id");
    if (error || !data || !data.length) { toast("העדכון נכשל" + (error ? ": " + error.message : " (אין הרשאה)"), true); return false; }
    return true;
  }

  $("#pendingList").addEventListener("click", async e => {
    const a = e.target.closest("[data-approve]"), c = e.target.closest("[data-cancel]");
    if (!a && !c) return;
    const id = Number((a || c).dataset.approve || (a || c).dataset.cancel);
    if (c && !confirm(`לבטל את הזמנה ${id}?`)) return;
    (a || c).disabled = true;
    const ok = await setStatus(id, a ? APPROVED_ST : "בוטלה");
    if (ok) toast(a ? `הזמנה ${id} אושרה · ממתינה לקילוף` : `הזמנה ${id} בוטלה`);
    await Promise.all([loadCounts(), loadPending()]);
  });

  /* ==========================================================
     לשונית: לקוחות חדשים (פניות)
     ========================================================== */
  async function loadRequests() {
    loading(true);
    const { data, error } = await db.from("customer_requests")
      .select("request_id, created_at, kind, name, business, phone, city, notes, items, status")
      .eq("status", "חדשה")
      .order("created_at", { ascending: true });
    loading(false);
    if (error) { toast("שגיאה בטעינת פניות: " + error.message, true); return; }
    state.requests = data;
    $("#requestsEmpty").hidden = data.length > 0;
    $("#requestsList").innerHTML = data.map(r => `
      <article class="ocard" data-id="${r.request_id}">
        <header>
          <strong>${esc(r.business || r.name)}</strong>
          <span class="tag ${r.kind === "הזמנה" ? "tag-hot" : ""}">${esc(r.kind || "הזמנה")}</span>
          <span class="muted small">${ago(r.created_at)}</span>
        </header>
        <div class="ocard-body">
          <div class="meta">
            <div><span class="muted">איש קשר:</span> ${esc(r.name)}</div>
            <div><span class="muted">טלפון:</span> <a href="tel:${esc(r.phone)}"><bdi>${esc(r.phone)}</bdi></a></div>
            ${r.city ? `<div><span class="muted">עיר:</span> ${esc(r.city)}</div>` : ""}
            ${r.notes ? `<div class="note"><span class="muted">הערות:</span> ${esc(r.notes)}</div>` : ""}
          </div>
          ${Array.isArray(r.items) && r.items.length ? `<div class="items"><span class="muted">ביקש להזמין:</span><br>${requestItems(r.items)}</div>` : ""}
        </div>
        <footer>
          <button type="button" class="btn btn-primary" data-open="${r.request_id}">אישור ופתיחת לקוח</button>
          <a class="btn" href="tel:${esc(r.phone)}">התקשרות</a>
          <button type="button" class="btn btn-ghost" data-dismiss="${r.request_id}">לא רלוונטי</button>
        </footer>
      </article>`).join("");
  }
  const requestItems = items => items.map(i => `${esc(state.products.get(Number(i.pid)) || "מוצר " + i.pid)} × ${num(i.qty)}`).join("<br>");

  $("#requestsList").addEventListener("click", async e => {
    const o = e.target.closest("[data-open]"), d = e.target.closest("[data-dismiss]");
    if (o) { openCustomerModal(state.requests.find(r => r.request_id === Number(o.dataset.open))); return; }
    if (d) {
      if (!confirm("לסגור את הפנייה בלי לפתוח לקוח?")) return;
      const { error } = await db.from("customer_requests").update({ status: "טופלה" }).eq("request_id", Number(d.dataset.dismiss));
      if (error) { toast("שגיאה: " + error.message, true); return; }
      toast("הפנייה נסגרה");
      await Promise.all([loadCounts(), loadRequests()]);
    }
  });

  /* ----- חלון פתיחת לקוח ----- */
  function openCustomerModal(r) {
    if (!r) return;
    state.currentRequest = r;
    $("#custSub").textContent = `${r.kind === "רישום" ? "נרשם" : "ניסה להזמין"} מהאתר ${ago(r.created_at)}`;
    $("#cName").value = r.business || r.name;
    $("#cCategory").value = "פרטי";
    $("#cAdress").value = r.city ? `, ${r.city}` : "";
    $("#cPhone").value = r.phone;
    const hasItems = Array.isArray(r.items) && r.items.length;
    $("#cOrderBox").hidden = !hasItems;
    if (hasItems) { $("#cItems").innerHTML = requestItems(r.items); $("#cDate").value = nextDeliveryDay(); $("#cMakeOrder").checked = true; }
    $("#custError").textContent = "";
    $("#custModal").hidden = false;
    $("#cAdress").focus(); $("#cAdress").setSelectionRange(0, 0);
  }
  function closeModal() { $("#custModal").hidden = true; state.currentRequest = null; }
  $("#custModal").addEventListener("click", e => { if (e.target.id === "custModal" || e.target.closest("[data-close-modal]")) closeModal(); });
  document.addEventListener("keydown", e => {
    if (e.key !== "Escape") return;
    if (!$("#custModal").hidden) closeModal();
    if (!$("#editModal").hidden) closeEdit();
    if (!$("#orderModal").hidden) closeOrderEditor();
    if (!$("#movedModal").hidden) $("#movedModal").hidden = true;
  });
  $("#movedModal").addEventListener("click", e => {
    if (e.target.id === "movedModal" || e.target.closest("[data-close-moved]") || e.target.closest("#movedGo")) $("#movedModal").hidden = true;
  });

  /* ==========================================================
     ניהול לקוחות: רשימת כל הלקוחות + עריכת כרטיס
     ========================================================== */
  async function loadCustomers() {
    loading(true);
    const [{ data, error }] = await Promise.all([
      db.from("customers")
        .select("customer_id, name, customer_category, adress, phone_number, hash_key, created_at")
        .order("name"),
      loadStanding()
    ]);
    loading(false);
    if (error) { toast("שגיאה בטעינת לקוחות: " + error.message, true); return; }
    state.customers = data;
    renderCustomers();
  }
  function renderCustomers() {
    // חיפוש: שם (גם חלקי), מספר לקוח (#12 או 12), טלפון, כתובת או מפתח חשבשבת
    const q = $("#custSearch").value.trim().toLowerCase().replace(/^#\s*/, ""), f = $("#custFilter").value;
    const isNum = /^\d+$/.test(q);
    const hit = c => !q
      || (isNum && (String(c.customer_id).startsWith(q) || (q.length >= 4 && (c.phone_number || "").includes(q))))
      || [c.name, c.adress, c.hash_key].some(v => String(v || "").toLowerCase().includes(q));
    const list = state.customers.filter(c => hit(c) && (!f || (f === "nokey" ? !c.hash_key : c.customer_category === f)));
    if (isNum) list.sort((a, b) => (String(b.customer_id) === q) - (String(a.customer_id) === q));
    $("#custCount").textContent = `(${list.length} מתוך ${state.customers.length})`;
    $("#custEmpty").hidden = list.length > 0;
    $("#custBody").innerHTML = list.map(c => `<tr data-id="${c.customer_id}">
      <td class="num">${c.customer_id}</td>
      <td class="cust"><strong>${esc(c.name)}</strong></td>
      <td>${esc(c.customer_category || "")}</td>
      <td class="num"><a href="tel:${esc(c.phone_number)}"><bdi>${esc(c.phone_number || "")}</bdi></a></td>
      <td>${esc(c.adress || "")}</td>
      <td class="hash-key${c.hash_key ? "" : " fallback"}">${c.hash_key ? esc(c.hash_key) : "—"}</td>
      <td class="num muted">${c.created_at ? esc(new Date(c.created_at).toLocaleDateString("he-IL")) : ""}</td>
      <td><div class="row-btns"><button type="button" class="btn btn-sm" data-edit="${c.customer_id}">עריכה</button><button type="button" class="btn btn-sm" data-new-order="${c.customer_id}">+ הזמנה</button>${standingBtn(c.customer_id)}</div></td>
    </tr>`).join("");
  }
  ["#custSearch", "#custFilter"].forEach(s => $(s).addEventListener("input", renderCustomers));
  $("#custSearch").addEventListener("keydown", e => { if (e.key === "Escape") { e.target.value = ""; renderCustomers(); } });
  $("#custBody").addEventListener("click", e => {
    const b = e.target.closest("[data-standing]"); if (!b) return;
    openStanding(Number(b.dataset.standing));
  });
  $("#custBody").addEventListener("click", e => {
    const b = e.target.closest("[data-edit]"); if (!b) return;
    const c = state.customers.find(x => x.customer_id === Number(b.dataset.edit)); if (!c) return;
    state.editing = c;
    $("#editSub").textContent = `לקוח מספר ${c.customer_id}`;
    $("#eName").value = c.name || ""; $("#eCategory").value = c.customer_category || "פרטי";
    $("#eAdress").value = c.adress || ""; $("#ePhone").value = c.phone_number || ""; $("#eHash").value = c.hash_key || "";
    $("#editError").textContent = ""; $("#editModal").hidden = false; $("#eName").focus();
  });
  function closeEdit() { $("#editModal").hidden = true; state.editing = null; }
  $("#editModal").addEventListener("click", e => { if (e.target.id === "editModal" || e.target.closest("[data-close-edit]")) closeEdit(); });
  $("#editForm").addEventListener("submit", async e => {
    e.preventDefault();
    const c = state.editing; if (!c) return;
    const name = $("#eName").value.trim(), adress = $("#eAdress").value.trim();
    let phone = $("#ePhone").value.replace(/\D/g, ""); if (phone.startsWith("972")) phone = "0" + phone.slice(3);
    if (!name || adress.length < 3) { $("#editError").textContent = "צריך שם וכתובת אספקה"; return; }
    if (!/^0\d{8,9}$/.test(phone)) { $("#editError").textContent = "מספר טלפון לא תקין"; return; }
    if (phone !== c.phone_number && state.customers.some(x => x.phone_number === phone && x.customer_id !== c.customer_id)) {
      $("#editError").textContent = "הטלפון הזה כבר שייך ללקוח אחר"; return;
    }
    const upd = { name, customer_category: $("#eCategory").value, adress, phone_number: phone, hash_key: $("#eHash").value.trim() || null };
    $("#editSave").disabled = true;
    const { data, error } = await db.from("customers").update(upd).eq("customer_id", c.customer_id).select("customer_id");
    $("#editSave").disabled = false;
    if (error || !data || !data.length) { $("#editError").textContent = "השמירה נכשלה" + (error ? ": " + error.message : ""); return; }
    Object.assign(c, upd); closeEdit(); renderCustomers(); loadCounts();
    toast(`כרטיס הלקוח ${name} עודכן`);
  });

  $("#custForm").addEventListener("submit", async e => {
    e.preventDefault();
    const r = state.currentRequest; if (!r) return;
    const name = $("#cName").value.trim(), adress = $("#cAdress").value.trim().replace(/^,\s*/, "");
    if (!name || adress.length < 3) { $("#custError").textContent = "צריך שם וכתובת אספקה"; return; }
    $("#custSave").disabled = true; $("#custError").textContent = "";

    // 1. כרטיס לקוח חדש
    const { data: cust, error: e1 } = await db.from("customers")
      .insert({ name, customer_category: $("#cCategory").value, adress, phone_number: r.phone, hash_key: $("#cHash").value.trim() || null })
      .select("customer_id").single();
    if (e1) { $("#custSave").disabled = false; $("#custError").textContent = "שגיאה בפתיחת הלקוח: " + e1.message; return; }

    // 2. סגירת הפנייה וקישור ללקוח
    await db.from("customer_requests").update({ status: "טופלה", customer_id: cust.customer_id }).eq("request_id", r.request_id);

    // 3. אם ביקש מוצרים: יצירת הזמנה דרך אותה פונקציה של האתר (המחיר מחושב בשרת)
    let msg = `נפתח לקוח: ${name}`, movedId = null;
    if (!$("#cOrderBox").hidden && $("#cMakeOrder").checked) {
      const { data: res, error: e2 } = await db.rpc("place_order", {
        p_name: r.name, p_phone: r.phone, p_business: r.business || "", p_city: r.city || "",
        p_delivery_date: $("#cDate").value, p_notes: r.notes || "", p_items: r.items
      });
      if (e2) msg += ` · ההזמנה לא נוצרה: ${e2.message}`;
      else if (res && res.result === "order") movedId = res.order_id;
    }
    $("#custSave").disabled = false;
    closeModal();
    if (movedId) {
      // הלקוח אושר, וההזמנה שלו עוברת למודול ההזמנות (ממתינה לאישור)
      $("#movedText").textContent = `הלקוח ${name} נפתח, והזמנה ${movedId} מחכה לאישור בניהול הזמנות.`;
      $("#movedModal").hidden = false; $("#movedGo").focus();
    } else toast(msg);
    $("#cHash").value = "";
    await Promise.all([loadCounts(), loadRequests()]);
  });

  /* ==========================================================
     לשונית: הזמנות לפי יום
     ========================================================== */
  async function loadDay() {
    $("#dayInput").value = state.day;
    const dl = new Date(state.day + "T12:00:00").toLocaleDateString("he-IL", { weekday: "long", day: "numeric", month: "long" });
    $("#dayLabel").textContent = state.dayMode === "delivery" ? `אספקה ב${dl}` : `התקבלו ב${dl}`;
    $("#dayDateCol").textContent = state.dayMode === "delivery" ? "התקבלה" : "אספקה";
    $$(".dm-btn").forEach(b => b.classList.toggle("is-active", b.dataset.mode === state.dayMode));
    loading(true);
    const [from, to] = dayRange(state.day);
    let q = db.from("orders")
      .select(`order_id, order_date, delivery_date, status, source, adress, driver_id, notes, started_at,
               customers ( name, phone_number ),
               drivers ( name ),
               order_lines ( quantity, product ( name ) )`);
    q = state.dayMode === "delivery" ? q.eq("delivery_date", state.day) : q.gte("order_date", from).lt("order_date", to);
    const { data, error } = await q.order("order_date");
    loading(false);
    if (error) { toast("שגיאה בטעינת הזמנות: " + error.message, true); return; }
    state.orders = data;
    renderDay();
  }

  async function jumpToLastDay() {
    const col = state.dayMode === "delivery" ? "delivery_date" : "order_date";
    let q = db.from("orders").select(col);
    if (col === "delivery_date") q = q.not("delivery_date", "is", null);
    const { data, error } = await q.order(col, { ascending: false }).limit(1);
    if (error || !data.length) { toast("לא נמצאו הזמנות", true); return; }
    state.day = col === "delivery_date" ? data[0].delivery_date : toISO(new Date(data[0].order_date));
    loadDay();
  }

  function filtered() {
    const q = $("#searchInput").value.trim(), st = $("#statusFilter").value, dr = $("#driverFilter").value;
    return state.orders.filter(o =>
      (!q || (o.customers?.name || "").includes(q)) &&
      (!st || o.status === st) &&
      (!dr || (dr === "none" ? !o.driver_id : String(o.driver_id) === dr)));
  }

  function renderDay() {
    const active = state.orders.filter(o => o.status !== "בוטלה");
    $("#dayCount").textContent = `(${active.length})`;

    const pick = {};
    active.forEach(o => (o.order_lines || []).forEach(l => { const n = l.product?.name || "?"; pick[n] = (pick[n] || 0) + Number(l.quantity); }));
    $("#pickBody").innerHTML = Object.entries(pick).sort((a, b) => b[1] - a[1])
      .map(([n, q]) => `<tr><td>${esc(n)}</td><td>${num(q)}</td></tr>`).join("") || `<tr><td class="muted">אין</td></tr>`;

    const byDriver = {};
    active.forEach(o => { const n = o.drivers?.name || "בלי נהג"; byDriver[n] = (byDriver[n] || 0) + 1; });
    $("#driverBody").innerHTML = Object.entries(byDriver).sort((a, b) => b[1] - a[1])
      .map(([n, c]) => `<tr><td>${esc(n)}</td><td>${c}</td></tr>`).join("") || `<tr><td class="muted">אין</td></tr>`;

    $("#emptyState").hidden = state.orders.length > 0;
    $("#ordersBody").innerHTML = filtered().map(o => {
      const when = state.dayMode === "delivery"
        ? new Date(o.order_date).toLocaleString("he-IL", { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" })
        : (o.delivery_date ? fmtDate(o.delivery_date) : "—");
      const driverOpts = `<option value="">—</option>` + state.drivers.map(d =>
        `<option value="${d.driver_id}" ${d.driver_id === o.driver_id ? "selected" : ""}>${esc(d.name)}</option>`).join("");
      const statusOpts = STATUSES.map(s => `<option ${s === o.status ? "selected" : ""}>${s}</option>`).join("");
      const stage = o.status === "בייצור" ? `<small class="st-sub">${o.started_at ? "בקילוף" : "ממתינה בטאבלט"}</small>` : o.status === APPROVED_ST ? `<small class="st-sub">ממתינה ל"שלח לקילוף"</small>` : "";
      const editable = EDITABLE.includes(o.status);
      return `<tr data-id="${o.order_id}" class="${o.status === "בוטלה" ? "cancelled" : ""}">
        <td class="num muted">${o.order_id}</td>
        <td class="cust"><strong>${esc(o.customers?.name)}</strong>${sourceTag(o.source)}<small>${esc(o.adress || "")}</small>${o.notes ? `<small class="note">${esc(o.notes)}</small>` : ""}</td>
        <td class="items">${itemsText(o.order_lines)}</td>
        <td class="num"><bdi>${esc(when)}</bdi></td>
        <td><select data-field="driver_id" aria-label="נהג להזמנה ${o.order_id}">${driverOpts}</select></td>
        <td><select data-field="status" class="st" data-st="${esc(o.status)}" aria-label="סטטוס להזמנה ${o.order_id}">${statusOpts}</select>${stage}</td>
        <td>${editable ? `<button type="button" class="btn btn-sm" data-edit-order="${o.order_id}">עריכה</button>` : ""}</td>
      </tr>`;
    }).join("");
    $("#emptyState").querySelector("p").textContent = state.dayMode === "delivery" ? "אין הזמנות לאספקה ביום הזה." : "לא התקבלו הזמנות ביום הזה.";
  }

  $("#ordersBody").addEventListener("change", async e => {
    const sel = e.target.closest("select[data-field]"); if (!sel) return;
    const tr = sel.closest("tr"), id = Number(tr.dataset.id), field = sel.dataset.field;
    const value = field === "driver_id" ? (sel.value ? Number(sel.value) : null) : sel.value;
    const order = state.orders.find(o => o.order_id === id), old = order[field];
    tr.classList.add("saving");
    const { data, error } = await db.from("orders").update({ [field]: value }).eq("order_id", id).select("order_id");
    tr.classList.remove("saving");
    if (error || !data || !data.length) { toast("העדכון נכשל" + (error ? ": " + error.message : " (אין הרשאה)"), true); sel.value = old ?? ""; return; }
    order[field] = value;
    if (field === "driver_id") order.drivers = value ? { name: state.drivers.find(d => d.driver_id === value)?.name } : null;
    toast(field === "status" ? `הזמנה ${id}: ${value}` : `הזמנה ${id}: נהג עודכן`);
    renderDay(); loadCounts();
  });

  /* ==========================================================
     זמן אמת: ערוץ admin (טריגרים orders_notify, requests_notify)
     + בדיקת גיבוי כל דקה, למקרה שהחיבור נפל
     ========================================================== */
  function setLive(on) { const d = $("#liveDot"); d.classList.toggle("on", on); d.textContent = on ? "מחובר" : "מנותק"; }

  async function startRealtime(session) {
    stopRealtime();
    try { await db.realtime.setAuth(session.access_token); } catch (_) {}
    state.channel = db.channel("admin", { config: { private: true } })
      .on("broadcast", { event: "order_changed" }, ({ payload }) => onOrderEvent(payload || {}))
      .on("broadcast", { event: "request_new" }, () => onRequestEvent())
      .subscribe(status => setLive(status === "SUBSCRIBED"));
    // ערוץ הייצור: כל סימון בטאבלט מרענן את לשונית "פס ייצור"
    const onProd = () => {
      if (state.tab !== "production" || state.module !== "orders") return;
      clearTimeout(state.prodTimer); state.prodTimer = setTimeout(loadProduction, 400);
    };
    state.prodChannel = db.channel("production", { config: { private: true } })
      .on("broadcast", { event: "order_changed" }, onProd)
      .on("broadcast", { event: "detail_changed" }, onProd)
      .on("broadcast", { event: "order_edited" }, onProd)
      .subscribe();
  }
  function stopRealtime() {
    if (state.channel) { db.removeChannel(state.channel); state.channel = null; }
    if (state.prodChannel) { db.removeChannel(state.prodChannel); state.prodChannel = null; }
    setLive(false);
  }

  let refreshTimer;
  function scheduleRefresh() { clearTimeout(refreshTimer); refreshTimer = setTimeout(() => { loadCounts(); if (state.module !== "home") refreshTab(); }, 400); }

  function onOrderEvent(p) {
    if (p.op === "INSERT" && p.status === PENDING) notify("הזמנה חדשה", `הזמנה ${p.order_id} ממתינה לאישור`);
    else if (p.status === "הוכנה" && p.old_status === "בייצור") toast(`הזמנה ${p.order_id} הוכנה`);
    scheduleRefresh();
  }
  function onRequestEvent() { notify("לקוח חדש", "מישהו נרשם או ניסה להזמין מהאתר"); scheduleRefresh(); }

  setInterval(async () => {
    if ($("#appView").hidden) return;
    const prev = await loadCounts();
    if (state.counts.pending > prev.pending || state.counts.requests > prev.requests) {
      if (!state.channel || !$("#liveDot").classList.contains("on")) { beep(); if (state.module !== "home") refreshTab(); }
    }
  }, 60000);

  /* ==========================================================
     לשונית: גרפים (נתונים מ-dashboard_stats בשרת)
     ========================================================== */
  state.statDays = 30;
  const dayNames = ["א׳", "ב׳", "ג׳", "ד׳", "ה׳", "ו׳", "ש׳"];

  async function loadStats() {
    loading(true);
    const { data, error } = await db.rpc("dashboard_stats", { p_days: state.statDays });
    loading(false);
    if (error) { toast("שגיאה בטעינת הגרפים: " + error.message, true); return; }
    $("#statRange").textContent = `${fmtShort(data.from)} – ${fmtShort(data.to)}`;
    renderByDay(data.by_day || []);
    renderHBars("#chartTop", (data.top_products || []).map(r => ({ label: r.name, value: Number(r.qty) })), "מארזים");
    const totalSrc = (data.by_source || []).reduce((s, r) => s + Number(r.orders), 0) || 1;
    renderHBars("#chartSource", (data.by_source || []).map(r => ({ label: r.source, value: Number(r.orders), pct: Math.round(100 * r.orders / totalSrc) })), "הזמנות");
  }
  const fmtShort = iso => { const [, m, d] = String(iso).split("-"); return `${+d}.${+m}`; };

  function renderByDay(rows) {
    const max = Math.max(1, ...rows.map(r => r.orders));
    const total = rows.reduce((s, r) => s + r.orders, 0);
    const days = rows.filter(r => r.orders > 0).length || 1;
    $("#byDaySum").textContent = `סה״כ ${num(total)} הזמנות · ממוצע ${num(total / days)} ביום עבודה`;
    const step = rows.length > 45 ? 14 : rows.length > 10 ? 5 : 1;
    $("#chartByDay").innerHTML = `<span class="vbars-max">${num(max)}</span>` + rows.map(r => {
      const d = new Date(r.day + "T12:00:00");
      const tip = `יום ${dayNames[d.getDay()]} ${fmtShort(r.day)} · <strong>${num(r.orders)}</strong> הזמנות`;
      return `<div class="vbar${r.orders ? "" : " zero"}${d.getDay() === 6 ? " wknd" : ""}" style="height:${r.orders ? Math.max(2, 100 * r.orders / max) : 100}%" tabindex="0" data-tip="${esc(tip)}"></div>`;
    }).join("");
    // תאריכים מתחת לעמודות: כל כמה ימים, והיום האחרון תמיד
    $("#chartByDayX").innerHTML = rows.map((r, i) => {
      const show = i === rows.length - 1 || (rows.length - 1 - i) % step === 0;
      return `<span class="${show ? "lab" : ""}">${show ? fmtShort(r.day) : ""}</span>`;
    }).join("");
  }

  function renderHBars(sel, rows, unit) {
    const max = Math.max(1, ...rows.map(r => r.value));
    $(sel).innerHTML = rows.length ? rows.map(r => `
      <div class="hrow" data-tip="${esc(esc(r.label))} · <strong>${num(r.value)}</strong> ${unit}${r.pct != null ? ` (<bdi>${r.pct}%</bdi>)` : ""}">
        <span class="lbl" title="${esc(r.label)}">${esc(r.label)}</span>
        <span class="track"><span class="bar" style="width:${Math.max(1, 85 * r.value / max)}%"></span><span class="val"><bdi>${num(r.value)}</bdi>${r.pct != null ? ` · <bdi>${r.pct}%</bdi>` : ""}</span></span>
      </div>`).join("") : `<p class="muted">אין נתונים בתקופה הזו</p>`;
  }

  /* טולטיפ אחד לכל הגרפים */
  function showTip(el, x, y) {
    const tip = $("#chartTip"); tip.innerHTML = el.dataset.tip; tip.hidden = false;
    const w = tip.offsetWidth, h = tip.offsetHeight;
    tip.style.left = Math.min(window.innerWidth - w - 8, Math.max(8, x - w / 2)) + "px";
    tip.style.top = Math.max(8, y - h - 12) + "px";
  }
  document.addEventListener("mouseover", e => { const el = e.target.closest("#view-stats [data-tip]"); if (el) { const r = el.getBoundingClientRect(); showTip(el, r.left + r.width / 2, r.top); } });
  document.addEventListener("mouseout", e => { if (e.target.closest("#view-stats [data-tip]")) $("#chartTip").hidden = true; });
  document.addEventListener("focusin", e => { const el = e.target.closest("#view-stats [data-tip]"); if (el) { const r = el.getBoundingClientRect(); showTip(el, r.left + r.width / 2, r.top); } });
  document.addEventListener("focusout", () => { $("#chartTip").hidden = true; });

  $$("#view-stats .seg-btn").forEach(b => b.addEventListener("click", () => {
    $$("#view-stats .seg-btn").forEach(x => x.classList.toggle("is-active", x === b));
    state.statDays = Number(b.dataset.days); loadStats();
  }));

  /* ==========================================================
     לשונית: חשבשבת — הזמנת לקוח (מסמך 30)
     אקסל: קובץ קריא להקלדה. קובץ קליטה: IMOVEIN.DOC ברוחב קבוע, בקידוד Windows-1255,
     יחד עם IMOVEIN.PRM שמגדיר איפה כל שדה נמצא בשורה.
     ========================================================== */
  const VAT = 18;                 // % מע"מ
  const HASH_DOC_TYPE = 30;       // הזמנה מלקוח
  const APPROVED = [APPROVED_ST, "בייצור", "הוכנה", "בדרך", "נמסרה"];
  state.hashDate = "";
  state.hashOrders = [];

  const custKey = c => (c?.hash_key || String(c?.customer_id ?? "")).trim();
  const itemKey = p => (p?.hash_key || String(p?.product_id ?? "")).trim();
  const lineTotal = l => Number(l.quantity) * Number(l.unit_price || 0);
  const orderNet = o => (o.order_lines || []).reduce((s, l) => s + lineTotal(l), 0);
  const money = n => new Intl.NumberFormat("he-IL", { style: "currency", currency: "ILS", minimumFractionDigits: 2 }).format(n || 0);
  const ddmmyyyy = v => { const d = new Date(v.length === 10 ? v + "T12:00:00" : v); return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`; };

  async function loadHash() {
    if (!state.hashDate) state.hashDate = nextDeliveryDay();
    $("#hashDate").value = state.hashDate;
    loading(true);
    let q = db.from("orders")
      .select(`order_id, order_date, delivery_date, status, adress, notes, hash_exported_at,
               customers ( customer_id, name, phone_number, adress, hash_key ),
               drivers ( name ),
               order_lines ( quantity, unit_price, product ( product_id, name, unit, hash_key ) )`)
      .eq("delivery_date", state.hashDate).in("status", APPROVED).order("order_id");
    if ($("#hashOnlyNew").checked) q = q.is("hash_exported_at", null);
    const { data, error } = await q;
    loading(false);
    if (error) { toast("שגיאה בטעינה: " + error.message, true); return; }
    state.hashOrders = data;
    $("#hashEmpty").hidden = data.length > 0;
    $("#hashBody").innerHTML = data.map(o => {
      const c = o.customers || {};
      return `<tr data-id="${o.order_id}">
        <td class="num">${o.order_id}</td>
        <td class="cust"><strong>${esc(c.name)}</strong><small>${esc(o.adress || c.adress || "")}</small></td>
        <td class="hash-key${c.hash_key ? "" : " fallback"}" title="${c.hash_key ? "" : "אין מפתח חשבשבת ללקוח, משתמשים במספר הלקוח שלנו"}">${esc(custKey(c))}</td>
        <td class="items">${itemsText(o.order_lines)}</td>
        <td class="num">${money(orderNet(o))}</td>
        <td>${esc(o.status)}</td>
        <td>${o.hash_exported_at ? `<span class="exp-yes" title="${esc(fmtTime(o.hash_exported_at))}">✓ יוצא</span>` : `<span class="exp-no">עוד לא</span>`}</td>
        <td><div class="row-btns"><button type="button" class="btn btn-sm" data-hx="${o.order_id}">אקסל</button><button type="button" class="btn btn-sm" data-hd="${o.order_id}">קליטה</button></div></td>
      </tr>`;
    }).join("");
    const net = data.reduce((s, o) => s + orderNet(o), 0);
    $("#hashTotals").textContent = data.length
      ? `${data.length} הזמנות · לפני מע״מ ${money(net)} · מע״מ ${VAT}% ${money(net * VAT / 100)} · כולל מע״מ ${money(net * (1 + VAT / 100))}`
      : "";
  }

  /* ---------- אקסל (SheetJS נטען רק כשצריך) ---------- */
  let xlsxReady;
  function loadXlsx() {
    if (window.XLSX) return Promise.resolve();
    xlsxReady = xlsxReady || new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";
      s.integrity = "sha384-vtjasyidUo0kW94K5MXDXntzOJpQgBKXmE7e2Ga4LG0skTTLeBi97eFAXsqewJjw"; // אם הקובץ ב-CDN ישתנה, הדפדפן יסרב להריץ אותו
      s.crossOrigin = "anonymous";
      s.onload = res; s.onerror = () => { xlsxReady = null; rej(new Error("טעינת ספריית האקסל נכשלה")); };
      document.head.appendChild(s);
    });
    return xlsxReady;
  }

  async function exportXlsx(orders, name) {
    await loadXlsx();
    const X = window.XLSX;
    const head = orders.map(o => {
      const c = o.customers || {}, net = orderNet(o);
      return {
        "מס׳ הזמנה שלנו (אסמכתא 2)": o.order_id, "סוג מסמך": `${HASH_DOC_TYPE} - הזמנה מלקוח`,
        "מפתח לקוח": custKey(c), "שם לקוח": c.name || "", "כתובת": o.adress || c.adress || "", "טלפון": c.phone_number || "",
        "תאריך הזמנה": ddmmyyyy(o.order_date), "תאריך אספקה": o.delivery_date ? ddmmyyyy(o.delivery_date) : "",
        "נהג": o.drivers?.name || "", "הערות": o.notes || "",
        "סה״כ לפני מע״מ": +net.toFixed(2), [`מע״מ ${VAT}%`]: +(net * VAT / 100).toFixed(2), "סה״כ כולל מע״מ": +(net * (1 + VAT / 100)).toFixed(2)
      };
    });
    const lines = [];
    orders.forEach(o => (o.order_lines || []).forEach(l => lines.push({
      "מס׳ הזמנה שלנו (אסמכתא 2)": o.order_id, "מפתח לקוח": custKey(o.customers), "שם לקוח": o.customers?.name || "",
      "תאריך אספקה": o.delivery_date ? ddmmyyyy(o.delivery_date) : "",
      "מפתח פריט": itemKey(l.product), "שם פריט": l.product?.name || "", "יחידה": l.product?.unit || "",
      "כמות": Number(l.quantity), "מחיר ליחידה": Number(l.unit_price || 0), "סה״כ שורה": +lineTotal(l).toFixed(2)
    })));
    const help = [
      ["איך מקלידים בחשבשבת"],
      [`1. בחשבשבת: מסמכים ← הזמנה מלקוח (סוג ${HASH_DOC_TYPE}).`],
      ["2. מפתח לקוח ותאריך אספקה מגיליון 'הזמנות'. את 'אסמכתא' חשבשבת ממלאת לבד (מספר המסמך שלה)."],
      ["3. את מספר ההזמנה שלנו רושמים בשדה 'אסמכתא 2' (ואם אין כזה בטופס: בשדה 'פרטים')."],
      ["4. את הפריטים מקלידים מגיליון 'שורות' (מסננים לפי מספר ההזמנה), בודקים סה״כ, ולוחצים הפקה."],
      ["המחירים לפני מע״מ. מפתח לקוח/פריט אפור במערכת = עוד לא הוגדר מפתח חשבשבת, ומופיע המספר שלנו."]
    ];
    const wb = X.utils.book_new();
    wb.Workbook = { Views: [{ RTL: true }] };
    const ws1 = X.utils.json_to_sheet(head), ws2 = X.utils.json_to_sheet(lines), ws3 = X.utils.aoa_to_sheet(help);
    ws1["!cols"] = [10, 16, 10, 24, 28, 13, 12, 12, 12, 30, 13, 11, 14].map(w => ({ wch: w }));
    ws2["!cols"] = [10, 10, 24, 12, 10, 28, 14, 8, 11, 11].map(w => ({ wch: w }));
    ws3["!cols"] = [{ wch: 90 }];
    X.utils.book_append_sheet(wb, ws1, "הזמנות");
    X.utils.book_append_sheet(wb, ws2, "שורות");
    X.utils.book_append_sheet(wb, ws3, "הוראות");
    X.writeFile(wb, name);
  }

  /* ---------- קובץ קליטה IMOVEIN ---------- */
  // שורות 2 ומעלה בקובץ ה-PRM, לפי מפרט "ממשק קלט תנועות מלאי (מסמכים)". רוחב 0 = שדה שלא בשימוש.
  const IMOVEIN_FIELDS = [
    ["custKey", 15, "t"], ["docNo", 0], ["docType", 2, "n"], ["custName", 50, "t"], ["address", 50, "t"], ["city", 0],
    ["ref", 9, "n"], ["refDate", 10, "t"], ["valDate", 10, "t"], ["agent", 0], ["store", 0], ["details", 50, "t"],
    ["srcStore", 0], ["srcAgent", 0], ["priceList", 0], ["discount", 0], ["vatPct", 0], ["copies", 0], ["cur", 0], ["rate", 0],
    ["itemKey", 20, "t"], ["qty", 10, "q"], ["price", 10, "q"], ["lineCur", 0], ["lineDisc", 0], ["lineRate", 0],
    ["itemName", 50, "t"], ["unit", 0], ["purchTax", 0], ["altKey", 0], ["commission", 0], ["packs", 0], ["vatFree", 0],
    ["phone", 30, "t"]
  ];
  function prmText() {
    let pos = 1; const out = [];
    IMOVEIN_FIELDS.forEach(([, w]) => { if (w) { out.push(`${pos} ${pos + w - 1}`); pos += w; } else out.push("0 0"); });
    return [String(pos - 1), ...out].join("\r\n") + "\r\n";
  }
  // מקודד ל-Windows-1255 (עברית בחשבשבת). תו שלא קיים בקידוד הופך לרווח.
  function cp1255(str) {
    const bytes = [];
    for (const ch of str) {
      const c = ch.codePointAt(0);
      if (c < 128) bytes.push(c);
      else if (c >= 0x05D0 && c <= 0x05EA) bytes.push(c - 0x05D0 + 0xE0);
      else if (c === 0x05F4 || c === 0x201C || c === 0x201D) bytes.push(0x22);
      else if (c === 0x05F3 || c === 0x2018 || c === 0x2019) bytes.push(0x27);
      else if (c === 0x2013 || c === 0x2014) bytes.push(0x2D);
      else if (c === 0x20AA) bytes.push(0xA4);
      else bytes.push(0x20);
    }
    return new Uint8Array(bytes);
  }
  const clean = s => String(s ?? "").replace(/[\r\n\t]+/g, " ").trim();
  function fit(v, w, kind) {
    if (kind === "q") return Number(v || 0).toFixed(3).padStart(w, " ").slice(-w);
    if (kind === "n") return String(v ?? "").padStart(w, " ").slice(-w);
    return [...clean(v)].slice(0, w).join("").padEnd(w, " ");
  }
  function docText(orders) {
    const rows = [];
    orders.forEach(o => {
      const c = o.customers || {};
      (o.order_lines || []).forEach(l => {
        const v = {
          custKey: custKey(c), docType: HASH_DOC_TYPE, custName: c.name, address: o.adress || c.adress,
          ref: o.order_id, refDate: ddmmyyyy(o.order_date), valDate: o.delivery_date ? ddmmyyyy(o.delivery_date) : ddmmyyyy(o.order_date),
          details: o.notes || `הזמנה ${o.order_id} מהמערכת`, itemKey: itemKey(l.product), qty: l.quantity, price: l.unit_price,
          itemName: l.product?.name, phone: c.phone_number
        };
        rows.push(IMOVEIN_FIELDS.filter(f => f[1]).map(([k, w, kind]) => fit(v[k], w, kind)).join(""));
      });
    });
    return rows.join("\r\n") + "\r\n";
  }
  function download(bytes, name) {
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: name });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  async function markExported(orders) {
    const ids = orders.filter(o => !o.hash_exported_at).map(o => o.order_id);
    if (!ids.length) return;
    const { error } = await db.from("orders").update({ hash_exported_at: new Date().toISOString() }).in("order_id", ids);
    if (error) toast("הקובץ ירד, אבל הסימון 'יוצא' נכשל: " + error.message, true);
  }

  async function runExport(kind, orders) {
    if (!orders.length) { toast("אין הזמנות לייצוא", true); return; }
    const tag = orders.length === 1 ? `הזמנה_${orders[0].order_id}` : `אספקה_${state.hashDate}`;
    try {
      if (kind === "xlsx") await exportXlsx(orders, `חשבשבת_${tag}.xlsx`);
      else download(cp1255(docText(orders)), "IMOVEIN.DOC");
    } catch (err) { toast(err.message || "הייצוא נכשל", true); return; }
    await markExported(orders);
    toast(kind === "xlsx" ? `האקסל ירד (${orders.length} הזמנות)` : `קובץ הקליטה ירד (${orders.length} הזמנות)`);
    loadHash();
  }

  $("#hashDate").addEventListener("change", e => { if (e.target.value) { state.hashDate = e.target.value; loadHash(); } });
  $("#hashOnlyNew").addEventListener("change", loadHash);
  $("#hashXlsx").addEventListener("click", () => runExport("xlsx", state.hashOrders));
  $("#hashDoc").addEventListener("click", () => runExport("doc", state.hashOrders));
  $("#hashPrm").addEventListener("click", () => download(cp1255(prmText()), "IMOVEIN.PRM"));
  $("#hashBody").addEventListener("click", e => {
    const b = e.target.closest("[data-hx],[data-hd]"); if (!b) return;
    const id = Number(b.dataset.hx || b.dataset.hd);
    const o = state.hashOrders.find(x => x.order_id === id);
    if (o) runExport(b.dataset.hx ? "xlsx" : "doc", [o]);
  });

  /* ==========================================================
     לשונית: פס ייצור - מה שקורה בטאבלט, בזמן אמת
     (אותן פונקציות שהטאבלט משתמש בהן; למנהל יש הרשאה אליהן)
     ========================================================== */
  const KG = new Map((window.MK_PRODUCTS || []).map(p => [p.name, Number(p.kg) || 0]));
  const kgPer = (name, unit) => KG.get(name) || Number((String(unit || "").match(/(\d+(?:\.\d+)?)\s*ק/) || [])[1]) || 0;
  const hm = ts => new Date(ts).toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" });
  const isTodayTs = ts => ts && new Date(ts).toDateString() === new Date().toDateString();

  async function loadProduction() {
    const [q, d, pl] = await Promise.all([db.rpc("production_queue"), db.rpc("production_done", { p_days: 1 }), db.rpc("peel_status")]);
    if (q.error) { toast("שגיאה בטעינת פס הייצור: " + q.error.message, true); return; }
    const orders = q.data || [];
    orders.forEach(o => (o.items || []).forEach(i => { if (Number(i.kg) > 0) KG.set(i.product, Number(i.kg)); }));
    const done = (d.data || []).filter(o => isTodayTs(o.prepared_at)), peel = pl.data || [];
    const fresh = orders.filter(o => !o.started_at), prod = orders.filter(o => o.started_at);

    // סה"כ לקילוף
    const map = new Map();
    orders.forEach(o => (o.items || []).forEach(i => {
      const r = map.get(i.product) || { name: i.product, pid: i.product_id, unit: i.unit, packs: 0, kg: 0, split: 0 };
      const kg = Number(i.quantity) * kgPer(i.product, i.unit);
      r.packs += Number(i.quantity); r.kg += kg; if (o.started_at && i.prepared) r.split += kg;
      map.set(i.product, r);
    }));
    const peeled = new Map(peel.map(p => [Number(p.product_id), p]));
    const rows = [...map.values()].sort((a, b) => b.kg - a.kg);
    const totKg = rows.reduce((s, r) => s + r.kg, 0);
    const peeledKg = rows.reduce((s, r) => { const p = peeled.get(Number(r.pid)); return s + (p && r.kg <= Number(p.kg) + 0.001 ? r.kg : 0); }, 0);

    $("#prodSummary").innerHTML = `<b>${fresh.length}</b> ממתינות בטאבלט · <b>${prod.length}</b> בקילוף · <b>${done.length}</b> הוכנו היום · לקילוף <b>${num(totKg)} ק״ג</b>, מתוכם קולפו <b>${num(peeledKg)} ק״ג</b>`;
    $("#prodLive").textContent = prod.length || "";
    $("#prodUpdated").textContent = "עודכן " + hm(Date.now()) + " · מתעדכן לבד כשמשהו משתנה בטאבלט";

    const editBtn = id => `<button type="button" class="btn btn-sm" data-edit-order="${id}">עריכה</button>`;
    const due = o => o.delivery_date ? `אספקה ${esc(fmtDate(o.delivery_date))}` : "";
    const stTag = o => o.standing ? ` <span class="tag tag-standing">קבועה</span>` : "";
    $("#prodNew").innerHTML = fresh.map(o => `<article class="prod-card">
        <header><strong>${esc(o.customer_name)}${stTag(o)}</strong><span class="muted">#${o.order_id}</span></header>
        <div class="meta">אושרה ${esc(ago(o.approved_at))} · ${due(o)}</div>
        <ul>${(o.items || []).map(i => `<li><span>${esc(i.product)}</span><b>${num(i.quantity)}</b></li>`).join("")}</ul>
        <div class="acts">${editBtn(o.order_id)}</div>
      </article>`).join("") || `<p class="prod-empty">אין</p>`;
    $("#prodProd").innerHTML = prod.map(o => {
      const items = o.items || [], n = items.filter(i => i.prepared).length;
      return `<article class="prod-card">
        <header><strong>${esc(o.customer_name)}${stTag(o)}</strong><span class="muted">#${o.order_id}</span></header>
        <div class="meta">נקלטה ב-${esc(hm(o.started_at))} · ${due(o)} · ${n}/${items.length} מוצרים מוכנים</div>
        <div class="prod-bar"><span style="width:${items.length ? Math.round(100 * n / items.length) : 0}%"></span></div>
        <ul>${items.map(i => `<li class="${i.prepared ? "ok" : ""}"><span>${esc(i.product)}</span><b>${num(i.quantity)}</b></li>`).join("")}</ul>
        <div class="acts">${editBtn(o.order_id)}</div>
      </article>`;
    }).join("") || `<p class="prod-empty">אין</p>`;
    $("#prodDone").innerHTML = done.map(o => `<article class="prod-card">
        <header><strong>${esc(o.customer_name)}</strong><span class="muted">#${o.order_id}</span></header>
        <div class="meta">הוכנה ב-<b>${esc(hm(o.prepared_at))}</b>${o.started_at ? ` · נקלטה ${esc(hm(o.started_at))}` : ""} · ${esc(o.status)}</div>
      </article>`).join("") || `<p class="prod-empty">עוד לא הוכנו הזמנות היום</p>`;
    $("#prodPeel").innerHTML = rows.map(r => {
      const p = peeled.get(Number(r.pid)), ok = p && r.kg <= Number(p.kg) + 0.001;
      const added = p && !ok ? ` <span class="tag tag-hot">נוספו ${num(r.kg - Number(p.kg))} ק״ג</span>` : "";
      return `<tr class="${ok ? "done" : ""}"><td><strong>${esc(r.name)}</strong></td><td class="num">${num(r.packs)}</td><td class="num"><b>${num(r.kg)}</b></td>
        <td class="num">${r.kg ? Math.round(100 * r.split / r.kg) : 0}%</td>
        <td class="${ok ? "ok" : ""}">${ok ? `✓ ${esc(hm(p.done_at))}` : "—"}${added}</td></tr>`;
    }).join("") || `<tr><td colspan="5" class="muted">אין כרגע מה לקלף</td></tr>`;
  }

  /* ==========================================================
     עריכת הזמנה (update_order): כמויות, מוצרים, תאריך, הערות
     ========================================================== */
  state.edit = null;

  async function openOrderEditor(id) {
    loading(true);
    const { data: o, error } = await db.from("orders")
      .select(`order_id, status, delivery_date, notes, started_at, customer_id,
               customers ( name ),
               order_lines ( product_id, quantity, unit_price, prepared_at, product ( name, unit ) )`)
      .eq("order_id", id).single();
    loading(false);
    if (error || !o) { toast("לא הצלחתי לטעון את ההזמנה", true); return; }
    if (!EDITABLE.includes(o.status)) { toast(`אי אפשר לערוך הזמנה בסטטוס "${o.status}"`, true); return; }
    state.edit = {
      id: o.order_id, status: o.status,
      lines: (o.order_lines || []).map(l => ({ pid: l.product_id, name: l.product?.name, unit: l.product?.unit, qty: Number(l.quantity), orig: Number(l.quantity), price: Number(l.unit_price), isNew: false }))
    };
    $("#oNewBox").hidden = true; $("#oApproveWrap").hidden = true;
    standingUI(false);
    $("#orderSave").textContent = "שמירת שינויים";
    $("#orderTitle").textContent = `עריכת הזמנה ${o.order_id}`;
    $("#orderSub").textContent = `${o.customers?.name || ""} · ${o.status}`;
    const warn = $("#orderWarn");
    warn.hidden = o.status !== "בייצור";
    warn.textContent = o.started_at
      ? "ההזמנה כבר בקילוף בפס הייצור. הטאבלט יקבל התראה, ומוצר שהכמות שלו משתנה יסומן מחדש כ'לא הוכן'."
      : "ההזמנה כבר בטאבלט (עוד לא נקלטה). השינוי יופיע שם מיד.";
    $("#oDate").value = o.delivery_date || "";
    $("#oNotes").value = o.notes || "";
    $("#orderError").textContent = "";
    renderEditor();
    $("#orderModal").hidden = false;
  }

  /* ----- הזמנה חדשה ללקוח קיים (טלפון / וואטסאפ) ----- */
  const custLabel = c => `${c.name} · ${c.phone_number || ""} (#${c.customer_id})`;
  async function openNewOrder(customerId) {
    if (!state.customers.length) {
      loading(true);
      const { data } = await db.from("customers").select("customer_id, name, customer_category, adress, phone_number, hash_key, created_at").order("name");
      loading(false);
      state.customers = data || [];
    }
    state.edit = { mode: "new", id: null, status: null, customerId: null, lines: [] };
    $("#orderTitle").textContent = "הזמנה חדשה";
    $("#orderSub").textContent = "ללקוח קיים, למשל הזמנה שהגיעה בטלפון או בוואטסאפ. המנהל פטור מחוק 12:00.";
    $("#orderWarn").hidden = true;
    $("#oNewBox").hidden = false; $("#oApproveWrap").hidden = false; $("#oApprove").checked = true;
    standingUI(false);
    $("#oCustList").innerHTML = state.customers.map(c => `<option value="${esc(custLabel(c))}"></option>`).join("");
    $("#oCust").value = ""; $("#oCustInfo").textContent = "";
    $("#oSource").value = "טלפון";
    $("#oDate").value = nextDeliveryDay();
    $("#oNotes").value = "";
    $("#orderSave").textContent = "יצירת הזמנה";
    $("#orderError").textContent = "";
    if (customerId) {
      const c = state.customers.find(x => x.customer_id === Number(customerId));
      if (c) { $("#oCust").value = custLabel(c); pickCustomer(); }
    }
    renderEditor();
    $("#orderModal").hidden = false;
    (customerId ? $("#oAddProduct") : $("#oCust")).focus();
  }
  function pickCustomer() {
    const m = $("#oCust").value.match(/\(#(\d+)\)\s*$/);
    const c = m && state.customers.find(x => x.customer_id === Number(m[1]));
    state.edit.customerId = c ? c.customer_id : null;
    $("#oCustInfo").textContent = c ? `כתובת אספקה: ${c.adress || "—"} · ${c.customer_category || ""}` : ($("#oCust").value ? "בחרו לקוח מהרשימה" : "");
  }
  $("#oCust").addEventListener("input", () => { if (state.edit && state.edit.mode === "new") pickCustomer(); });

  function renderEditor() {
    const e = state.edit; if (!e) return;
    $("#oLines").innerHTML = e.lines.map((l, i) => `<tr class="${l.isNew ? "is-new" : ""}" data-i="${i}">
      <td><strong>${esc(l.name)}</strong><br><small class="muted">${esc(l.unit || "")}</small></td>
      <td><input type="number" min="1" max="1000" step="1" value="${l.qty}" data-qty="${i}" aria-label="כמות ${esc(l.name)}"></td>
      <td class="num">${l.isNew ? (e.mode === "standing" ? "לפי מחירון" : "יחושב בשמירה") : money(l.price)}</td>
      <td class="num">${l.isNew ? "—" : money(l.price * l.qty)}</td>
      <td><button type="button" class="rm" data-rm="${i}" aria-label="הסרת ${esc(l.name)}">✕</button></td>
    </tr>`).join("") || `<tr><td colspan="5" class="muted">אין מוצרים. הוסיפו לפחות מוצר אחד.</td></tr>`;
    const used = new Set(e.lines.map(l => l.pid));
    $("#oAddProduct").innerHTML = `<option value="">בחירת מוצר להוספה…</option>` +
      (state.productList || []).filter(p => p.is_active && !used.has(p.product_id))
        .map(p => `<option value="${p.product_id}">${esc(p.name)}</option>`).join("");
    const known = e.lines.filter(l => !l.isNew).reduce((s, l) => s + l.price * l.qty, 0);
    const hasNew = e.lines.some(l => l.isNew);
    $("#oTotal").textContent = e.mode === "standing"
      ? (e.lines.length ? "המחיר נקבע בכל פעם שההזמנה נוצרת, לפי המחירון של הלקוח (מחיר מיוחד אם יש)" : "")
      : e.mode === "new"
      ? (e.lines.length ? "המחירים ייקבעו בשמירה לפי המחירון של הלקוח (מחיר מיוחד אם יש)" : "")
      : `סה״כ לפני מע״מ: ${money(known)}${hasNew ? " + מוצרים חדשים (המחיר נקבע לפי המחירון של הלקוח)" : ""}`;
    $("#orderError").textContent = "";
    $("#oLines").classList.toggle("no-new-tag", e.mode === "new" || e.mode === "standing");
  }

  $("#oLines").addEventListener("input", ev => {
    const inp = ev.target.closest("[data-qty]"); if (!inp) return;
    const l = state.edit.lines[Number(inp.dataset.qty)];
    l.qty = Math.max(0, Number(inp.value) || 0);
    const tr = inp.closest("tr");
    if (!l.isNew) tr.cells[3].textContent = money(l.price * l.qty);
    const known = state.edit.lines.filter(x => !x.isNew).reduce((s, x) => s + x.price * x.qty, 0);
    if (state.edit.mode !== "new" && state.edit.mode !== "standing") $("#oTotal").textContent = $("#oTotal").textContent.replace(/^סה״כ לפני מע״מ: [^+]*/, `סה״כ לפני מע״מ: ${money(known)}`);
  });
  $("#oLines").addEventListener("click", ev => {
    const b = ev.target.closest("[data-rm]"); if (!b) return;
    state.edit.lines.splice(Number(b.dataset.rm), 1); renderEditor();
  });
  $("#oAddBtn").addEventListener("click", () => {
    const pid = Number($("#oAddProduct").value); if (!pid) return;
    const p = (state.productList || []).find(x => x.product_id === pid); if (!p) return;
    state.edit.lines.push({ pid, name: p.name, unit: p.unit, qty: 1, orig: 0, price: Number(p.base_price) || 0, isNew: true });
    renderEditor();
    const inputs = $$("#oLines [data-qty]"); if (inputs.length) inputs[inputs.length - 1].focus();
  });
  function closeOrderEditor() { $("#orderModal").hidden = true; state.edit = null; }
  $("#orderModal").addEventListener("click", ev => { if (ev.target.id === "orderModal" || ev.target.closest("[data-close-order]")) closeOrderEditor(); });

  $("#orderForm").addEventListener("submit", async ev => {
    ev.preventDefault();
    const e = state.edit; if (!e) return;
    const items = e.lines.map(l => ({ pid: l.pid, qty: l.qty }));
    if (!items.length) { $("#orderError").textContent = "צריך לפחות מוצר אחד"; return; }
    if (items.some(i => !(i.qty >= 1 && i.qty <= 1000))) { $("#orderError").textContent = "כמות צריכה להיות בין 1 ל-1000"; return; }
    if (e.mode === "standing") {
      const days = $$("#oWeekdays input:checked").map(i => Number(i.value));
      if (!days.length) { $("#orderError").textContent = "בחרו לפחות יום אספקה אחד"; return; }
      $("#orderSave").disabled = true; $("#orderError").textContent = "";
      const { error: err } = await db.rpc("save_standing_order", {
        p_standing_id: e.id, p_customer_id: e.customerId, p_weekdays: days, p_items: items,
        p_notes: $("#oNotes").value, p_active: $("#oStandActive").checked
      });
      $("#orderSave").disabled = false;
      if (err) { $("#orderError").textContent = "השמירה נכשלה: " + err.message; return; }
      closeOrderEditor();
      toast(e.id ? "ההזמנה הקבועה עודכנה" : "נוצרה הזמנה קבועה");
      lastPrepare = 0;
      await loadStanding(); renderCustomers(); loadCounts();
      return;
    }
    if (e.mode === "new") {
      if (!e.customerId) { $("#orderError").textContent = "בחרו לקוח מהרשימה"; $("#oCust").focus(); return; }
      if (!$("#oDate").value) { $("#orderError").textContent = "בחרו תאריך אספקה"; return; }
      $("#orderSave").disabled = true; $("#orderError").textContent = "";
      const approve = $("#oApprove").checked;
      const { data: res, error: err } = await db.rpc("admin_create_order", {
        p_customer_id: e.customerId, p_delivery_date: $("#oDate").value, p_notes: $("#oNotes").value,
        p_items: items, p_source: $("#oSource").value, p_approve: approve
      });
      $("#orderSave").disabled = false;
      if (err) { $("#orderError").textContent = "ההזמנה לא נוצרה: " + err.message; return; }
      closeOrderEditor();
      toast(`נוצרה הזמנה ${res.order_id}` + (approve ? " · מאושרת, ממתינה לקילוף" : " · ממתינה לאישור"));
      loadCounts(); refreshTab();
      return;
    }
    $("#orderSave").disabled = true; $("#orderError").textContent = "";
    const { error } = await db.rpc("update_order", {
      p_order_id: e.id, p_delivery_date: $("#oDate").value || null, p_notes: $("#oNotes").value, p_items: items
    });
    $("#orderSave").disabled = false;
    if (error) { $("#orderError").textContent = "השמירה נכשלה: " + error.message; return; }
    const id = e.id; closeOrderEditor();
    toast(`הזמנה ${id} עודכנה` + (e.status === "בייצור" ? " · הטאבלט קיבל התראה" : ""));
    loadCounts(); refreshTab();
  });

  /* ==========================================================
     הזמנות קבועות: לקוח + ימי אספקה + מוצרים. נוצרות לבד ליום האספקה הקרוב
     (במצב "מאושרת") ונשלחות לקילוף עם "שלח לקילוף". עריכה מניהול לקוחות.
     ========================================================== */
  const DAY_NAMES = ["א׳", "ב׳", "ג׳", "ד׳", "ה׳", "ו׳"];
  state.standing = [];
  async function loadStanding() {
    const { data, error } = await db.from("standing_orders")
      .select("standing_id, customer_id, weekdays, items, notes, is_active").order("standing_id");
    if (error) { console.warn("standing_orders:", error.message); return; }
    state.standing = data || [];
  }
  function standingBtn(customerId) {
    const mine = state.standing.filter(x => x.customer_id === customerId);
    const days = [...new Set(mine.filter(x => x.is_active).flatMap(x => x.weekdays))].sort().map(d => DAY_NAMES[d]).join(" ");
    const label = mine.length ? (days ? `קבועה · ${days}` : "קבועה (מושהית)") : "+ קבועה";
    return `<button type="button" class="btn btn-sm btn-standing${mine.length ? " has" : ""}" data-standing="${customerId}" title="הזמנה קבועה">${esc(label)}</button>`;
  }
  function standingUI(on) {
    $("#oStandBox").hidden = !on; $("#oDateWrap").hidden = on;
    if (!on) $("#orderDelete").hidden = true;
  }
  function openStanding(customerId, pick) {
    const c = state.customers.find(x => x.customer_id === customerId); if (!c) return;
    const mine = state.standing.filter(x => x.customer_id === customerId);
    const s = pick === "new" ? null : (mine.find(x => x.standing_id === pick) || mine[0] || null);
    const prod = pid => (state.productList || []).find(p => p.product_id === Number(pid));
    state.edit = {
      mode: "standing", id: s ? s.standing_id : null, customerId, status: null,
      lines: s ? (s.items || []).map(i => { const p = prod(i.pid); return { pid: Number(i.pid), name: p ? p.name : `מוצר ${i.pid}`, unit: p?.unit, qty: Number(i.qty), orig: Number(i.qty), price: Number(p?.base_price) || 0, isNew: true }; }) : []
    };
    $("#orderTitle").textContent = `הזמנה קבועה · ${c.name}`;
    $("#orderSub").textContent = "נוצרת לבד ליום האספקה, בלי אישור מנהל, ונשלחת לקילוף עם הכפתור \"שלח לקילוף\". מופיעה בכחול בסוף רשימת המאושרות ובטאבלט.";
    $("#orderWarn").hidden = true; $("#oNewBox").hidden = true; $("#oApproveWrap").hidden = true;
    standingUI(true);
    $("#oStandPickWrap").hidden = !mine.length;
    $("#oStandPick").innerHTML = mine.map(x => `<option value="${x.standing_id}">${esc(x.weekdays.map(d => DAY_NAMES[d]).join(" "))}${x.is_active ? "" : " (מושהית)"}</option>`).join("") + `<option value="new">+ הזמנה קבועה נוספת</option>`;
    $("#oStandPick").value = s ? String(s.standing_id) : "new";
    $$("#oWeekdays input").forEach(i => { i.checked = s ? s.weekdays.includes(Number(i.value)) : false; });
    $("#oStandActive").checked = s ? s.is_active : true;
    $("#oNotes").value = s ? (s.notes || "") : "";
    $("#orderDelete").hidden = !s;
    $("#orderSave").textContent = s ? "שמירת ההזמנה הקבועה" : "יצירת הזמנה קבועה";
    $("#orderError").textContent = "";
    renderEditor();
    $("#orderModal").hidden = false;
  }
  $("#oStandPick").addEventListener("change", e => {
    if (!state.edit || state.edit.mode !== "standing") return;
    openStanding(state.edit.customerId, e.target.value === "new" ? "new" : Number(e.target.value));
  });
  $("#orderDelete").addEventListener("click", async () => {
    const e = state.edit; if (!e || e.mode !== "standing" || !e.id) return;
    if (!confirm("למחוק את ההזמנה הקבועה? (הזמנות שכבר ירדו לייצור לא יושפעו)")) return;
    const { error } = await db.rpc("delete_standing_order", { p_standing_id: e.id });
    if (error) { $("#orderError").textContent = "המחיקה נכשלה: " + error.message; return; }
    closeOrderEditor(); toast("ההזמנה הקבועה נמחקה");
    await loadStanding(); renderCustomers(); loadCounts();
  });

  document.addEventListener("click", ev => {
    const n = ev.target.closest("[data-new-order]");
    if (n) { openNewOrder(n.dataset.newOrder ? Number(n.dataset.newOrder) : null); return; }
    const b = ev.target.closest("[data-edit-order]"); if (!b) return;
    openOrderEditor(Number(b.dataset.editOrder));
  });

  // גיבוי ללשונית פס ייצור: רענון כל 30 שניות כשהיא פתוחה
  setInterval(() => { if (!$("#appView").hidden && state.module === "orders" && state.tab === "production" && !document.hidden) loadProduction(); }, 30000);

  /* ---------- אירועים ---------- */
  $$(".flow-step").forEach(b => b.addEventListener("click", () => setTab(b.dataset.go)));
  $$(".dm-btn").forEach(b => b.addEventListener("click", () => {
    state.dayMode = b.dataset.mode;
    if (state.dayMode === "delivery" && state.day === todayISO()) state.day = nextDeliveryDay();
    loadDay();
  }));
  document.addEventListener("click", async e => {
    if (e.target.closest("[data-logout]")) { stopRealtime(); await db.auth.signOut(); return; }
    const t = e.target.closest(".tab:not(.tab-action)"); if (t && !t.hidden) setTab(t.dataset.tab);
  });
  $("#statusFilter").innerHTML += STATUSES.map(s => `<option>${s}</option>`).join("");
  ["#searchInput", "#statusFilter", "#driverFilter"].forEach(s => $(s).addEventListener("input", renderDay));
  $("#dayInput").addEventListener("change", e => { if (e.target.value) { state.day = e.target.value; loadDay(); } });
  $("#prevDay").addEventListener("click", () => { state.day = shiftDay(state.day, -1); loadDay(); });
  $("#nextDay").addEventListener("click", () => { state.day = shiftDay(state.day, 1); loadDay(); });
  $("#todayBtn").addEventListener("click", () => { state.day = todayISO(); loadDay(); });
  $("#lastDayBtn").addEventListener("click", jumpToLastDay);
})();
