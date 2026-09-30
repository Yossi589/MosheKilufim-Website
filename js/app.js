/* ==========================================================
   משה קילופים — לוגיקת האתר
   הכול נשמר בדפדפן של הלקוח (localStorage), בלי שרת.
   מפתחות השמירה זהים לאתר הקודם, כך שלקוחות קיימים לא יאבדו נתונים
   אם האתר יעלה על אותו דומיין.
   ========================================================== */
(function () {
  "use strict";

  /* ---------- הגדרות ---------- */
  const WHATSAPP_NUMBER = "972527495162";
  const BUSINESS_EMAIL = "Mk.orders3@gmail.com";
  const BUSINESS_PHONE = "098911191";
  const PHONE_HOURS = "א׳–ג׳ וה׳ \u206608:00–16:00\u2069 · יום ד׳ 24 שעות";
  const MAX_HISTORY = 6;
  const KEYS = {
    user: "mosheUserDetails",
    cart: "mosheCart",
    history: "mosheOrderHistory",
    last: "mosheLastOrder",
    pwaDismissed: "moshePwaDismissedTime",
    pwaInstalled: "mosheAppInstalled"
  };

  const PRODUCTS = window.MK_PRODUCTS || [];
  const CATEGORIES = window.MK_CATEGORIES || [];
  const POPULAR = new Set(window.MK_POPULAR || []);
  const byName = new Map(PRODUCTS.map(p => [p.name, p]));
  const byId = new Map(PRODUCTS.map(p => [p.id, p]));

  /* ---------- כלי עזר ---------- */
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const icon = (id, cls = "ic") => `<svg class="${cls}"><use href="#i-${id}"/></svg>`;
  const store = {
    get(k, fallback) { try { const v = localStorage.getItem(k); return v == null ? fallback : JSON.parse(v); } catch (e) { return fallback; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
    raw(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    setRaw(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
    del(k) { try { localStorage.removeItem(k); } catch (e) {} }
  };
  const fmtKg = n => (n % 1 === 0 ? String(n) : n.toFixed(1));
  const packs = n => (n === 1 ? "מארז אחד" : `${n} מארזים`);
  const weightOf = (p, qty) => (p && p.kg ? `${fmtKg(p.kg * qty)} ק״ג` : "");
  const isPWA = () => window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
  const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const validPhone = p => /^0[2-9]\d{7,8}$/.test(String(p).replace(/[-\s]/g, ""));

  /* ---------- מצב ---------- */
  const state = {
    category: "all",
    search: "",
    cart: [],              // [{name, qty}] — אותו מבנה כמו באתר הקודם
    deliveryDate: "",      // ISO
    deliveryLabel: "",
    notes: "",
    modalProduct: null,
    modalQty: 1
  };

  const getUser = () => store.get(KEYS.user, null);
  const getHistory = () => { const h = store.get(KEYS.history, []); return Array.isArray(h) ? h : []; };
  const orderedNames = () => new Set(getHistory().flatMap(e => (e.items || []).map(i => i.name)));

  function loadCart() {
    const saved = store.get(KEYS.cart, []);
    state.cart = Array.isArray(saved) ? saved.filter(i => i && byName.has(i.name) && i.qty > 0) : [];
  }
  const saveCart = () => store.set(KEYS.cart, state.cart);
  const cartQty = name => (state.cart.find(i => i.name === name) || {}).qty || 0;
  const cartTotal = () => state.cart.reduce((s, i) => s + i.qty, 0);
  const cartKg = () => state.cart.reduce((s, i) => s + ((byName.get(i.name) || {}).kg || 0) * i.qty, 0);

  function setQty(name, qty) {
    const ex = state.cart.find(i => i.name === name);
    if (qty <= 0) { if (ex) state.cart.splice(state.cart.indexOf(ex), 1); }
    else if (ex) ex.qty = qty;
    else state.cart.push({ name, qty });
    saveCart();
    refreshCartUI();
  }
  const addQty = (name, delta) => setQty(name, cartQty(name) + delta);

  /* ==========================================================
     קטלוג
     ========================================================== */
  function renderCategoryNav() {
    const counts = {};
    PRODUCTS.forEach(p => { counts[p.category] = (counts[p.category] || 0) + 1; });

    $("#catNav").innerHTML =
      `<button type="button" class="cat-link" data-cat="all">כל המוצרים</button>` +
      CATEGORIES.map(c => `<button type="button" class="cat-link" data-cat="${esc(c.name)}">${esc(c.name)}</button>`).join("") +
      `<a class="cat-link cat-sep" href="#how">איך מזמינים</a><a class="cat-link cat-extra" href="#about">עלינו</a><a class="cat-link cat-extra" href="#contact">צור קשר</a>`;

    $("#chips").innerHTML =
      `<button type="button" class="chip" data-cat="all" role="tab">הכול</button>` +
      CATEGORIES.map(c => `<button type="button" class="chip" data-cat="${esc(c.name)}" role="tab">${esc(c.name)}</button>`).join("");

    $("#catTiles").innerHTML = CATEGORIES.map(c => `
      <button type="button" class="cat-tile" data-cat="${esc(c.name)}" data-scroll="1">
        <img src="img/thumbs/${esc(c.image)}" alt="" width="132" height="132" loading="lazy">
        <strong>${esc(c.name)}</strong>
        <span>${counts[c.name] || 0} מוצרים</span>
      </button>`).join("");

    const pc = $("#productCount"); if (pc) pc.textContent = PRODUCTS.length;
  }

  function markActiveCategory() {
    $$("[data-cat]").forEach(b => {
      if (b.classList.contains("cat-tile")) return;
      const on = !state.search && b.dataset.cat === state.category;
      b.classList.toggle("is-active", on);
      if (b.classList.contains("chip")) b.setAttribute("aria-selected", on ? "true" : "false");
    });
  }

  function filteredProducts() {
    const q = state.search.trim().toLowerCase();
    let list = PRODUCTS.filter(p => {
      const inCat = state.category === "all" || p.category === state.category;
      const inSearch = !q || [p.name, p.category, p.desc, p.pack].some(t => t.toLowerCase().includes(q));
      return (q ? inSearch : inCat);
    });
    // לקוח רשום: מוצרים שכבר הזמין מופיעים ראשונים
    if (!q && getUser()) {
      const ordered = orderedNames();
      list = list.slice().sort((a, b) => (ordered.has(a.name) ? 0 : 1) - (ordered.has(b.name) ? 0 : 1));
    }
    return list;
  }

  function cardFoot(p) {
    const q = cartQty(p.name);
    if (!q) return `<button type="button" class="btn btn-primary" data-add="${p.id}">${icon("plus")} הוספה לסל</button>`;
    return `
      <div class="stepper" role="group" aria-label="כמות ${esc(p.name)}">
        <button type="button" data-dec="${p.id}" aria-label="פחות">${icon("minus")}</button>
        <output>${q}</output>
        <button type="button" data-inc="${p.id}" aria-label="עוד">${icon("plus")}</button>
      </div>
      <span class="weight">${packs(q)} · ${weightOf(p, q)}</span>`;
  }

  function renderProducts() {
    const list = filteredProducts();
    const isUser = !!getUser();
    const ordered = orderedNames();
    $("#productGrid").innerHTML = list.map(p => {
      let badge = "";
      if (isUser && ordered.has(p.name)) badge = `<span class="badge badge-past">הזמנתם בעבר</span>`;
      else if (POPULAR.has(p.id)) badge = `<span class="badge">הכי מוזמן</span>`;
      return `
        <article class="card" data-id="${p.id}">
          <button type="button" class="card-media" data-open-product="${p.id}" aria-label="פרטים על ${esc(p.name)}">
            <img src="img/products/${esc(p.image)}" alt="${esc(p.name)}" width="800" height="533" loading="lazy">
            ${badge}
          </button>
          <div class="card-body">
            <h3><button type="button" data-open-product="${p.id}">${esc(p.name)}</button></h3>
            <p class="pack">${esc(p.pack)}</p>
            <div class="card-foot" id="foot-${p.id}">${cardFoot(p)}</div>
          </div>
        </article>`;
    }).join("");
    $("#noResults").hidden = list.length > 0;
    let label;
    if (state.search) label = `${list.length} תוצאות עבור "${state.search}"`;
    else if (state.category === "all") label = `${list.length} מוצרים`;
    else label = `${list.length} מוצרים ב${state.category}`;
    $("#resultCount").textContent = label;
    markActiveCategory();
  }

  function refreshCardFoot(p) {
    const f = document.getElementById(`foot-${p.id}`);
    if (f) f.innerHTML = cardFoot(p);
  }

  function setCategory(cat, scroll) {
    state.category = cat;
    state.search = "";
    $("#searchInput").value = "";
    renderProducts();
    if (scroll) $("#catalog").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  /* ==========================================================
     חלון מוצר
     ========================================================== */
  function openProduct(id) {
    const p = byId.get(id); if (!p) return;
    state.modalProduct = p;
    state.modalQty = Math.max(1, cartQty(p.name) || 1);
    const img = $("#pmImage"); img.src = `img/products/${p.image}`; img.alt = p.name;
    $("#pmCat").textContent = p.category;
    $("#pmName").textContent = p.name;
    $("#pmDesc").textContent = p.desc;
    $("#pmPack").textContent = p.pack;
    $("#pmAdd").textContent = cartQty(p.name) ? "עדכון הכמות בסל" : "הוספה לסל";
    updateModalQty();
    openLayer("productModal");
  }
  function updateModalQty() {
    const p = state.modalProduct; if (!p) return;
    $("#pmQty").textContent = state.modalQty;
    $("#pmWeight").textContent = `${packs(state.modalQty)} · ${weightOf(p, state.modalQty)}`;
  }

  /* ==========================================================
     סל ההזמנה
     ========================================================== */
  function nextDeliveryDays() {
    const names = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];
    const out = [];
    for (let i = 1; out.length < 6 && i < 12; i++) {
      const d = new Date(); d.setDate(d.getDate() + i);
      if (d.getDay() === 6) continue; // אין אספקה בשבת
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const dm = d.toLocaleDateString("he-IL", { day: "2-digit", month: "2-digit" });
      const day = i === 1 ? "מחר" : names[d.getDay()];
      out.push({ iso, day, dm, label: `${i === 1 ? "מחר, " : "יום "}${names[d.getDay()]} ${dm}` });
    }
    return out;
  }

  function historyCards(limit) {
    return getHistory().slice(0, limit).map((e, i) => {
      const items = e.items || [];
      const total = items.reduce((s, x) => s + x.qty, 0);
      const names = items.slice(0, 3).map(x => x.name).join(", ") + (items.length > 3 ? ` ועוד ${items.length - 3}` : "");
      return `
        <div class="hist-card">
          <div class="hist-top"><span>${icon("calendar")} ${esc(e.date)}</span><strong>${packs(total)}</strong></div>
          <p class="hist-items">${esc(names)}</p>
          <button type="button" class="btn btn-soft btn-sm" data-reorder="${i}">${icon("refresh")} הזמנה חוזרת</button>
        </div>`;
    }).join("");
  }

  function renderCartDrawer() {
    const body = $("#cartBody");
    const user = getUser();
    const hist = getHistory();

    if (!state.cart.length) {
      const last = store.get(KEYS.last, []);
      body.innerHTML = `
        <div class="cart-empty">
          ${icon("cart")}
          <h3>הסל עדיין ריק</h3>
          <p>הוסיפו מוצרים מהקטלוג, ונחזור אליכם עם הצעת מחיר.</p>
          <a href="#catalog" class="btn btn-primary" data-close-go>לקטלוג המוצרים</a>
        </div>
        ${Array.isArray(last) && last.length && user ? `
          <div class="drawer-section">
            <button type="button" class="btn btn-dark btn-block" data-reorder="-1">${icon("refresh")} שחזור ההזמנה האחרונה</button>
          </div>` : ""}
        ${hist.length && user ? `
          <div class="drawer-section">
            <h3>${icon("list")} הזמנות קודמות</h3>
            <div class="history">${historyCards(2)}</div>
          </div>` : ""}`;
      return;
    }

    const items = state.cart.map(item => {
      const p = byName.get(item.name) || {};
      return `
        <div class="cart-item">
          <img src="img/thumbs/${esc(p.image)}" alt="" width="58" height="58">
          <div>
            <h4>${esc(item.name)}</h4>
            <p class="pack">${esc(p.pack || "")}</p>
            <p class="pack"><strong>${weightOf(p, item.qty)}</strong></p>
          </div>
          <div class="cart-item-ctrl">
            <div class="row">
              <div class="stepper stepper-sm">
                <button type="button" data-dec="${p.id}" aria-label="פחות">${icon("minus")}</button>
                <strong>${item.qty}</strong>
                <button type="button" data-inc="${p.id}" aria-label="עוד">${icon("plus")}</button>
              </div>
              <button type="button" class="remove" data-remove="${p.id}" aria-label="הסרת ${esc(item.name)}">${icon("trash")}</button>
            </div>
          </div>
        </div>`;
    }).join("");

    const suggestions = PRODUCTS.filter(p => POPULAR.has(p.id) && !cartQty(p.name)).slice(0, 4);
    const days = nextDeliveryDays();

    const userBlock = user ? `
        <div class="who">
          <span class="avatar">${esc((user.business || user.name || "?").charAt(0))}</span>
          <div><strong>${esc(user.name)}</strong><small>${esc([user.business, user.city].filter(Boolean).join(" · ") || user.phone)}</small></div>
          <button type="button" class="link-btn" data-open="account">עריכה</button>
        </div>` : `
        <p class="intro">פעם ראשונה אצלנו? השאירו פרטים, והם יישמרו להזמנה הבאה.</p>
        <div class="two">
          <div class="field" data-f="name"><label for="oName">שם מלא *</label><input id="oName" autocomplete="name"><span class="err">צריך למלא שם</span></div>
          <div class="field" data-f="phone"><label for="oPhone">טלפון *</label><input id="oPhone" type="tel" inputmode="tel" autocomplete="tel"><span class="err">מספר טלפון לא תקין</span></div>
        </div>
        <div class="two">
          <div class="field"><label for="oBiz">שם העסק / המוסד</label><input id="oBiz" autocomplete="organization"></div>
          <div class="field"><label for="oCity">עיר לאספקה</label><input id="oCity" autocomplete="address-level2"></div>
        </div>`;

    body.innerHTML = `
      <div class="drawer-section">
        <div class="order-box">
          <div class="order-box-head">
            <h3>${icon("cart")} ההזמנה שלי</h3>
            <span>${state.cart.length === 1 ? "מוצר אחד" : `${state.cart.length} מוצרים`}</span>
          </div>
          <div class="cart-list">${items}</div>
          <p class="price-note">המחיר נקבע לפי המוצר והכמות. נחזור אליכם עם הצעת מחיר מסודרת.</p>
        </div>
      </div>

      ${suggestions.length ? `
      <div class="drawer-section">
        <h3>אולי תצטרכו גם</h3>
        <div class="suggest">${suggestions.map(p => `
          <div class="mini">
            <img src="img/thumbs/${esc(p.image)}" alt="" width="64" height="64" loading="lazy">
            <span>${esc(p.name)}</span>
            <button type="button" class="btn btn-soft btn-sm" data-add="${p.id}">${icon("plus")} הוספה</button>
          </div>`).join("")}
        </div>
      </div>` : ""}

      <div class="drawer-section">
        <h3>${icon("user")} ${user ? "מזמינים בשם" : "פרטי המזמין"}</h3>
        ${userBlock}
      </div>

      <div class="drawer-section dates-wrap" id="datesWrap">
        <h3>${icon("calendar")} מתי לספק? *</h3>
        <div class="dates" role="radiogroup" aria-label="יום אספקה">
          ${days.map(d => `
            <button type="button" class="date${state.deliveryDate === d.iso ? " is-active" : ""}" role="radio" aria-checked="${state.deliveryDate === d.iso}" data-date="${d.iso}" data-label="${esc(d.label)}">
              <strong>${esc(d.day)}</strong><span>${esc(d.dm)}</span>
            </button>`).join("")}
        </div>
        <p class="dates-err">בחרו יום אספקה</p>
      </div>

      <div class="drawer-section">
        <div class="field">
          <label for="oNotes">הערות להזמנה</label>
          <textarea id="oNotes" placeholder="למשל: חיתוך מיוחד, שעת אספקה, כניסה מהאחור">${esc(state.notes)}</textarea>
        </div>
      </div>

      <div class="send">
        <button type="button" class="btn btn-wa btn-lg" data-send="whatsapp">${icon("chat")} ${user ? "שליחת ההזמנה בוואטסאפ" : "קבלת הצעת מחיר בוואטסאפ"}</button>
        <div class="send-row">
          <a class="btn btn-soft" href="tel:${BUSINESS_PHONE}" data-send="phone">${icon("phone")} בטלפון</a>
          <button type="button" class="btn btn-soft" data-send="mail">${icon("mail")} במייל</button>
        </div>
      </div>`;
  }

  function refreshCartUI() {
    const total = cartTotal();
    ["#cartCount", "#bnCount"].forEach(sel => {
      const el = $(sel); if (!el) return;
      el.textContent = total; el.hidden = total === 0;
    });
    $("#cartBtn").setAttribute("aria-label", total ? `סל ההזמנה, ${packs(total)}` : "סל ההזמנה");
    PRODUCTS.forEach(refreshCardFoot);
    if (!$("#cartDrawer").hidden) {
      const notes = $("#oNotes"); if (notes) state.notes = notes.value;
      const keep = collectDraftFields();
      const body = $("#cartBody"); const top = body.scrollTop;
      renderCartDrawer();
      restoreDraftFields(keep);
      body.scrollTop = top;
    }
  }

  // שמירת מה שהלקוח הקליד בטופס כשהסל מתרנדר מחדש
  function collectDraftFields() {
    const o = {};
    ["oName", "oPhone", "oBiz", "oCity"].forEach(id => { const el = document.getElementById(id); if (el) o[id] = el.value; });
    return o;
  }
  function restoreDraftFields(o) {
    Object.keys(o).forEach(id => { const el = document.getElementById(id); if (el) el.value = o[id]; });
  }

  function reorder(idx) {
    const items = idx === -1 ? store.get(KEYS.last, []) : ((getHistory()[idx] || {}).items || []);
    state.cart = (items || []).filter(i => byName.has(i.name)).map(i => ({ name: i.name, qty: i.qty }));
    saveCart();
    refreshCartUI();
    renderProducts();
    if ($("#cartDrawer").hidden) openLayer("cartDrawer");
    toast("ההזמנה שוחזרה לסל");
  }

  /* ---------- שליחת הזמנה ---------- */
  function markField(key, bad) {
    const f = $(`.field[data-f="${key}"]`); if (f) f.classList.toggle("invalid", bad);
  }

  // בודק את פרטי הלקוח (בלי לשמור). מחזיר null אם חסר משהו
  function readUserFromForm() {
    const saved = getUser();
    if (saved) return saved;
    const name = ($("#oName") || {}).value?.trim() || "";
    const phone = ($("#oPhone") || {}).value?.trim() || "";
    markField("name", !name);
    markField("phone", !validPhone(phone));
    if (!name || !validPhone(phone)) return null;
    return { name, phone, business: ($("#oBiz") || {}).value?.trim() || "", city: ($("#oCity") || {}).value?.trim() || "" };
  }

  function checkDate() {
    const ok = !!state.deliveryDate;
    $("#datesWrap").classList.toggle("invalid", !ok);
    return ok;
  }

  function buildOrderText(u) {
    const lines = state.cart.map(item => {
      const p = byName.get(item.name);
      return `• ${item.name} - ${packs(item.qty)}${p ? ` (${weightOf(p, item.qty)})` : ""}`;
    }).join("\n");
    const returning = getHistory().length > 0;
    const greeting = returning
      ? (u.business ? `שלום, זה ${u.name} מ-${u.business},` : `שלום, זה ${u.name},`)
      : "שלום, אשמח לקבל הצעת מחיר ממשה קילופים:";
    return `${greeting}\n\n*פרטי לקוח:*\n*שם:* ${u.name}\n*טלפון:* ${u.phone}\n*עסק/מוסד:* ${u.business || "-"}\n*עיר אספקה:* ${u.city || "-"}` +
      (state.deliveryLabel ? `\n*תאריך אספקה:* ${state.deliveryLabel}` : "") +
      `\n\n*מוצרים:*\n${lines}\n\n*סה״כ:* ${packs(cartTotal())} (${fmtKg(cartKg())} ק״ג)` +
      (state.notes ? `\n\n*הערות:*\n${state.notes}` : "");
  }

  function finishOrder() {
    const h = getHistory();
    const snap = state.cart.map(i => ({ name: i.name, qty: i.qty }));
    h.unshift({ date: new Date().toLocaleDateString("he-IL"), items: snap });
    if (h.length > MAX_HISTORY) h.length = MAX_HISTORY;
    store.set(KEYS.history, h);
    store.set(KEYS.last, snap);
    state.cart = []; state.notes = ""; state.deliveryDate = ""; state.deliveryLabel = "";
    saveCart();
    refreshUserUI();
    refreshCartUI();
    renderProducts();
  }

  function send(type, ev) {
    if (!state.cart.length) { if (ev) ev.preventDefault(); return; }
    const notesEl = $("#oNotes"); if (notesEl) state.notes = notesEl.value.trim();
    const u = readUserFromForm();
    const dateOk = type === "phone" || checkDate();
    if (!u || !dateOk) {
      if (ev) ev.preventDefault();
      const firstBad = $("#cartBody .field.invalid, #datesWrap.invalid");
      if (firstBad) {
        firstBad.scrollIntoView({ behavior: "smooth", block: "center" });
        const inp = firstBad.querySelector("input"); if (inp) inp.focus({ preventScroll: true });
      }
      return;
    }
    if (!getUser()) store.set(KEYS.user, u);
    const text = buildOrderText(u);
    if (type === "whatsapp") {
      window.open(`https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(text)}`, "_blank", "noopener");
    } else if (type === "mail") {
      window.location.href = `mailto:${BUSINESS_EMAIL}?subject=${encodeURIComponent("הזמנה / בקשה להצעת מחיר — משה קילופים")}&body=${encodeURIComponent(text)}`;
    } // phone: הקישור tel: עצמו מחייג
    finishOrder();
    closeLayer("cartDrawer");
    showSuccess(type);
  }

  function showSuccess(type) {
    const ic = $("#successIc");
    ic.className = "success-ic";
    const map = {
      whatsapp: ["chat", "", "ההזמנה מוכנה בוואטסאפ!", "לחצו 'שליחה' בוואטסאפ, ונחזור אליכם עם הצעת מחיר מסודרת.", "נעדכן אתכם שקיבלנו את ההזמנה"],
      phone: ["phone", "phone", "מחכים לשיחה שלכם", "הפרטים וההזמנה נשמרו. נתאם איתכם הכול בטלפון.", `שעות מענה: ${PHONE_HOURS}`],
      mail: ["mail", "mail", "המייל מוכן לשליחה", "אחרי שליחת המייל נחזור אליכם עם הצעת מחיר מסודרת.", "נחזור אליכם תוך יום עסקים"],
      register: ["check", "", "ברוכים הבאים!", "הפרטים נשמרו. מעכשיו מזמינים בכמה לחיצות.", "ההזמנות הקודמות שלכם יחכו לכם באזור האישי"]
    };
    const [ic2, cls, title, msg, note] = map[type] || map.register;
    if (cls) ic.classList.add(cls);
    ic.innerHTML = icon(ic2);
    $("#successTitle").textContent = title;
    $("#successMsg").textContent = msg;
    $("#successNote").textContent = note;
    openLayer("successModal");
  }

  /* ==========================================================
     אזור אישי
     ========================================================== */
  function greetingByHour() {
    const h = new Date().getHours();
    if (h >= 5 && h < 12) return "בוקר טוב";
    if (h >= 12 && h < 17) return "צהריים טובים";
    if (h >= 17 && h < 21) return "ערב טוב";
    return "לילה טוב";
  }

  function myTopProducts() {
    const counts = {};
    getHistory().forEach(o => (o.items || []).forEach(i => { counts[i.name] = (counts[i.name] || 0) + i.qty; }));
    return Object.keys(counts).filter(n => byName.has(n)).sort((a, b) => counts[b] - counts[a]).slice(0, 5).map(n => byName.get(n));
  }

  function miniCard(p) {
    const q = cartQty(p.name);
    const ctrl = q
      ? `<div class="stepper stepper-sm"><button type="button" data-dec="${p.id}" aria-label="פחות">${icon("minus")}</button><strong>${q}</strong><button type="button" data-inc="${p.id}" aria-label="עוד">${icon("plus")}</button></div>`
      : `<button type="button" class="btn btn-soft btn-sm" data-add="${p.id}">${icon("plus")} הוספה</button>`;
    return `<div class="mini"><img src="img/thumbs/${esc(p.image)}" alt="" width="64" height="64" loading="lazy"><span>${esc(p.name)}</span>${ctrl}</div>`;
  }

  function registerFormHTML(u, submitLabel) {
    u = u || {};
    return `
      <form id="regForm" novalidate>
        <div class="field" data-f="rname"><label for="rName">שם מלא *</label><input id="rName" value="${esc(u.name)}" autocomplete="name" required><span class="err">צריך למלא שם</span></div>
        <div class="field" data-f="rphone"><label for="rPhone">טלפון *</label><input id="rPhone" type="tel" inputmode="tel" value="${esc(u.phone)}" autocomplete="tel" required><span class="err">מספר טלפון לא תקין</span></div>
        <div class="field"><label for="rBiz">שם העסק / המוסד</label><input id="rBiz" value="${esc(u.business)}" autocomplete="organization"></div>
        <div class="field"><label for="rCity">עיר לאספקה</label><input id="rCity" value="${esc(u.city)}" autocomplete="address-level2"></div>
        <button type="submit" class="btn btn-primary btn-block btn-lg">${submitLabel}</button>
      </form>`;
  }

  function renderAccount() {
    const body = $("#accountBody");
    const u = getUser();
    if (!u) {
      body.innerHTML = `
        <div class="drawer-section">
          <p class="accent-line">נעים להכיר!</p>
          <h3 style="font-size:1.4rem;margin-bottom:6px">הרשמה ללקוחות</h3>
          <p class="intro">משאירים פרטים פעם אחת, ומקבלים הזמנה חוזרת בלחיצה, רשימת "המוצרים שלי" והיסטוריית הזמנות. הפרטים נשמרים רק במכשיר שלכם.</p>
          ${registerFormHTML(null, "שמירת הפרטים")}
        </div>`;
      return;
    }
    const top = myTopProducts();
    const recs = top.length ? top : PRODUCTS.filter(p => POPULAR.has(p.id));
    const hist = getHistory();
    const prevScroll = body.scrollTop;
    requestAnimationFrame(() => { body.scrollTop = prevScroll; });
    body.innerHTML = `
      <div class="drawer-section">
        <div class="greet">
          <span class="avatar">${esc((u.business || u.name || "?").charAt(0))}</span>
          <div><h3>${greetingByHour()}, ${esc((u.name || "").split(" ")[0])}</h3><p>${esc(u.business || "משה קילופים איתכם")}</p></div>
        </div>
      </div>

      <div class="drawer-section">
        <h3>${icon("grid")} ${top.length ? "המוצרים שלי" : "הכי מוזמנים אצלנו"}</h3>
        <div class="suggest" id="myProducts">${recs.map(miniCard).join("")}</div>
      </div>

      <div class="drawer-section" id="historySection">
        <h3>${icon("list")} הזמנות אחרונות</h3>
        ${hist.length ? `<div class="history">${historyCards(2)}</div>` : `<p class="muted">עוד לא שלחתם הזמנה מהאתר.</p>`}
      </div>

      <div class="drawer-section">
        <h3>${icon("user")} הפרטים שלי</h3>
        <div class="who">
          <div><strong>${esc(u.name)}</strong><small dir="ltr" style="text-align:right">${esc(u.phone)}</small><small>${esc([u.business, u.city].filter(Boolean).join(" · "))}</small></div>
          <button type="button" class="link-btn" id="editToggle">עריכה</button>
        </div>
        <div class="edit-form" id="editForm">${registerFormHTML(u, "שמירת השינויים")}</div>
      </div>

      <div class="drawer-section acct-actions">
        ${isPWA() ? "" : `<button type="button" class="btn btn-soft" id="installBtn">${icon("download")} התקנת האפליקציה בטלפון</button>`}
        <button type="button" class="btn btn-soft" id="logoutBtn">${icon("logout")} התנתקות</button>
      </div>`;
  }

  function submitRegistration(e) {
    e.preventDefault();
    const name = $("#rName").value.trim();
    const phone = $("#rPhone").value.trim();
    markField("rname", !name);
    markField("rphone", !validPhone(phone));
    if (!name || !validPhone(phone)) { (!name ? $("#rName") : $("#rPhone")).focus(); return; }
    const wasUser = !!getUser();
    store.set(KEYS.user, { name, phone, business: $("#rBiz").value.trim(), city: $("#rCity").value.trim() });
    refreshUserUI();
    renderProducts();
    if (wasUser) { renderAccount(); toast("הפרטים עודכנו"); }
    else { closeLayer("accountDrawer"); showSuccess("register"); }
  }

  function refreshUserUI() {
    const u = getUser();
    const av = $("#headerAvatar");
    if (u) {
      av.textContent = (u.business || u.name || "?").charAt(0);
      av.hidden = false;
      $("#headerUserIcon").style.display = "none";
      $("#accountBtnLabel").textContent = "אזור אישי";
      $("#heroLoginBtn").hidden = true;
    } else {
      av.hidden = true;
      $("#headerUserIcon").style.display = "";
      $("#accountBtnLabel").textContent = "כניסה ללקוחות";
      $("#heroLoginBtn").hidden = false;
    }
    if (!$("#accountDrawer").hidden) renderAccount();
  }

  /* ==========================================================
     שכבות (מגירות וחלונות)
     ========================================================== */
  let lastFocus = null;
  const openStack = [];

  function openLayer(id, opts = {}) {
    const el = document.getElementById(id);
    if (!el) return;
    if (id === "cartDrawer") renderCartDrawer();
    if (id === "accountDrawer") renderAccount();
    // מגירה אחת בכל פעם
    if (el.classList.contains("drawer")) $$(".drawer").forEach(d => { if (d !== el && !d.hidden) closeLayer(d.id, true); });
    if (!openStack.length) lastFocus = document.activeElement;
    if (!openStack.includes(id)) openStack.push(id);
    el.hidden = false;
    document.body.classList.add("lock");
    if (el.classList.contains("drawer")) {
      const scrim = $("#scrim"); scrim.hidden = false;
      requestAnimationFrame(() => { scrim.classList.add("show"); el.classList.add("open"); });
    }
    setTimeout(() => {
      if (opts.focus) { const sec = document.getElementById(opts.focus); if (sec) sec.scrollIntoView({ block: "start" }); }
      const wantsInput = id === "accountDrawer" && !getUser() && window.innerWidth > 860;
      const f = (wantsInput && el.querySelector("input")) || el.querySelector("[data-close]") || el.querySelector("button");
      if (f) f.focus({ preventScroll: true });
    }, 80);
  }

  function closeLayer(id, silent) {
    const el = document.getElementById(id);
    if (!el || el.hidden) return;
    const i = openStack.indexOf(id); if (i > -1) openStack.splice(i, 1);
    if (el.classList.contains("drawer")) {
      if (id === "cartDrawer") { const n = $("#oNotes"); if (n) state.notes = n.value; }
      el.classList.remove("open");
      const anyDrawer = $$(".drawer").some(d => d !== el && !d.hidden);
      if (!anyDrawer) $("#scrim").classList.remove("show");
      setTimeout(() => { el.hidden = true; if (!$$(".drawer").some(d => !d.hidden)) $("#scrim").hidden = true; }, 280);
    } else {
      el.hidden = true;
    }
    if (!openStack.length) {
      document.body.classList.remove("lock");
      if (!silent && lastFocus && lastFocus.focus) lastFocus.focus({ preventScroll: true });
    }
  }
  const closeTop = () => { const id = openStack[openStack.length - 1]; if (id) closeLayer(id); };

  /* ==========================================================
     משוב קטן
     ========================================================== */
  let toastTimer;
  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg; t.classList.add("show");
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), 1800);
  }
  function addFeedback(ev, name) {
    try { navigator.vibrate && navigator.vibrate(30); } catch (e) {}
    if (ev && ev.clientX) {
      const s = document.createElement("span");
      s.className = "plus-one"; s.textContent = "+1";
      s.style.left = ev.clientX - 10 + "px"; s.style.top = ev.clientY - 20 + "px";
      document.body.appendChild(s); setTimeout(() => s.remove(), 800);
    }
    ["#cartBtn", "#bnCart .bn-fab-circle"].forEach(sel => {
      const el = $(sel); if (!el) return;
      el.classList.remove("wiggle"); void el.offsetWidth; el.classList.add("wiggle");
    });
    if (name) toast(`${name} נוסף לסל`);
  }

  /* ==========================================================
     אירועים
     ========================================================== */
  document.addEventListener("click", e => {
    const t = e.target.closest("button, a");
    if (!t) { if (e.target.id === "scrim") closeTop(); else if (e.target.classList.contains("modal")) closeLayer(e.target.id); return; }
    const d = t.dataset;

    if (d.cat) { setCategory(d.cat, !!d.scroll || t.classList.contains("cat-link")); return; }
    if (d.openProduct) { openProduct(d.openProduct); return; }
    if (d.add) { const p = byId.get(d.add); addQty(p.name, 1); addFeedback(e, p.name); if (!$("#accountDrawer").hidden) renderAccount(); return; }
    if (d.inc) { const p = byId.get(d.inc); addQty(p.name, 1); addFeedback(e); if (!$("#accountDrawer").hidden) renderAccount(); return; }
    if (d.dec) { const p = byId.get(d.dec); addQty(p.name, -1); if (!$("#accountDrawer").hidden) renderAccount(); return; }
    if (d.remove) { const p = byId.get(d.remove); setQty(p.name, 0); return; }
    if (d.reorder !== undefined) { reorder(Number(d.reorder)); return; }
    if (d.date) {
      state.deliveryDate = d.date; state.deliveryLabel = d.label;
      $$(".date").forEach(b => { const on = b === t; b.classList.toggle("is-active", on); b.setAttribute("aria-checked", on); });
      $("#datesWrap").classList.remove("invalid");
      return;
    }
    if (d.send) { if (d.send !== "phone") e.preventDefault(); send(d.send, e); return; }
    if (d.open) { e.preventDefault(); openLayer(d.open === "cart" ? "cartDrawer" : "accountDrawer", d.focus === "history" ? { focus: "historySection" } : {}); return; }
    if (d.close !== undefined) { const layer = t.closest(".drawer, .modal"); if (layer) closeLayer(layer.id); return; }
    if (d.closeGo !== undefined) { closeLayer("cartDrawer"); return; }

    if (t.id === "pmMinus") { state.modalQty = Math.max(1, state.modalQty - 1); updateModalQty(); return; }
    if (t.id === "pmPlus") { state.modalQty++; updateModalQty(); return; }
    if (t.id === "pmAdd") {
      const p = state.modalProduct; if (!p) return;
      const had = cartQty(p.name);
      setQty(p.name, state.modalQty);
      closeLayer("productModal");
      addFeedback(e, had ? null : p.name);
      if (had) toast("הכמות עודכנה");
      return;
    }
    if (t.id === "editToggle") { const f = $("#editForm"); f.classList.toggle("open"); t.textContent = f.classList.contains("open") ? "סגירה" : "עריכה"; return; }
    if (t.id === "logoutBtn") {
      if (confirm("להתנתק? הפרטים יימחקו מהמכשיר הזה (ההזמנות הקודמות יישמרו).")) {
        store.del(KEYS.user); refreshUserUI(); renderProducts(); renderAccount();
      }
      return;
    }
    if (t.id === "installBtn") { handleInstall(); return; }
    if (t.id === "pwaInstall") { handleInstall(); return; }
    if (t.id === "pwaDismiss") { $("#pwaBanner").hidden = true; store.setRaw(KEYS.pwaDismissed, String(Date.now())); return; }
  });

  document.addEventListener("submit", e => { if (e.target.id === "regForm") submitRegistration(e); });
  document.addEventListener("input", e => {
    if (e.target.id === "oNotes") state.notes = e.target.value;
    const f = e.target.closest(".field.invalid"); if (f) f.classList.remove("invalid");
  });
  document.addEventListener("keydown", e => { if (e.key === "Escape") closeTop(); });

  let searchTimer;
  $("#searchInput").addEventListener("input", e => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      const had = !!state.search;
      state.search = e.target.value.trim();
      if (!state.search) state.category = "all";
      renderProducts();
      if (state.search && !had) {
        const r = $("#catalog").getBoundingClientRect();
        if (r.top > window.innerHeight * .5 || r.bottom < 0) $("#catalog").scrollIntoView({ behavior: "smooth", block: "start" });
      }
    }, 160);
  });

  // צל לכותרת בגלילה
  const header = $("#siteHeader");
  const onScroll = () => header.classList.toggle("scrolled", window.scrollY > 10);
  window.addEventListener("scroll", onScroll, { passive: true });

  // עדכון גובה הכותרת לגלילה לעוגנים
  const setHeaderH = () => document.documentElement.style.setProperty("--header-h", header.offsetHeight + "px");
  window.addEventListener("resize", setHeaderH);

  /* ==========================================================
     אפליקציה (PWA)
     ========================================================== */
  let deferredPrompt = null;

  function bannerShouldHide() {
    if (window.innerWidth >= 861 || isPWA()) return true;
    if (store.raw(KEYS.pwaInstalled) === "true") return true;
    const t = parseInt(store.raw(KEYS.pwaDismissed) || "0", 10);
    if (t && Date.now() - t < 14 * 24 * 60 * 60 * 1000) return true;
    return false;
  }

  async function handleInstall() {
    $("#pwaBanner").hidden = true;
    if (deferredPrompt) {
      deferredPrompt.prompt();
      try { await deferredPrompt.userChoice; } catch (e) {}
      deferredPrompt = null;
      return;
    }
    const steps = isIOS()
      ? [["share", "פותחים את תפריט השיתוף", "בספארי, לוחצים על כפתור השיתוף (ריבוע עם חץ למעלה) בתחתית המסך."],
         ["plus", "מוסיפים למסך הבית", "גוללים מעט למטה, בוחרים \"הוסף למסך הבית\" ולוחצים \"הוסף\"."]]
      : [["dots", "פותחים את תפריט הדפדפן", "בכרום, לוחצים על שלוש הנקודות בפינה העליונה של המסך."],
         ["download", "מתקינים את האפליקציה", "בוחרים \"התקנת אפליקציה\" או \"הוספה למסך הבית\" ומאשרים."]];
    $("#installSteps").innerHTML = steps.map(([ic, t, s]) => `<li>${icon(ic)}<div><strong>${t}</strong><span>${s}</span></div></li>`).join("");
    openLayer("installModal");
  }

  window.addEventListener("beforeinstallprompt", e => {
    e.preventDefault();
    deferredPrompt = e;
    if (!bannerShouldHide()) $("#pwaBanner").hidden = false;
  });
  window.addEventListener("appinstalled", () => {
    store.setRaw(KEYS.pwaInstalled, "true");
    $("#pwaBanner").hidden = true;
    deferredPrompt = null;
  });

  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
  }

  /* ==========================================================
     הפעלה
     ========================================================== */
  function init() {
    loadCart();
    renderCategoryNav();
    renderProducts();
    refreshUserUI();
    refreshCartUI();
    setHeaderH();
    onScroll();
    const y = $("#year"); if (y) y.textContent = new Date().getFullYear();

    if (isPWA()) document.body.classList.add("is-pwa");
    // פתיחה ראשונה של האפליקציה המותקנת בלי פרטים — מציעים הרשמה
    if (isPWA() && !getUser()) setTimeout(() => openLayer("accountDrawer"), 400);
    // אייפון: אין אירוע התקנה, מציגים באנר עם הדרכה
    if (isIOS() && !bannerShouldHide()) setTimeout(() => { $("#pwaBanner").hidden = false; }, 2500);
  }

  init();
})();
