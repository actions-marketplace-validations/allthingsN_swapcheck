#!/usr/bin/env node
// Static site build. Node standard library only.
//   node site/build.mjs            uses data/registry.snapshot.json
// When the snapshot is missing, a marked development fixture is used locally.
// In CI the build fails instead, so a fixture can never be deployed.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SCENARIOS, STAT_RUNS } from "./assets/js/stats-data.js";

const SITE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SITE, "..");
const OUT = join(SITE, "_out");
const SITE_URL = (process.env.SITE_URL || "https://allthingsn.github.io/swapcheck/").replace(/\/?$/, "/");
const REPO = "https://github.com/allthingsN/swapcheck";
const REGISTRY_REPO = "https://github.com/allthingsN/swapcheck-registry";
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'none'; manifest-src 'none'; base-uri 'none'; form-action 'none'";
const PAGES = ["index.html", "calendar.html", "docs.html", "security.html", "reports.html"];
const NAV = [
  ["calendar.html", "Calendar"],
  ["docs.html", "Docs"],
  ["security.html", "Security"],
  ["reports.html", "Reports"],
];
/** Past events stay listed this long, then drop off the page. */
const RECENT_DAYS = 90;

const TODAY = process.env.SITE_TODAY || new Date().toISOString().slice(0, 10);

const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** Registry text is untrusted: only plain https links ever become an href. */
function safeUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function hostOf(url) {
  return new URL(url).hostname.replace(/^www\./, "");
}

function daysBetween(fromIso, toIso) {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86400000);
}

function attrs(source) {
  const out = {};
  for (const m of source.matchAll(/([a-z-]+)="([^"]*)"/g)) out[m[1]] = m[2];
  return out;
}

/* ---------- split-flap markup ---------- */

function flap(to, { from, cls = "", id = "", label, pad = 0 } = {}) {
  const width = Math.max(to.length, from?.length ?? 0, Number(pad));
  const shown = to.padEnd(width, " ");
  const start = (from ?? to).padEnd(width, " ");
  const tiles = [...shown]
    .map((c, i) => {
      const a = c === " " ? " " : c;
      const b = start[i] === " " ? " " : start[i];
      return `<span class="t" data-c="${esc(a)}"${from !== undefined ? ` data-from="${esc(b)}"` : ""}></span>`;
    })
    .join("");
  const dataFrom = from !== undefined ? ` data-from="${esc(from)}"` : "";
  return `<span class="flap ${esc(cls)}"${id ? ` id="${esc(id)}"` : ""} data-flap data-to="${esc(to)}"${dataFrom}><span class="sr-only">${esc(label ?? to)}</span><span class="tiles" aria-hidden="true">${tiles}</span></span>`;
}

/* ---------- finder funnel ---------- */

const FUNNEL = [
  { label: "Registry", note: "every model it lists", keep: 64 },
  { label: "Capability", note: "tools, JSON, vision, context", keep: 38 },
  { label: "Policy", note: "providers, regions, licence, price", keep: 17 },
  { label: "Retirement", note: "not scheduled to go away itself", keep: 11 },
  { label: "Shortlist", note: "the top five, each with a reason", keep: 5 },
];
const FUNNEL_FINAL = [
  ["A", "CHANGED"],
  ["B", "REGRESSED"],
  ["C", "NO CHANGE DETECTED"],
  ["D", "REGRESSED"],
  ["E", "NOT ENOUGH EVIDENCE"],
];

function funnelMarkup() {
  const rows = FUNNEL.map((row, r) => {
    const survivors = FUNNEL[r + 1]?.keep ?? row.keep;
    const ticks = Array.from({ length: row.keep }, (_, i) => `<i class="tk${i >= survivors ? " out" : ""}" data-r="${r}" data-i="${i}"></i>`).join("");
    return `<li class="fun__row" data-row="${r}"><div class="fun__lbl"><b>${esc(row.label)}</b><span>${esc(row.note)}</span></div><div class="fun__ticks" data-keep="${row.keep}">${ticks}</div></li>`;
  }).join("");
  const finals = FUNNEL_FINAL.map(
    ([letter, verdict]) =>
      `<li class="fin${letter === "C" ? " fin--win" : ""}" data-letter="${letter}"><span class="fin__tile"><span class="t" data-c="${letter}"></span></span><span class="fin__v">${esc(verdict)}</span></li>`,
  ).join("");
  return `<ol class="fun">${rows}</ol><div class="fun__final"><div class="fun__lbl"><b>Tested</b><span>on your cases, repeated runs</span></div><ol class="fins">${finals}</ol></div>`;
}

/* ---------- statistics matrix ---------- */

function dotRow(bits, cls) {
  return [...bits]
    .map((b, i) => `<i class="dot ${cls}${b === "1" ? " is-pass" : " is-fail"}" data-n="${i}"></i>`)
    .join("");
}

function statsMarkup() {
  const s = SCENARIOS.regressed;
  const rows = s.cases
    .map((c, i) => {
      const freshBits = c.fresh ?? "";
      const fresh = c.fresh
        ? dotRow(freshBits, "dot--c")
        : Array.from({ length: STAT_RUNS }, (_, n) => `<i class="dot dot--none" data-n="${n}"></i>`).join("");
      return `<div class="st__row${c.flag ? " is-flag" : ""}" data-case="${i}"><span class="st__case">${esc(c.id)}</span><span class="st__dots" data-col="base">${dotRow(c.base, "dot--b")}</span><span class="st__dots" data-col="cand">${dotRow(c.cand, "dot--c")}</span><span class="st__dots st__dots--fresh" data-col="fresh">${fresh}</span><span class="st__q">${esc(c.q)}</span></div>`;
    })
    .join("");
  return `<div class="st__head" aria-hidden="true"><span>Case</span><span>Baseline</span><span>Candidate</span><span>Fresh re-run</span><span>q</span></div>${rows}`;
}

/* ---------- registry and calendar ---------- */

function loadRegistry() {
  const snapshotPath = process.env.SITE_SNAPSHOT || join(ROOT, "data", "registry.snapshot.json");
  if (existsSync(snapshotPath)) return { snapshot: JSON.parse(readFileSync(snapshotPath, "utf8")), fixture: false };
  if (process.env.CI) {
    throw new Error("data/registry.snapshot.json is missing. Refusing to publish the development fixture from CI.");
  }
  console.warn("WARNING: data/registry.snapshot.json not found. Using the development fixture, which is not real data.");
  return { snapshot: JSON.parse(readFileSync(join(SITE, "fixtures", "registry.fixture.json"), "utf8")), fixture: true };
}

const TYPE_INFO = {
  retirement: { label: "Retires", effect: "Requests fail." },
  reroute: { label: "Re-routes", effect: "Calls keep succeeding, on a different model." },
  alias_move: { label: "Alias moves", effect: "The same name points at a different model." },
  price_change: { label: "Reprices", effect: "Same calls, different bill." },
  parameter_change: { label: "Parameters", effect: "Requests using these parameters return errors." },
  capability_change: { label: "Capability", effect: "A feature your calls use may behave differently." },
  new_model: { label: "New model", effect: "A new option. Nothing changes unless you move." },
};

const PRECISION_WORD = { earliest_possible: "no earlier than", estimated: "around" };
const BILLING_WORD = { replacement_rates: "Billed at the replacement's rates.", unchanged: "Billing unchanged." };

function validEvent(event) {
  return Boolean(event && event.id && TYPE_INFO[event.type] && event.provider && event.model);
}

function padDays(days) {
  return String(Math.min(Math.abs(days), 999)).padStart(3, "0");
}

function eventRow(event) {
  const info = TYPE_INFO[event.type];
  const date = event.effective;
  const days = date ? daysBetween(TODAY, date) : null;
  const source = safeUrl(event.source);
  const report = safeUrl(event.report_url);
  const precision = date && event.date_precision ? PRECISION_WORD[event.date_precision] : undefined;
  const detail = [info.effect];
  if (event.params?.length) detail.push(`Affects ${event.params.join(", ")}.`);
  if (BILLING_WORD[event.billing]) detail.push(BILLING_WORD[event.billing]);
  const when = date
    ? `<time datetime="${esc(date)}">${esc(date)}</time>${precision ? `<span class="dep__prec">${esc(precision)}</span>` : ""}`
    : `<span class="dep__prec">date not announced</span>`;
  const daysCell = date
    ? `${flap(padDays(days), { cls: "flap--days", label: days === 0 ? "today" : `${Math.abs(days)} days ${days < 0 ? "ago" : "from now"}` })}<span class="dep__unit" data-unit>${days < 0 ? "days ago" : "days"}</span>`
    : `<span class="dep__tbd">TBA</span>`;
  const sourceLink = source
    ? `<a href="${esc(source)}" rel="noopener noreferrer">${esc(hostOf(source))}<span class="sr-only"> (source for ${esc(event.model)})</span></a>`
    : `<span>${esc(event.source || "not recorded")}</span>`;
  return `<tr class="dep__row dep__row--${esc(event.type)}" role="row" data-provider="${esc(event.provider)}" data-type="${esc(event.type)}"${date ? ` data-date="${esc(date)}"` : ""}>
<td class="dep__days" role="cell" data-label="In">${daysCell}</td>
<td class="dep__when" role="cell" data-label="Date">${when}</td>
<td class="dep__model" role="cell" data-label="Model"><code>${esc(event.model)}</code>${event.to ? `<span class="dep__to"><span aria-hidden="true">→</span><span class="sr-only">to</span> <code>${esc(event.to)}</code></span>` : ""}<span class="dep__route">${esc(event.provider)} · ${esc(event.route)}</span></td>
<td class="dep__what" role="cell" data-label="Change"><span class="tag tag--${esc(event.type)}">${esc(info.label)}</span><span class="dep__effect">${esc(detail.join(" "))}</span>${event.notes ? `<span class="dep__note">${esc(event.notes)}</span>` : ""}</td>
<td class="dep__src" role="cell" data-label="Source">${sourceLink}<span class="dep__conf">${esc(event.confidence)} confidence, checked ${esc(event.last_verified)}</span>${report ? `<a href="${esc(report)}" rel="noopener noreferrer">Report<span class="sr-only"> for ${esc(event.model)}</span></a>` : ""}</td>
</tr>`;
}

const TABLE_HEAD = `<thead role="rowgroup"><tr role="row"><th scope="col" role="columnheader">In</th><th scope="col" role="columnheader">Date</th><th scope="col" role="columnheader">Model</th><th scope="col" role="columnheader">Change</th><th scope="col" role="columnheader">Source</th></tr></thead>`;

function eventTable(rows, id, caption) {
  return `<div class="dep-board"><table class="dep" role="table"${id ? ` id="${id}"` : ""}><caption class="sr-only">${esc(caption)}</caption>${TABLE_HEAD}<tbody role="rowgroup">${rows.join("\n")}</tbody></table></div>`;
}

function calendarMarkup(snapshot, fixture) {
  const skipped = snapshot.events.filter((e) => !validEvent(e)).length;
  if (skipped) console.warn(`WARNING: skipped ${skipped} malformed registry events.`);
  const events = snapshot.events.filter(validEvent);
  const byDate = (a, b) => (a.effective < b.effective ? -1 : a.effective > b.effective ? 1 : a.model < b.model ? -1 : 1);
  const upcoming = events.filter((e) => e.effective && e.effective >= TODAY).sort(byDate);
  const undated = events.filter((e) => !e.effective).sort((a, b) => (a.model < b.model ? -1 : 1));
  const recent = events
    .filter((e) => e.effective && e.effective < TODAY && daysBetween(e.effective, TODAY) <= RECENT_DAYS)
    .sort((a, b) => byDate(b, a));

  const providers = [...new Set(upcoming.concat(undated, recent).map((e) => e.provider))].sort();
  const types = [...new Set(upcoming.concat(undated, recent).map((e) => e.type))];
  const chip = (group, value, label, on) =>
    `<button type="button" class="chip" data-filter="${group}" data-value="${esc(value)}" aria-pressed="${on}">${esc(label)}</button>`;
  const filters = `<form class="filters" id="filters" hidden aria-label="Filter the calendar">
<div class="filters__g" role="group" aria-label="Provider"><span class="lbl" aria-hidden="true">Provider</span>${chip("provider", "", "All", true)}${providers.map((p) => chip("provider", p, p, false)).join("")}</div>
<div class="filters__g" role="group" aria-label="Change type"><span class="lbl" aria-hidden="true">Change</span>${chip("type", "", "All", true)}${Object.keys(TYPE_INFO).filter((t) => types.includes(t)).map((t) => chip("type", t, TYPE_INFO[t].label, false)).join("")}</div>
<div class="filters__g" role="group" aria-label="Time window"><span class="lbl" aria-hidden="true">Within</span>${chip("within", "", "Any time", true)}${[30, 90, 180].map((d) => chip("within", String(d), `${d} days`, false)).join("")}</div>
<p class="filters__count" id="filter-count" role="status" aria-live="polite"></p>
</form>`;

  const next = upcoming.find((e) => e.type !== "new_model") ?? upcoming[0];
  const nextBoard = next
    ? `<section class="nextup" aria-label="Next change">
<div class="nextup__cell"><span class="lbl">Next change</span>${flap(next.model, { cls: "flap--next", id: "next-model" })}</div>
<div class="nextup__cell nextup__cell--s"><span class="lbl">Date</span>${flap(next.effective, { cls: "flap--next" })}</div>
<div class="nextup__cell nextup__cell--s"><span class="lbl">Status</span>${flap(TYPE_INFO[next.type].label.toUpperCase(), { cls: "flap--next flap--amber" })}</div>
</section>`
    : "";

  const parts = [];
  parts.push(
    upcoming.length
      ? eventTable(upcoming.map(eventRow), "dep-upcoming", "Upcoming model changes, soonest first")
      : `<p class="empty">No dated changes are scheduled in this snapshot.</p>`,
  );
  parts.push(`<p class="filters__none" id="filter-none" hidden>Nothing matches these filters.</p>`);
  if (undated.length) {
    parts.push(`<h2 class="cal-sub">Announced, no date yet</h2>`, eventTable(undated.map(eventRow), "dep-undated", "Announced changes without a date"));
  }
  if (recent.length) {
    parts.push(
      `<details class="cal-past"><summary>Already happened, last ${RECENT_DAYS} days (${recent.length})</summary>${eventTable(recent.map(eventRow), "dep-recent", "Changes that already took effect, most recent first")}</details>`,
    );
  }

  const snapshotDate = String(snapshot.generated_at ?? "").slice(0, 10);
  const banner = fixture
    ? `<p class="fixture-note" role="note"><strong>Development fixture.</strong> <code>data/registry.snapshot.json</code> was not found when this page was built, so these rows are sample data for local development. Do not rely on them.</p>`
    : "";
  return {
    banner,
    filters,
    nextBoard,
    board: parts.join("\n"),
    meta: `Built ${esc(TODAY)} from the registry snapshot dated <time datetime="${esc(snapshotDate)}">${esc(snapshotDate)}</time>. Days count from the day you open this page.`,
    count: upcoming.length,
  };
}

/** allthingsn.com or a subdomain of it; a host such as evilallthingsn.com does not count. */
function isAllthingsnHost(hostname) {
  return hostname === "allthingsn.com" || hostname.endsWith(".allthingsn.com");
}

function reportsMarkup() {
  const reports = JSON.parse(readFileSync(join(SITE, "data", "reports.json"), "utf8"));
  const published = reports
    .filter((r) => safeUrl(r.url) && isAllthingsnHost(new URL(r.url).hostname))
    .sort((a, b) => (a.date < b.date ? 1 : -1));
  if (published.length === 0) {
    return `<div class="reports-empty"><div class="reports-empty__flap">${flap("FIRST REPORTS", { cls: "flap--report" })}${flap("PUBLISH SOON", { cls: "flap--report" })}</div><p>None are published yet, so nothing is listed here. A report will appear only after it has been measured and written up on allthingsn.com.</p><p>Until then, the <a href="calendar.html">calendar</a> shows what is changing, and you can <a href="docs.html#quickstart">run the same test on your own cases</a>.</p></div>`;
  }
  return `<ol class="reports">${published
    .map(
      (r) =>
        `<li class="report"><time datetime="${esc(r.date)}">${esc(r.date)}</time><div><h2><a href="${esc(safeUrl(r.url))}">${esc(r.title)}</a></h2>${r.summary ? `<p>${esc(r.summary)}</p>` : ""}</div></li>`,
    )
    .join("")}</ol>`;
}

/* ---------- page assembly ---------- */

function headMarkup({ title, description, page }) {
  const url = SITE_URL + (page === "index.html" ? "" : page);
  const fullTitle = page === "index.html" ? title : `${title} · Swapcheck`;
  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<title>${esc(fullTitle)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(url)}">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" media="(prefers-color-scheme: light)" content="#ffcb05">
<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#0d1b2e">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Swapcheck">
<meta property="og:title" content="${esc(fullTitle)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(url)}">
<meta property="og:image" content="${esc(SITE_URL)}assets/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="A departure board reading: every check passed, the model changed anyway.">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="assets/favicon.svg" type="image/svg+xml">
<link rel="icon" href="assets/favicon-32.png" sizes="32x32" type="image/png">
<link rel="apple-touch-icon" href="assets/apple-touch-icon.png">
<link rel="preload" href="assets/fonts/anton.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="assets/fonts/plex-sans-400.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="assets/css/site.css">
<script src="assets/js/theme.js"></script>`;
}

function headerMarkup(page) {
  const links = NAV.map(
    ([href, label]) => `<li><a href="${href}"${href === page ? ' aria-current="page"' : ""}>${label}</a></li>`,
  ).join("");
  return readFileSync(join(SITE, "partials", "header.html"), "utf8").replace("<!-- nav -->", links).replaceAll("{{REPO}}", REPO);
}

function footerMarkup() {
  return readFileSync(join(SITE, "partials", "footer.html"), "utf8")
    .replaceAll("{{REPO}}", REPO)
    .replaceAll("{{REGISTRY_REPO}}", REGISTRY_REPO);
}

function renderPage(page, context) {
  let html = readFileSync(join(SITE, page), "utf8");
  html = html.replace(/<!-- @head ([^>]*?)-->/, (_, body) => headMarkup({ ...attrs(body), page }));
  html = html.replace("<!-- @header -->", headerMarkup(page));
  html = html.replace("<!-- @footer -->", footerMarkup());
  html = html.replace("<!-- @funnel -->", funnelMarkup());
  html = html.replace("<!-- @stats -->", statsMarkup());
  if (page === "calendar.html") {
    const { banner, filters, nextBoard, board, meta, count } = context.calendar;
    html = html
      .replace("<!-- @cal-banner -->", banner)
      .replace("<!-- @cal-next -->", nextBoard)
      .replace("<!-- @cal-filters -->", filters)
      .replace("<!-- @cal-board -->", board)
      .replace("<!-- @cal-meta -->", meta)
      .replace("<!-- @cal-count -->", String(count));
  }
  if (page === "reports.html") html = html.replace("<!-- @reports -->", reportsMarkup());
  html = html.replace(/<flap ([^>]*?)\/>/g, (_, body) => {
    const a = attrs(body);
    return flap(a.to, { from: a.from, cls: a.class, id: a.id, label: a.label, pad: a.pad });
  });
  html = html.replace(/<days-until date="([^"]+)"\s*\/>/g, (_, date) => {
    const days = daysBetween(TODAY, date);
    return `<span data-days-to="${esc(date)}">${days < 0 ? `${-days} days ago` : days === 0 ? "today" : `in ${days} days`}</span>`;
  });
  html = html.replaceAll("<pre>", '<pre tabindex="0">');
  const leftover = html.match(/<!-- @[a-z-]+[^>]*-->|<flap |<days-until /);
  if (leftover) throw new Error(`${page}: unexpanded template marker: ${leftover[0]}`);
  return html;
}

function main() {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const { snapshot, fixture } = loadRegistry();
  const context = { calendar: calendarMarkup(snapshot, fixture) };
  for (const page of PAGES) writeFileSync(join(OUT, page), renderPage(page, context));
  cpSync(join(SITE, "assets"), join(OUT, "assets"), { recursive: true });
  writeFileSync(join(OUT, ".nojekyll"), "");
  writeFileSync(join(OUT, "robots.txt"), `User-agent: *\nAllow: /\n\nSitemap: ${SITE_URL}sitemap.xml\n`);
  const urls = PAGES.map((p) => `  <url><loc>${esc(SITE_URL + (p === "index.html" ? "" : p))}</loc><lastmod>${TODAY}</lastmod></url>`);
  writeFileSync(
    join(OUT, "sitemap.xml"),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`,
  );
  console.log(`Built ${PAGES.length} pages to site/_out (${context.calendar.count} upcoming changes${fixture ? ", DEVELOPMENT FIXTURE" : ""}).`);
  for (const dir of readdirSync(OUT)) if (dir.startsWith("fixtures")) throw new Error("fixtures must not be published");
}

try {
  main();
} catch (error) {
  console.error(`Site build failed: ${error.message}`);
  process.exit(1);
}
