/* ==========================================================
   עמדת ייצור (טאבלט בפס) · משה קילופים
   ההזמנות נשלחות לטאבלט בבת אחת מהניהול ("שלח לקילוף"), ולכן אין שלב "נקלטה":
   1. הזמנות להכנה  - מסמנים כל מוצר שהוכן (צ'קבוקס, נשמר בשרת: set_line_prepared). כשהכול מסומן, OK נצבע בירוק
                        -> mark_prepared(order_id), עם כמה שניות לביטול
   3. הוכנו          - לשונית נפרדת: production_done() עם תאריך ושעת ההכנה
   + סה"כ לקילוף     - לשונית: כמה מארזים וכמה ק"ג מכל מוצר בכל ההזמנות, ולמי זה מתחלק
   - כניסה עם משתמש מנהל הייצור (production_staff) או מנהל
   - בלי מחירים ובלי טלפונים
   - עדכון בזמן אמת: ערוץ production, ורענון גיבוי כל 30 שניות
   ========================================================== */
(function () {
  "use strict";

  const { SUPABASE_URL, SUPABASE_KEY } = window.MK_CONFIG;
  const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const num = n => new Intl.NumberFormat("he-IL", { maximumFractionDigits: 1 }).format(n || 0);
  const NEW_MS = 10 * 60 * 1000;   // הזמנה "חדשה" = אושרה ב-10 הדקות האחרונות
  const UNDO_SEC = 6;

  // תמונות ומשקלים: מגיעים מהשרת (טבלת product, בתוך items של production_queue).
  // js/products.js משמש רק גיבוי אם השרת עוד לא החזיר ערך.
  const IMG = new Map((window.MK_PRODUCTS || []).map(p => [p.name, p.image]));
  // משקל מארז בק"ג: מהקטלוג (kg), ואם אין - מתוך תיאור היחידה ("מארז 10 ק״ג")
  const KG = new Map((window.MK_PRODUCTS || []).map(p => [p.name, Number(p.kg) || 0]));
  const kgPerPack = (name, unit) => KG.get(name) || Number((String(unit || "").match(/(\d+(?:\.\d+)?)\s*ק/) || [])[1]) || 0;
  const learnCatalog = orders => orders.forEach(o => (o.items || []).forEach(i => {
    if (Number(i.kg) > 0) KG.set(i.product, Number(i.kg));
    if (i.image) IMG.set(i.product, i.image);
  }));
  const kgFmt = n => new Intl.NumberFormat("he-IL", { maximumFractionDigits: 1 }).format(n);
  const thumb = name => IMG.has(name)
    ? `<img class="ph" src="../img/thumbs/${esc(IMG.get(name))}" alt="" width="56" height="56" loading="lazy">`
    : `<span class="ph"></span>`;

  const state = { orders: [], done: [], first: true, channel: null, busy: false, wake: null,
                  view: "work", undo: new Map(), starting: new Set() };
  try { state.view = localStorage.getItem("mkTabletView") || "peel"; } catch (_) { state.view = "peel"; }

  /* ---------- זיכרון מקומי: אילו מוצרים סומנו כמוכנים בכל הזמנה ---------- */
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (_) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} }
  };
  /* סימון "המוצר הוכן" נשמר בשרת (order_lines.prepared_at), כדי שהמנהל יראה וכל המכשירים יסונכרנו */
  const findItem = (id, name) => ((state.orders.find(o => o.order_id === id) || {}).items || []).find(i => i.product === name);
  const isTicked = (id, name) => !!(findItem(id, name) || {}).prepared;
  const allTicked = o => (o.items || []).length > 0 && (o.items || []).every(i => isTicked(o.order_id, i.product));

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
  function due(iso) {
    if (!iso) return { text: "", urgent: false };
    const d = new Date(iso + "T12:00:00"), t = new Date(); t.setHours(12, 0, 0, 0);
    const diff = Math.round((d - t) / 86400000);
    if (diff < 0) return { text: "באיחור", urgent: true };
    if (diff === 0) return { text: "אספקה היום", urgent: true };
    if (diff === 1) return { text: "אספקה מחר", urgent: false };
    return { text: "אספקה " + d.toLocaleDateString("he-IL", { weekday: "short", day: "numeric", month: "numeric" }), urgent: false };
  }
  const isToday = ts => new Date(ts).toDateString() === new Date().toDateString();
  function when(ts) {
    const d = new Date(ts);
    const time = d.toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" });
    if (isToday(ts)) return `היום · ${time}`;
    const y = new Date(); y.setDate(y.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return `אתמול · ${time}`;
    return `${d.toLocaleDateString("he-IL", { day: "numeric", month: "numeric" })} · ${time}`;
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
     טעינה: תור הייצור + ההזמנות שהוכנו
     ========================================================== */
  async function load() {
    if ($("#appView").hidden || state.busy) return;
    if (state.pending) return;   // לא לדרוס סימון שעוד בדרך לשרת
    const [q, d, pl] = await Promise.all([db.rpc("production_queue"), db.rpc("production_done", { p_days: 2 }), db.rpc("peel_status")]);
    if (q.error) { setStatus(false, "שגיאה בטעינה"); return; }
    const before = new Set(state.orders.map(o => o.order_id));
    state.orders = q.data || [];
    learnCatalog(state.orders);
    if (!d.error) state.done = d.data || [];
    if (!pl.error) state.peel = pl.data || [];
    const fresh = state.orders.filter(o => !before.has(o.order_id));
    const freshIds = state.first ? new Set() : new Set(fresh.map(o => o.order_id));
    if (!state.first && fresh.length) { chime(); toast(fresh.length === 1 ? `הזמנה חדשה: ${fresh[0].customer_name}` : `${fresh.length} הזמנות חדשות`); }
    state.first = false;
    render(freshIds);
    $("#updated").textContent = "עודכן " + new Date().toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" });
  }

  function render(freshIds = new Set()) {
    const active = state.orders.filter(o => !state.undo.has(o.order_id));
    const fresh = [];                 // אין יותר שלב "נקלטה"
    const prod = state.orders;
    const doneToday = state.done.filter(o => isToday(o.prepared_at)).length;
    const left = active.length;

    $("#count").textContent = left ? `${left} להכנה` : "אין הזמנות";
    $("#progText").textContent = `הוכנו היום ${doneToday} · נשארו ${left}`;
    $("#progFill").style.width = (left + doneToday) ? `${Math.round(100 * doneToday / (left + doneToday))}%` : "0%";
    document.title = left ? `(${left}) עמדת ייצור` : "עמדת ייצור · משה קילופים";

    $("#cntWork").textContent = left;
    $("#cntDone").textContent = state.done.length;
    $("#cntProd").textContent = prod.length;
    $("#emptyProd").hidden = prod.length > 0;

    $("#queueProd").innerHTML = prod.map(o => prodTicket(o, freshIds)).join("");
    renderPeel();
    renderDone();
  }

  function header(o, extra = "") {
    const d = due(o.delivery_date);
    return `<header>
        <div class="who"><strong>${esc(o.customer_name)}</strong><span>הזמנה ${o.order_id}${o.standing ? ` <em class="standing-tag">הזמנה קבועה</em>` : ""}</span></div>
        <div class="when">${d.text ? `<span class="due${d.urgent ? " urgent" : ""}">${esc(d.text)}</span>` : ""}${extra}</div>
      </header>`;
  }

  /* שלב 1: הזמנה חדשה */
  function newTicket(o, freshIds) {
    const isNew = freshIds.has(o.order_id) || (o.approved_at && Date.now() - new Date(o.approved_at) < NEW_MS);
    const items = (o.items || []).map(i => `<li><span class="q">${num(i.quantity)}</span>${thumb(i.product)}<span class="p">${esc(i.product)}</span><span class="u">${esc(i.unit || "")}</span></li>`).join("");
    const busy = state.starting.has(o.order_id);
    return `<article class="ticket t-new${o.standing ? " is-standing" : ""}${isNew ? " is-new" : ""}${due(o.delivery_date).urgent ? " is-urgent" : ""}" data-id="${o.order_id}">
      ${header(o, `<span class="muted">אושרה ${esc(ago(o.approved_at))}</span>`)}
      ${isNew ? `<span class="new-flag">חדשה</span>` : ""}
      <ul class="items">${items}</ul>
      ${o.notes ? `<p class="notes">${esc(o.notes)}</p>` : ""}
      <button type="button" class="btn btn-start btn-xl" data-start="${o.order_id}" ${busy ? "disabled" : ""}>${busy ? "מעביר…" : "נקלטה · העבר לקילוף ←"}</button>
    </article>`;
  }

  /* שלב 2: בתהליך ייצור - אפור, צ'קבוקס לכל מוצר */
  function prodTicket(o, freshIds = new Set()) {
    const isNew = freshIds.has(o.order_id) || (!o.started_at && o.approved_at && Date.now() - new Date(o.approved_at) < NEW_MS);
    const items = o.items || [];
    const n = items.filter(i => isTicked(o.order_id, i.product)).length;
    const all = allTicked(o);
    const u = state.undo.get(o.order_id);
    const peelOk = peelOkMap();
    const lis = items.map(i => {
      const t = isTicked(o.order_id, i.product);
      const wait = !t && !peelOk[o.order_id + ":" + i.product_id];   // עוד לא קולף: אי אפשר לארוז
      return `<li class="chk${t ? " ticked" : ""}${wait ? " unpeeled" : ""}" data-tick="${o.order_id}" data-name="${esc(i.product)}" role="checkbox" aria-checked="${t}"${wait ? ` aria-disabled="true" title="עוד לא קולף: אי אפשר לסמן עד שמסמנים אותו 'קולף' בסה״כ לקילוף"` : ""} tabindex="0">
        <span class="box" aria-hidden="true">${t ? "✓" : ""}</span>
        ${thumb(i.product)}
        <span class="p">${esc(i.product)}${wait ? `<small class="wait-tag">עוד לא קולף</small>` : ""}</span>
        <span class="qty">${num(i.quantity)} <small>${esc(i.unit || "")}</small></span>
      </li>`;
    }).join("");
    return `<article class="ticket t-prod${o.standing ? " is-standing" : ""}${all ? " all-ticked" : ""}${u ? " is-undo" : ""}" data-id="${o.order_id}">
      ${header(o, `<span class="tick-count">${n}/${items.length} הוכנו</span>${o.started_at ? `<span class="muted">התחילו ${esc(ago(o.started_at))}</span>` : ""}`)}
      ${isNew ? `<span class="new-flag">חדשה</span>` : ""}
      <ul class="items chks">${lis}</ul>
      ${o.notes ? `<p class="notes">${esc(o.notes)}</p>` : ""}
      <button type="button" class="btn btn-ok btn-xl" data-done="${o.order_id}" ${all ? "" : "disabled aria-disabled=\"true\""}>${all ? "OK · ההזמנה הוכנה ✓" : `סמנו את כל המוצרים (${n}/${items.length})`}</button>
      ${u ? `<div class="undo-layer"><strong>ההזמנה הוכנה</strong><button type="button" class="btn btn-xl btn-undo" data-undo="${o.order_id}">ביטול (<span class="undo-sec">${u.left}</span>)</button></div>` : ""}
    </article>`;
  }

  /* מוצרים שסומנו "קולף" היום: נשמר בשרת (peel_log). { product_id: kg שהיו כשסימנו } */
  function peeledMap() {
    const m = {};
    (state.peel || []).forEach(r => { m[r.product_id] = Number(r.kg); });
    return m;
  }
  /* לכל מוצר בכל הזמנה: האם יש לו כבר כמות מקולפת? { "order:product": true }
     הכמות שסומנה "קולף" מתחלקת להזמנות לפי סדר האישור (הראשונה שאושרה מקבלת ראשונה).
     כך, אם קולפו 400 ק״ג ונוספה הזמנה של 20 ק״ג, רק ההזמנה החדשה ננעלת עד שמקלפים את התוספת. */
  function peelOkMap() {
    const peeled = peeledMap(), ok = {}, used = {};
    const byTime = [...state.orders].sort((a, b) =>
      String(a.approved_at || "").localeCompare(String(b.approved_at || "")) || a.order_id - b.order_id);
    byTime.forEach(o => (o.items || []).forEach(i => {
      const key = o.order_id + ":" + i.product_id;
      if (i.peel === false) { ok[key] = true; return; }          // מהמלאי (שום, סלק בוואקום): תמיד מוכן לאריזה
      if (peeled[i.product_id] == null) { ok[key] = false; return; }
      const kg = Number(i.quantity) * kgPerPack(i.product, i.unit);
      used[i.product_id] = (used[i.product_id] || 0) + kg;
      ok[key] = used[i.product_id] <= peeled[i.product_id] + 0.001;
    }));
    return ok;
  }
  async function setPeeled(pid, kg) {
    if (!navigator.onLine) { toast("אין חיבור לאינטרנט", true); return; }
    const before = state.peel;
    state.peel = (state.peel || []).filter(r => r.product_id !== pid);
    if (kg != null) state.peel.push({ product_id: pid, kg, done_at: new Date().toISOString() });
    render();
    const { error } = await db.rpc("set_peeled", { p_product_id: pid, p_kg: kg });
    if (error) { state.peel = before; render(); toast("הסימון לא נשמר: " + error.message, true); }
  }

  /* סה"כ לקילוף: כל הכמות מכל מוצר בכל ההזמנות שבטאבלט (חדשות + בתהליך).
     עד 12:00 מתחילים לקלף את הכמות כולה, ואחר כך מחלקים להזמנות. */
  function renderPeel() {
    const map = new Map(), stock = new Map();
    state.orders.forEach(o => (o.items || []).forEach(i => {
      const k = i.product;
      if (i.peel === false) {   // מהמלאי: לא נכנס לסה"כ לקילוף
        const r = stock.get(k) || { name: k, unit: i.unit, packs: 0 };
        r.packs += Number(i.quantity); stock.set(k, r); return;
      }
      const r = map.get(k) || { name: k, pid: i.product_id, unit: i.unit, packs: 0, kg: 0, splitKg: 0, orders: [] };
      const q = Number(i.quantity), kg = q * kgPerPack(k, i.unit);
      const split = isTicked(o.order_id, k);
      r.packs += q; r.kg += kg; if (split) r.splitKg += kg;
      r.orders.push({ id: o.order_id, customer: o.customer_name, q, split });
      map.set(k, r);
    }));
    const peeled = peeledMap();
    // "בוצע" חל רק אם לא נוספה כמות מאז הסימון; כרטיסים שבוצעו יורדים לסוף
    const isPeeled = r => peeled[r.pid] != null && r.kg <= peeled[r.pid] + 0.001;
    const rows = [...map.values()].sort((a, b) => (isPeeled(a) - isPeeled(b)) || (b.kg - a.kg));
    const totKg = rows.reduce((s, r) => s + r.kg, 0), totPacks = rows.reduce((s, r) => s + r.packs, 0);
    $("#cntPeel").textContent = rows.length;
    const st = [...stock.values()].sort((a, b) => b.packs - a.packs);
    $("#stockBox").hidden = !st.length;
    $("#stockList").innerHTML = st.map(r => `<li>${thumb(r.name)}<span>${esc(r.name)}</span><b>${num(r.packs)} מארזים</b></li>`).join("");
    $("#emptyPeel").hidden = rows.length > 0;
    $("#peelSub").textContent = `${state.orders.length} הזמנות · ${rows.length} מוצרים · ממוין מהכמות הגדולה לקטנה`;
    $("#peelTotal").innerHTML = rows.length ? `<strong>${kgFmt(totKg)}</strong><span>ק״ג בסך הכול · ${num(totPacks)} מארזים</span>` : "";
    const h = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Jerusalem", hour: "2-digit", hourCycle: "h23" }).format(new Date()));
    $("#peelCutoff").textContent = h < 12
      ? "הזמנות למחר נכנסות עד 12:00, אז הכמויות עוד יכולות לגדול. הרשימה מתעדכנת לבד."
      : "עברה השעה 12:00: הרשימה למחר סגורה (חוץ מהזמנה שהמנהל מוסיף ידנית).";
    $("#peelCutoff").classList.toggle("closed", h >= 12);
    $("#peelGrid").innerHTML = rows.map(r => {
      const per = kgPerPack(r.name, r.unit);
      const pct = r.kg ? Math.round(100 * r.splitKg / r.kg) : 0;
      const done = isPeeled(r);
      const added = !done && peeled[r.pid] != null ? r.kg - peeled[r.pid] : 0;
      return `<article class="peel-card${done ? " is-peeled" : pct === 100 ? " is-done" : ""}" data-name="${esc(r.name)}" data-pid="${r.pid}" data-kg="${r.kg}">
        <div class="peel-top">
          ${thumb(r.name).replace('width="56" height="56"', 'width="84" height="84"')}
          <div class="peel-name"><strong>${esc(r.name)}</strong><span>${num(r.packs)} מארזים${per ? ` × ${kgFmt(per)} ק״ג` : ""}</span></div>
          ${added > 0
            ? `<div class="peel-kg is-extra"><strong>${kgFmt(added)}</strong><span>ק״ג עוד לקלף</span></div>`
            : `<div class="peel-kg"><strong>${per ? kgFmt(r.kg) : "?"}</strong><span>ק״ג</span></div>`}
        </div>
        <div class="peel-bar" title="כמה כבר חולק להזמנות"><span style="width:${pct}%"></span></div>
        <p class="peel-split">חולק להזמנות: ${kgFmt(r.splitKg)} מתוך ${kgFmt(r.kg)} ק״ג</p>
        <ul class="peel-orders">${r.orders.map(x => `<li class="${x.split ? "split" : ""}"><span>${x.split ? "✓ " : ""}${esc(x.customer)} <small>#${x.id}</small></span><b>${num(x.q)} מארזים · ${kgFmt(x.q * per)} ק״ג</b></li>`).join("")}</ul>
        ${added > 0 ? `<p class="peel-added">כבר קולפו ${kgFmt(peeled[r.pid])} ק״ג. נוספו ${kgFmt(added)} ק״ג בהזמנה חדשה, מקלפים רק אותם (סה״כ ${kgFmt(r.kg)} ק״ג)</p>` : ""}
        ${done
          ? `<div class="peel-donebar"><span class="peel-done-label">✓ בוצע</span><button type="button" class="peel-undo" data-unpeel>החזרה</button></div>`
          : `<button type="button" class="btn btn-peel-ok btn-xl" data-peel>${added > 0 ? `OK · קולפו עוד ${kgFmt(added)} ק״ג` : "OK · קולף"}</button>`}
      </article>`;
    }).join("");
  }

  /* שלב 3: הוכנו */
  function renderDone() {
    $("#emptyDone").hidden = state.done.length > 0;
    $("#doneList").innerHTML = state.done.map(o => {
      const items = (o.items || []).map(i => `${esc(i.product)} × ${num(i.quantity)}`).join(" · ");
      return `<article class="done-row">
        <div class="done-time"><strong>${esc(when(o.prepared_at))}</strong>${o.started_at ? `<span>התחילו ${esc(new Date(o.started_at).toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" }))}</span>` : ""}</div>
        <div class="done-main"><strong>${esc(o.customer_name)}</strong><span class="muted">הזמנה ${o.order_id}${o.delivery_date ? ` · ${esc(due(o.delivery_date).text)}` : ""}</span><p>${items}</p></div>
        <span class="done-st">${esc(o.status)}</span>
      </article>`;
    }).join("");
  }

  /* ----- לשוניות ----- */
  /* OK בכרטיס קילוף, והחזרה (כפתור קטן ולא בולט) */
  $("#peelGrid").addEventListener("click", e => {
    const card = e.target.closest(".peel-card"); if (!card) return;
    const pid = Number(card.dataset.pid);
    if (e.target.closest("[data-peel]")) { setPeeled(pid, Number(card.dataset.kg)); toast(`${card.dataset.name}: סומן כבוצע`); }
    else if (e.target.closest("[data-unpeel]")) setPeeled(pid, null);
  });

  function setView(v) {
    state.view = v;
    try { localStorage.setItem("mkTabletView", v); } catch (_) {}
    $$(".vtab, .done-link").forEach(x => x.classList.toggle("is-active", x.dataset.view === v));
    $("#peelView").hidden = v !== "peel";
    $("#workView").hidden = v !== "work";
    $("#doneView").hidden = v !== "done";
    window.scrollTo(0, 0);
  }
  $$(".vtab, .done-link, .done-back").forEach(b => b.addEventListener("click", () => setView(b.dataset.view)));
  setView(["peel", "work", "done"].includes(state.view) ? state.view : "peel");

  /* ----- שלב 1 -> 2: "נקלטה" ----- */
  if ($("#queueNew")) $("#queueNew").addEventListener("click", async e => {
    const b = e.target.closest("[data-start]"); if (!b) return;
    unlockAudio();
    if (!navigator.onLine) { toast("אין חיבור לאינטרנט", true); return; }
    const id = Number(b.dataset.start);
    state.starting.add(id); render();
    const { data: ok, error } = await db.rpc("start_production", { p_order_id: id });
    state.starting.delete(id);
    if (error) { toast("הפעולה נכשלה: " + error.message, true); render(); return; }
    toast(ok ? `הזמנה ${id} הועברה לקילוף` : `הזמנה ${id} כבר לא חדשה (אולי בוטלה)`, !ok);
    await load();
  });

  /* ----- שלב 2: סימון מוצר שהוכן ----- */
  $("#queueProd").addEventListener("click", e => {
    const li = e.target.closest("[data-tick]"); if (!li || li.closest(".is-undo")) return;
    const id = Number(li.dataset.tick), it = findItem(id, li.dataset.name);
    if (!it) return;
    // מוצר שעוד לא קולף נעול: קודם מקלפים ומסמנים "OK · קולף" בסה"כ לקילוף
    if (li.classList.contains("unpeeled") && !it.prepared) {
      toast(`${li.dataset.name} עוד לא קולף. קודם מסמנים אותו "קולף" בסה״כ לקילוף`, true);
      return;
    }
    if (!navigator.onLine) { toast("אין חיבור לאינטרנט", true); return; }
    const want = !it.prepared;
    it.prepared = want; render();                       // מיד על המסך
    state.pending = (state.pending || 0) + 1;
    db.rpc("set_line_prepared", { p_line_id: it.line_id, p_done: want }).then(({ data, error }) => {
      state.pending--;
      if (error || !data) { it.prepared = !want; render(); toast("הסימון לא נשמר" + (error ? ": " + error.message : ""), true); }
    });
  });
  $("#queueProd").addEventListener("keydown", e => {
    if ((e.key === " " || e.key === "Enter") && e.target.matches("[data-tick]")) { e.preventDefault(); e.target.click(); }
  });

  /* ----- שלב 2 -> 3: OK (רק כשהכול מסומן), עם כמה שניות לביטול ----- */
  $("#queueProd").addEventListener("click", e => {
    const b = e.target.closest("[data-done]"); if (!b || b.disabled) return;
    unlockAudio();
    if (!navigator.onLine) { toast("אין חיבור לאינטרנט", true); return; }
    const id = Number(b.dataset.done);
    const o = state.orders.find(x => x.order_id === id);
    if (!o || !allTicked(o) || state.undo.has(id)) return;
    const u = { left: UNDO_SEC, timer: null };
    u.timer = setInterval(() => {
      u.left -= 1;
      const sec = document.querySelector(`.ticket[data-id="${id}"] .undo-sec`); if (sec) sec.textContent = u.left;
      if (u.left <= 0) { clearInterval(u.timer); commitDone(id); }
    }, 1000);
    state.undo.set(id, u);
    render();
  });
  $("#queueProd").addEventListener("click", e => {
    const b = e.target.closest("[data-undo]"); if (!b) return;
    const id = Number(b.dataset.undo), u = state.undo.get(id);
    if (u) { clearInterval(u.timer); state.undo.delete(id); toast(`הזמנה ${id} חזרה לרשימה`); render(); }
  });

  async function commitDone(id) {
    state.busy = true;
    const { data: ok, error } = await db.rpc("mark_prepared", { p_order_id: id });
    state.busy = false;
    state.undo.delete(id);
    if (error) { toast("הסימון נכשל: " + error.message, true); render(); return; }
    if (ok) {
      const card = document.querySelector(`.ticket[data-id="${id}"]`);
      if (card) card.classList.add("leaving");
      toast(`הזמנה ${id} הוכנה ✓ ועברה ל"הוכנו"`);
      setTimeout(load, 450);
    } else {
      toast(`הזמנה ${id} כבר לא בייצור (אולי בוטלה)`, true);
      load();
    }
  }

  /* ==========================================================
     זמן אמת + גיבוי
     ========================================================== */
  function setStatus(on, text) { const s = $("#status"); s.classList.toggle("on", on); s.textContent = text || (on ? "מחובר" : "מנותק"); }

  async function startRealtime(session) {
    stopRealtime();
    try { await db.realtime.setAuth(session.access_token); } catch (_) {}
    state.channel = db.channel("production", { config: { private: true } })
      .on("broadcast", { event: "detail_changed" }, () => { clearTimeout(startRealtime.t); startRealtime.t = setTimeout(load, 400); })
      .on("broadcast", { event: "order_edited" }, ({ payload }) => {
        chime(); showAlert(`המנהל עדכן את הזמנה ${(payload || {}).order_id}. בדקו את הכמויות מחדש.`);
        clearTimeout(startRealtime.t); startRealtime.t = setTimeout(load, 300);
      })
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
  setInterval(() => { if (state.orders.length && !state.undo.size) render(); }, 60000); // רענון "לפני X דק׳"
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
