/* Санкционный дашборд · Банки РФ — вся логика фронта.
   Данные грузятся один раз из /api/data; сортировка/поиск/фильтры — в памяти. */

const JURS = ["US", "EU", "UK", "JP"];
const FLAGS = { US: "🇺🇸", EU: "🇪🇺", UK: "🇬🇧", JP: "🇯🇵" };
const BADGE_COLOR = {
  sdn: "b-red",
  eu_freeze: "b-orange", uk_freeze: "b-orange", jp_freeze: "b-orange", eu_swift: "b-orange",
  ssi: "b-amber", capta: "b-amber", eu_capital: "b-amber",
  uk_invban: "b-amber", jp_capital: "b-amber",
};
const LOCALES = { ru: "ru-RU", en: "en-US", ja: "ja-JP" };

const state = {
  data: null,
  dict: {},
  lang: localStorage.getItem("sb_lang") || "ru",
  currency: localStorage.getItem("sb_cur") || "RUB",
  sort: { key: "assets", dir: -1 },
  filter: null,          // null | US | EU | UK | JP | any | all4 | recent30
  query: "",
  hideNko: false,
  openRegn: null,
};

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function t(path, params = {}) {
  let cur = state.dict;
  for (const p of path.split(".")) cur = cur?.[p];
  if (typeof cur !== "string") return path;
  return cur.replace(/\{(\w+)\}/g, (_, k) => params[k] ?? "");
}

/* ── форматирование ─────────────────────────────────────── */

function fxRate() {
  const fx = state.data.meta.fx || {};
  return state.currency === "USD" ? fx.USD : state.currency === "JPY" ? fx.JPY : 1;
}

function fmtBln(kt) {
  if (kt == null) return t("table.no_data");
  const v = kt / (1e6 * fxRate());
  return new Intl.NumberFormat(LOCALES[state.lang],
    { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(v);
}

function fmtPct(x) {
  if (x == null) return t("table.no_data");
  return new Intl.NumberFormat(LOCALES[state.lang],
    { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(x);
}

const fmtDate = (iso) => iso ? iso.slice(8, 10) + "." + iso.slice(5, 7) + "." + iso.slice(0, 4) : "";
const fmtMMYY = (iso) => iso ? iso.slice(5, 7) + "." + iso.slice(2, 4) : "";

function bankName(b) {
  return state.lang === "ru" ? b.name : (b.name_en || b.name);
}

const RU_LAT = { а:"a", б:"b", в:"v", г:"g", д:"d", е:"e", ё:"e", ж:"zh", з:"z",
  и:"i", й:"y", к:"k", л:"l", м:"m", н:"n", о:"o", п:"p", р:"r", с:"s", т:"t",
  у:"u", ф:"f", х:"kh", ц:"ts", ч:"ch", ш:"sh", щ:"shch", ъ:"", ы:"y", ь:"",
  э:"e", ю:"yu", я:"ya" };
function translitRu(s) {
  return s.split("").map((ch) => RU_LAT[ch] ?? ch).join("");
}

/* ── данные ─────────────────────────────────────────────── */

function sanctioned(b, jur) { return b.sanctions[jur].length > 0; }
function anySanc(b) { return JURS.some((j) => sanctioned(b, j)); }
function allSanc(b) { return JURS.every((j) => sanctioned(b, j)); }

function recentRegns() {
  return new Set((state.data.summary.recent_30d || []).map((r) => r.regn));
}

function visibleBanks() {
  let list = state.data.banks;
  if (state.hideNko) list = list.filter((b) => !b.is_nko);
  if (state.filter) {
    if (state.filter === "any") list = list.filter(anySanc);
    else if (state.filter === "all4") list = list.filter(allSanc);
    else if (state.filter === "recent30") {
      const rs = recentRegns();
      list = list.filter((b) => rs.has(b.regn));
    } else if (state.filter === "foreign_any") list = list.filter((b) => b.foreign);
    else if (state.filter.startsWith("foreign_"))
      list = list.filter((b) => b.foreign?.region === state.filter.slice(8).toUpperCase());
    else list = list.filter((b) => sanctioned(b, state.filter));
  }
  const q = state.query.trim().toLowerCase();
  if (q) {
    const qLat = translitRu(q); // «газпром» находит name_en «Gazprombank»
    list = list.filter((b) => {
      const en = (b.name_en || "").toLowerCase();
      return b.name.toLowerCase().includes(q) || en.includes(q) ||
        (qLat !== q && en.includes(qLat)) ||
        (b.inn || "").includes(q) || (b.ogrn || "").includes(q) ||
        (b.bic || "").includes(q) || (b.swift || "").toLowerCase().includes(q) ||
        String(b.regn).includes(q);
    });
  }
  return sortBanks(list);
}

function sancScore(b, jur) {
  const ss = b.sanctions[jur];
  return ss.length * 100 + ss.reduce((n, s) => n + s.types.length, 0);
}

function sortBanks(list) {
  const { key, dir } = state.sort;
  const val = (b) => {
    switch (key) {
      case "bank": return bankName(b).toLowerCase();
      case "regn": return b.regn;
      case "assets": return b.assets ?? -1;
      case "trend": return trendPct(b) ?? -Infinity;
      case "capital": return b.capital ?? -1;
      case "date": return b.assets_date || "";
      default: return JURS.includes(key) ? sancScore(b, key) : 0;
    }
  };
  return [...list].sort((a, b) => {
    const va = val(a), vb = val(b);
    if (va < vb) return -dir;
    if (va > vb) return dir;
    return (b.assets ?? -1) - (a.assets ?? -1);
  });
}

/* ── рендер: шапка/статус/карточки ──────────────────────── */

function applyChrome() {
  document.documentElement.lang = state.lang;
  document.title = t("title");
  $("app-title").textContent = t("title");
  $("tg-btn-text").textContent = t("subscribe");
  const invite = state.data.meta.telegram_invite;
  $("tg-btn").hidden = !invite;
  if (invite) $("tg-btn").href = invite;
  $("search").placeholder = t("controls.search_placeholder");
  $("hide-nko-label").textContent = t("controls.hide_nko");
  $("disclaimer").textContent = t("footer.disclaimer");
  $("sources-link").textContent = t("footer.sources");
  $("more-summary").textContent = t("cards.more");
  for (const btn of $("currency-seg").children)
    btn.classList.toggle("active", btn.dataset.cur === state.currency);
  for (const btn of $("lang-seg").children)
    btn.classList.toggle("active", btn.dataset.lang === state.lang);
}

function renderStatus() {
  const m = state.data.meta;
  const parts = [];
  parts.push(esc(t("status.cbr_data", { date: fmtDate(m.report_date) })));
  const gen = m.generated_at ? new Date(m.generated_at) : null;
  if (gen) parts.push(esc(t("status.lists_checked", {
    date: gen.toLocaleString(LOCALES[state.lang], { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }),
  })));
  parts.push(esc(t("status.assets_estimate")));
  const until = m.watch_until ? new Date(m.watch_until) : null;
  if (until && until > new Date()) {
    parts.push(`<span class="monitor-on">${esc(t("status.monitor_on", {
      until: until.toLocaleString(LOCALES[state.lang], { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) }))}</span>`);
  } else {
    parts.push(esc(t("status.monitor_off")));
  }
  $("statusline").innerHTML = parts.join('<span class="dot-sep"></span>');
}

function cardDef() {
  const s = state.data.summary;
  const jurCard = (j) => ({
    id: j, label: t("cards." + j.toLowerCase()),
    value: s.per_jurisdiction[j].count,
    sub: t("cards.assets_share", { pct: fmtPct(s.per_jurisdiction[j].assets_share) }),
  });
  return [
    { id: null, label: t("cards.total"), value: s.total, sub: t("cards.total_sub", { n: s.banks }) },
    jurCard("US"), jurCard("EU"), jurCard("UK"), jurCard("JP"),
    { id: "any", label: t("cards.any"), value: fmtPct(s.any_sanctions.assets_share), sub: t("cards.any_sub") },
    { id: "all4", label: t("cards.all4"), value: s.all_four.count,
      sub: t("cards.assets_share", { pct: fmtPct(s.all_four.assets_share) }) },
  ];
}

function renderCards() {
  $("cards").innerHTML = cardDef().map((c) => `
    <button class="card ${state.filter === c.id && c.id !== null ? "active" : ""}" data-filter="${c.id ?? ""}">
      <span class="card-label">${esc(c.label)}</span>
      <span class="card-value">${esc(String(c.value))}</span>
      <span class="card-sub">${esc(c.sub)}</span>
    </button>`).join("");
  const n = (state.data.summary.recent_30d || []).length;
  const fCount = (pred) => state.data.banks.filter(pred).length;
  const chips = [
    ["recent30", `${t("cards.recent30")} · ${n}`],
    ["foreign_any", `${t("cards.foreign_any")} · ${fCount((b) => b.foreign)}`],
    ["foreign_jp", `${t("cards.foreign_jp")} · ${fCount((b) => b.foreign?.region === "JP")}`],
    ["foreign_cn", `${t("cards.foreign_cn")} · ${fCount((b) => b.foreign?.region === "CN")}`],
    ["foreign_eu", `${t("cards.foreign_eu")} · ${fCount((b) => b.foreign?.region === "EU")}`],
  ];
  $("more-chips").innerHTML = chips.map(([id, label]) => `
    <button class="chip ${state.filter === id ? "active" : ""}" data-filter="${id}">${esc(label)}</button>`).join("");
}

/* ── рендер: таблица ────────────────────────────────────── */

const CUR_SYMBOL = { RUB: "₽", USD: "$", JPY: "¥" };
const unitSuffix = () => `, ${t("units.bln")} ${CUR_SYMBOL[state.currency]}`;

const COLUMNS = [
  { key: null, cls: "col-idx", label: () => t("table.num") },
  { key: "bank", cls: "col-bank", label: () => t("table.bank") },
  { key: "regn", cls: "col-regn", label: () => t("table.regn") },
  { key: "assets", cls: "num", label: () => t("table.assets") + unitSuffix() },
  { key: "trend", cls: "col-trend", label: () => t("table.trend") },
  { key: "capital", cls: "num", label: () => t("table.capital") + unitSuffix() },
  { key: "date", cls: "col-date", label: () => t("table.date") },
  ...JURS.map((j) => ({ key: j, cls: "col-jur", label: () => FLAGS[j] + " " + j })),
];

function renderHead() {
  $("thead-row").innerHTML = COLUMNS.map((c) => {
    const sorted = state.sort.key === c.key && c.key;
    const arrow = sorted ? `<span class="arrow">${state.sort.dir > 0 ? "▲" : "▼"}</span>` : "";
    return `<th class="${c.cls} ${sorted ? "sorted" : ""}" data-sort="${c.key ?? ""}">${c.label()}${arrow}</th>`;
  }).join("");
}

function badgeHtml(b, jur) {
  const ss = b.sanctions[jur];
  if (!ss.length) return `<span class="clean-cell">·</span>`;
  const seen = new Set();
  const parts = [];
  ss.forEach((s, si) => {
    for (const tp of s.types) {
      if (seen.has(tp)) continue;
      seen.add(tp);
      parts.push(`<span class="badge ${BADGE_COLOR[tp] || "b-amber"}" data-regn="${b.regn}" data-jur="${jur}" data-si="${si}" data-type="${tp}">${esc(t("types." + tp + ".badge"))}</span>`);
    }
  });
  return `<div class="badges">${parts.join("")}</div>`;
}

function trendPct(b) {
  const s = b.assets_series;
  if (!s || s.length < 2 || !s[0][1]) return null;
  return s[s.length - 1][1] / s[0][1] - 1;
}

function sparklineHtml(b) {
  const s = b.assets_series;
  if (!s || s.length < 2) return `<span class="clean-cell">·</span>`;
  const vals = s.map((p) => p[1]);
  const min = Math.min(...vals), max = Math.max(...vals);
  const W = 64, H = 18, PAD = 2;
  const pts = vals.map((v, i) => {
    const x = PAD + (i * (W - 2 * PAD)) / (vals.length - 1);
    const y = max === min ? H / 2 : PAD + (H - 2 * PAD) * (1 - (v - min) / (max - min));
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const pct = trendPct(b);
  const cls = pct == null ? "" : pct >= 0 ? "spark-up" : "spark-down";
  const pctTxt = pct == null ? "" :
    new Intl.NumberFormat(LOCALES[state.lang], { style: "percent", minimumFractionDigits: 1,
      maximumFractionDigits: 1, signDisplay: "always" }).format(pct);
  const period = `${s[0][0].slice(5)}.${s[0][0].slice(2, 4)}–${s[s.length-1][0].slice(5)}.${s[s.length-1][0].slice(2, 4)}`;
  return `<svg class="spark ${cls}" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <title>${period}: ${pctTxt}</title><polyline points="${pts}"/></svg>`;
}

function rowHtml(b, i) {
  const stale = b.assets_date && state.data.meta.report_date && b.assets_date < state.data.meta.report_date;
  return `<tr class="bank-row ${state.openRegn === b.regn ? "open" : ""}" data-regn="${b.regn}">
    <td class="col-idx">${i + 1}</td>
    <td class="col-bank">${anySanc(b) ? "" : '<span class="clean-mark"></span>'}${esc(bankName(b))}${b.is_nko ? `<span class="nko-suffix">${esc(t("table.nko_tag"))}</span>` : ""}</td>
    <td class="col-regn">${b.regn}</td>
    <td class="num">${fmtBln(b.assets)}</td>
    <td class="col-trend">${sparklineHtml(b)}</td>
    <td class="num">${fmtBln(b.capital)}</td>
    <td class="col-date">${b.assets_date ? fmtMMYY(b.assets_date) : t("table.no_data")}${stale ? '<span class="stale-dot"></span>' : ""}</td>
    ${JURS.map((j) => `<td class="col-jur">${badgeHtml(b, j)}</td>`).join("")}
  </tr>`;
}

function detailHtml(b) {
  const req = [
    ["full_name", `${esc(b.name)}${b.name_en ? " · " + esc(b.name_en) : ""}`],
    ["regn", b.regn], ["inn", b.inn], ["ogrn", b.ogrn],
    ["bic", b.bic], ["swift", b.swift], ["lic_type", b.lic_type],
    ["foreign_group", b.foreign ? `${esc(b.foreign.group)} (${esc(b.foreign.country)})` : null],
    ["address", esc(b.address)],
  ].filter(([, v]) => v != null && v !== "")
   .map(([k, v]) => `<div><span class="lbl">${esc(t("detail." + k))}</span> ${v}</div>`).join("");

  const finParts = [];
  if (b.assets != null) finParts.push(esc(t("detail.assets_note", { date: fmtDate(b.assets_date) })));
  if (b.capital != null) finParts.push(esc(t("detail.capital_note", { date: fmtDate(b.capital_date) })));
  if (b.ogrn) finParts.push(`<a href="https://www.cbr.ru/finorg/foinfo/?ogrn=${b.ogrn}" target="_blank" rel="noopener">${esc(t("detail.fin_source"))}</a>`);

  let sanc;
  if (!anySanc(b)) {
    sanc = `<div class="no-sanctions">${esc(t("detail.no_sanctions"))}</div>`;
  } else {
    sanc = JURS.map((j) => {
      const ss = b.sanctions[j];
      const entries = ss.length ? ss.map((s) => {
        const badges = s.types.map((tp) =>
          `<span class="badge ${BADGE_COLOR[tp] || "b-amber"}">${esc(t("types." + tp + ".badge"))}</span>`).join(" ");
        const dates = Object.entries(s.dates || {}).filter(([, d]) => d)
          .map(([tp, d]) => `${esc(t("types." + tp + ".badge"))}: ${fmtDate(d)}`).join(", ");
        return `<div class="jur-entry">${badges} ${esc(s.entry_name || s.entry_id)}
          <span class="meta"> · ${esc(t("detail.method"))}: ${esc(t("methods." + s.method))}${dates ? ` · ${esc(t("detail.designated"))}: ${dates}` : ""}
          · <a href="${esc(s.source_url)}" target="_blank" rel="noopener">${esc(t("detail.entry_link"))}</a>${s.superseded_by ? ` · ${esc(t("detail.superseded"))}` : ""}</span></div>`;
      }).join("") : `<span class="meta" style="color:var(--text-secondary)">${esc(t("detail.clean_jur"))}</span>`;
      return `<div class="jur-block"><span class="jur-name">${FLAGS[j]} ${j}</span>${entries}</div>`;
    }).join("");
  }

  return `<tr class="detail-row"><td colspan="${COLUMNS.length}">
    <div class="detail-grid">
      <div>
        <div class="detail-h">${esc(t("detail.full_name"))}</div>
        <div class="detail-req">${req}</div>
        <div class="detail-fin">${finParts.join("<br>")}</div>
      </div>
      <div>
        <div class="detail-h">${esc(t("detail.sanctions_block"))}</div>
        ${sanc}
      </div>
    </div>
  </td></tr>`;
}

function renderTable() {
  const list = visibleBanks();
  const rows = [];
  list.forEach((b, i) => {
    rows.push(rowHtml(b, i));
    if (state.openRegn === b.regn) rows.push(detailHtml(b));
  });
  $("tbody").innerHTML = rows.join("");
  $("counter").textContent = t("controls.shown",
    { shown: list.length, total: state.data.banks.length });
}

function render() {
  applyChrome();
  renderStatus();
  renderCards();
  renderHead();
  renderTable();
}

/* ── тултип бейджей ─────────────────────────────────────── */

let ttTimer = null;
function showTooltip(el) {
  const b = state.data.banks.find((x) => x.regn === +el.dataset.regn);
  if (!b) return;
  const s = b.sanctions[el.dataset.jur][+el.dataset.si];
  const tp = el.dataset.type;
  const date = (s.dates || {})[tp];
  const tt = $("tooltip");
  tt.innerHTML = `<div><b>${esc(t("types." + tp + ".badge"))}</b> — ${esc(t("types." + tp + ".desc"))}</div>
    ${date ? `<div class="tt-date">${esc(t("detail.designated"))}: ${fmtDate(date)}</div>` : ""}
    <div><a href="${esc(s.source_url)}" target="_blank" rel="noopener">${esc(t("detail.entry_link"))}</a></div>`;
  tt.hidden = false;
  const r = el.getBoundingClientRect();
  const ttr = tt.getBoundingClientRect();
  let x = Math.min(r.left, window.innerWidth - ttr.width - 12);
  let y = r.bottom + 6;
  if (y + ttr.height > window.innerHeight - 8) y = r.top - ttr.height - 6;
  tt.style.left = x + "px";
  tt.style.top = y + "px";
}
function hideTooltipSoon() {
  ttTimer = setTimeout(() => { $("tooltip").hidden = true; }, 250);
}

/* ── события ────────────────────────────────────────────── */

function bind() {
  $("currency-seg").addEventListener("click", (e) => {
    const cur = e.target.closest("button")?.dataset.cur;
    if (!cur) return;
    state.currency = cur;
    localStorage.setItem("sb_cur", cur);
    render();
  });
  $("lang-seg").addEventListener("click", async (e) => {
    const lang = e.target.closest("button")?.dataset.lang;
    if (!lang) return;
    state.lang = lang;
    localStorage.setItem("sb_lang", lang);
    await loadDict();
    render();
  });
  $("search").addEventListener("input", (e) => {
    state.query = e.target.value;
    renderTable();
  });
  $("hide-nko").addEventListener("change", (e) => {
    state.hideNko = e.target.checked;
    renderTable();
  });
  $("cards").addEventListener("click", (e) => {
    const card = e.target.closest("[data-filter]");
    if (!card) return;
    const f = card.dataset.filter || null;
    state.filter = state.filter === f ? null : f;
    renderCards();
    renderTable();
  });
  $("more-chips").addEventListener("click", (e) => {
    const chip = e.target.closest("[data-filter]");
    if (!chip) return;
    state.filter = state.filter === chip.dataset.filter ? null : chip.dataset.filter;
    renderCards();
    renderTable();
  });
  $("thead-row").addEventListener("click", (e) => {
    const key = e.target.closest("th")?.dataset.sort;
    if (!key) return;
    if (state.sort.key === key) state.sort.dir *= -1;
    else state.sort = { key, dir: key === "bank" || key === "regn" ? 1 : -1 };
    renderHead();
    renderTable();
  });
  $("tbody").addEventListener("click", (e) => {
    if (e.target.closest("a") || e.target.closest(".badge")) return;
    const row = e.target.closest("tr.bank-row");
    if (!row) return;
    const regn = +row.dataset.regn;
    state.openRegn = state.openRegn === regn ? null : regn;
    renderTable();
  });
  document.addEventListener("mouseover", (e) => {
    if (e.target.classList?.contains("badge") && e.target.dataset.regn) {
      clearTimeout(ttTimer);
      showTooltip(e.target);
    } else if (e.target.closest?.("#tooltip")) {
      clearTimeout(ttTimer);
    } else if (!$("tooltip").hidden) {
      hideTooltipSoon();
    }
  });
}

/* ── старт ──────────────────────────────────────────────── */

async function loadDict() {
  const res = await fetch(`./static/i18n/${state.lang}.json`);
  state.dict = await res.json();
}

async function init() {
  // секретный ключ не должен светиться в адресной строке/истории
  if (new URLSearchParams(location.search).has("key")) {
    history.replaceState(null, "", location.pathname);
  }
  try {
    const [dataRes] = await Promise.all([fetch("./dataset.json"), loadDict()]);
    state.data = await dataRes.json();
    if (!state.data.banks) throw new Error("no data");
    bind();
    render();
  } catch (err) {
    $("statusline").textContent = "Ошибка загрузки данных: " + err.message;
  }
}

init();
