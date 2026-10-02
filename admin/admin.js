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

  const STATUSES = ["ממתינה לאישור", "בייצור", "הוכנה", "בדרך", "נמסרה", "בוטלה"];
  const PENDING = "ממתינה לאישור";
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const num = n => new Intl.NumberFormat("he-IL", { maximumFractionDigits: 1 }).format(n || 0);
  const BASE_TITLE = document.title;

  const state = {
    tab: "pending", day: todayISO(),
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
    ["pending", "requests", "day", "stats", "hash"].forEach(t => { $("#view-" + t).hidden = t !== tab; });
    refreshTab();
  }
  function refreshTab() {
    if (state.tab === "pending") return loadPending();
    if (state.tab === "requests") return loadRequests();
    if (state.tab === "stats") return loadStats();
    if (state.tab === "hash") return loadHash();
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
    show("appView");
    setupNotifyButton();
    await Promise.all([loadDrivers(), loadProducts()]);
    await loadCounts();
    setTab(state.counts.pending ? "pending" : (state.counts.requests ? "requests" : "day"));
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
    const { data } = await db.from("product").select("product_id, name");
    state.products = new Map((data || []).map(p => [p.product_id, p.name]));
  }

  async function count(table, build) {
    const q = build(db.from(table).select("*", { count: "exact", head: true }));
    const { count: n, error } = await q;
    return error ? null : n;
  }
  async function loadCounts() {
    const [from] = dayRange(todayISO());
    const [pending, production, prepared, requests] = await Promise.all([
      count("orders", q => q.eq("status", PENDING)),
      count("orders", q => q.eq("status", "בייצור")),
      count("orders", q => q.gte("prepared_at", from)),
      count("customer_requests", q => q.eq("status", "חדשה"))
    ]);
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
    $("#pendingList").innerHTML = data.map(o => `
      <article class="ocard" data-id="${o.order_id}">
        <header>
          <strong>#${o.order_id} · ${esc(o.customers?.name)}</strong>
          ${sourceTag(o.source)}
          <span class="muted small">${ago(o.order_date)}</span>
        </header>
        <div class="ocard-body">
          <div class="items">${itemsText(o.order_lines)}</div>
          <div class="meta">
            <div><span class="muted">אספקה:</span> ${o.delivery_date ? esc(fmtDate(o.delivery_date)) : "לא צוין"}</div>
            <div><span class="muted">בטאבלט:</span> ${esc(tabletFrom(o.delivery_date))}</div>
            <div><span class="muted">כתובת:</span> ${esc(o.customers?.adress || "")}</div>
            <div><span class="muted">טלפון:</span> <bdi>${esc(o.customers?.phone_number || "")}</bdi></div>
            ${o.notes ? `<div class="note"><span class="muted">הערות:</span> ${esc(o.notes)}</div>` : ""}
            <div class="muted small">${num(orderTotalPacks(o))} מארזים</div>
          </div>
        </div>
        <footer>
          <button type="button" class="btn btn-primary" data-approve="${o.order_id}">אשר ושלח לייצור</button>
          <button type="button" class="btn btn-danger" data-cancel="${o.order_id}">ביטול הזמנה</button>
        </footer>
      </article>`).join("");
  }

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
    const ok = await setStatus(id, a ? "בייצור" : "בוטלה");
    if (ok) toast(a ? `הזמנה ${id} נשלחה לייצור` : `הזמנה ${id} בוטלה`);
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
          <button type="button" class="btn btn-primary" data-open="${r.request_id}">פתיחת לקוח</button>
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
  document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("#custModal").hidden) closeModal(); });

  $("#custForm").addEventListener("submit", async e => {
    e.preventDefault();
    const r = state.currentRequest; if (!r) return;
    const name = $("#cName").value.trim(), adress = $("#cAdress").value.trim().replace(/^,\s*/, "");
    if (!name || adress.length < 3) { $("#custError").textContent = "צריך שם וכתובת אספקה"; return; }
    $("#custSave").disabled = true; $("#custError").textContent = "";

    // 1. כרטיס לקוח חדש
    const { data: cust, error: e1 } = await db.from("customers")
      .insert({ name, customer_category: $("#cCategory").value, adress, phone_number: r.phone })
      .select("customer_id").single();
    if (e1) { $("#custSave").disabled = false; $("#custError").textContent = "שגיאה בפתיחת הלקוח: " + e1.message; return; }

    // 2. סגירת הפנייה וקישור ללקוח
    await db.from("customer_requests").update({ status: "טופלה", customer_id: cust.customer_id }).eq("request_id", r.request_id);

    // 3. אם ביקש מוצרים: יצירת הזמנה דרך אותה פונקציה של האתר (המחיר מחושב בשרת)
    let msg = `נפתח לקוח: ${name}`;
    if (!$("#cOrderBox").hidden && $("#cMakeOrder").checked) {
      const { data: res, error: e2 } = await db.rpc("place_order", {
        p_name: r.name, p_phone: r.phone, p_business: r.business || "", p_city: r.city || "",
        p_delivery_date: $("#cDate").value, p_notes: r.notes || "", p_items: r.items
      });
      if (e2) msg += ` · ההזמנה לא נוצרה: ${e2.message}`;
      else if (res && res.result === "order") msg += ` · נוצרה הזמנה ${res.order_id} (ממתינה לאישור)`;
    }
    $("#custSave").disabled = false;
    closeModal(); toast(msg);
    await Promise.all([loadCounts(), loadRequests()]);
  });

  /* ==========================================================
     לשונית: הזמנות לפי יום
     ========================================================== */
  async function loadDay() {
    $("#dayInput").value = state.day;
    $("#dayLabel").textContent = new Date(state.day + "T12:00:00").toLocaleDateString("he-IL", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
    loading(true);
    const [from, to] = dayRange(state.day);
    const { data, error } = await db.from("orders")
      .select(`order_id, order_date, delivery_date, status, source, adress, driver_id, notes,
               customers ( name, phone_number ),
               drivers ( name ),
               order_lines ( quantity, product ( name ) )`)
      .gte("order_date", from).lt("order_date", to)
      .order("order_date");
    loading(false);
    if (error) { toast("שגיאה בטעינת הזמנות: " + error.message, true); return; }
    state.orders = data;
    renderDay();
  }

  async function jumpToLastDay() {
    const { data, error } = await db.from("orders").select("order_date").order("order_date", { ascending: false }).limit(1);
    if (error || !data.length) { toast("לא נמצאו הזמנות", true); return; }
    state.day = toISO(new Date(data[0].order_date));
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
      const time = new Date(o.order_date).toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" });
      const driverOpts = `<option value="">—</option>` + state.drivers.map(d =>
        `<option value="${d.driver_id}" ${d.driver_id === o.driver_id ? "selected" : ""}>${esc(d.name)}</option>`).join("");
      const statusOpts = STATUSES.map(s => `<option ${s === o.status ? "selected" : ""}>${s}</option>`).join("");
      return `<tr data-id="${o.order_id}" class="${o.status === "בוטלה" ? "cancelled" : ""}">
        <td class="num">${o.order_id}</td>
        <td class="num">${time}</td>
        <td class="cust"><strong>${esc(o.customers?.name)}</strong>${sourceTag(o.source)}<small>${esc(o.adress || "")}</small>${o.notes ? `<small class="note">${esc(o.notes)}</small>` : ""}</td>
        <td class="items">${itemsText(o.order_lines)}</td>
        <td class="num">${o.delivery_date ? esc(fmtDate(o.delivery_date)) : ""}</td>
        <td><select data-field="driver_id" aria-label="נהג להזמנה ${o.order_id}">${driverOpts}</select></td>
        <td><select data-field="status" class="st" data-st="${esc(o.status)}" aria-label="סטטוס להזמנה ${o.order_id}">${statusOpts}</select></td>
      </tr>`;
    }).join("");
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
  }
  function stopRealtime() { if (state.channel) { db.removeChannel(state.channel); state.channel = null; } setLive(false); }

  let refreshTimer;
  function scheduleRefresh() { clearTimeout(refreshTimer); refreshTimer = setTimeout(() => { loadCounts(); refreshTab(); }, 400); }

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
      if (!state.channel || !$("#liveDot").classList.contains("on")) { beep(); refreshTab(); }
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

  $$(".seg-btn").forEach(b => b.addEventListener("click", () => {
    $$(".seg-btn").forEach(x => x.classList.toggle("is-active", x === b));
    state.statDays = Number(b.dataset.days); loadStats();
  }));

  /* ==========================================================
     לשונית: חשבשבת — הזמנת לקוח (מסמך 30)
     אקסל: קובץ קריא להקלדה. קובץ קליטה: IMOVEIN.DOC ברוחב קבוע, בקידוד Windows-1255,
     יחד עם IMOVEIN.PRM שמגדיר איפה כל שדה נמצא בשורה.
     ========================================================== */
  const VAT = 18;                 // % מע"מ
  const HASH_DOC_TYPE = 30;       // הזמנה מלקוח
  const APPROVED = ["בייצור", "הוכנה", "בדרך", "נמסרה"];
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
        "אסמכתא (מס׳ הזמנה)": o.order_id, "סוג מסמך": `${HASH_DOC_TYPE} - הזמנה מלקוח`,
        "מפתח לקוח": custKey(c), "שם לקוח": c.name || "", "כתובת": o.adress || c.adress || "", "טלפון": c.phone_number || "",
        "תאריך הזמנה": ddmmyyyy(o.order_date), "תאריך אספקה": o.delivery_date ? ddmmyyyy(o.delivery_date) : "",
        "נהג": o.drivers?.name || "", "הערות": o.notes || "",
        "סה״כ לפני מע״מ": +net.toFixed(2), [`מע״מ ${VAT}%`]: +(net * VAT / 100).toFixed(2), "סה״כ כולל מע״מ": +(net * (1 + VAT / 100)).toFixed(2)
      };
    });
    const lines = [];
    orders.forEach(o => (o.order_lines || []).forEach(l => lines.push({
      "אסמכתא (מס׳ הזמנה)": o.order_id, "מפתח לקוח": custKey(o.customers), "שם לקוח": o.customers?.name || "",
      "תאריך אספקה": o.delivery_date ? ddmmyyyy(o.delivery_date) : "",
      "מפתח פריט": itemKey(l.product), "שם פריט": l.product?.name || "", "יחידה": l.product?.unit || "",
      "כמות": Number(l.quantity), "מחיר ליחידה": Number(l.unit_price || 0), "סה״כ שורה": +lineTotal(l).toFixed(2)
    })));
    const help = [
      ["איך מקלידים בחשבשבת"],
      [`1. בחשבשבת: מסמכים ← הזמנה מלקוח (סוג ${HASH_DOC_TYPE}).`],
      ["2. לכל הזמנה בגיליון 'הזמנות': מפתח לקוח, תאריך, ובשדה אסמכתא את מספר ההזמנה שלנו."],
      ["3. את הפריטים מקלידים מגיליון 'שורות' (מסננים לפי אסמכתא)."],
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

  /* ---------- אירועים ---------- */
  document.addEventListener("click", async e => {
    if (e.target.closest("[data-logout]")) { stopRealtime(); await db.auth.signOut(); return; }
    const t = e.target.closest(".tab"); if (t) setTab(t.dataset.tab);
  });
  $("#statusFilter").innerHTML += STATUSES.map(s => `<option>${s}</option>`).join("");
  ["#searchInput", "#statusFilter", "#driverFilter"].forEach(s => $(s).addEventListener("input", renderDay));
  $("#dayInput").addEventListener("change", e => { if (e.target.value) { state.day = e.target.value; loadDay(); } });
  $("#prevDay").addEventListener("click", () => { state.day = shiftDay(state.day, -1); loadDay(); });
  $("#nextDay").addEventListener("click", () => { state.day = shiftDay(state.day, 1); loadDay(); });
  $("#todayBtn").addEventListener("click", () => { state.day = todayISO(); loadDay(); });
  $("#lastDayBtn").addEventListener("click", jumpToLastDay);
})();
