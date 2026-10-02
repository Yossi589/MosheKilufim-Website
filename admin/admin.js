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
    ["pending", "requests", "day"].forEach(t => { $("#view-" + t).hidden = t !== tab; });
    refreshTab();
  }
  function refreshTab() {
    if (state.tab === "pending") return loadPending();
    if (state.tab === "requests") return loadRequests();
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
