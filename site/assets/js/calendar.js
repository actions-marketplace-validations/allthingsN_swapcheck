// Progressive enhancement for the calendar: filters, live day counts, a split-flap arrival.
import { flipTo, setFlap } from "./flap.js";
import { daysUntil } from "./site.js";

const rows = [...document.querySelectorAll(".dep__row")];
const form = document.getElementById("filters");
const countEl = document.getElementById("filter-count");
const noneEl = document.getElementById("filter-none");
const state = { provider: "", type: "", within: "" };
const FILTERS = Object.keys(state);

function paddedDays(days) {
  return String(Math.min(Math.abs(days), 999)).padStart(3, "0");
}

function refreshDays() {
  rows.forEach((row) => {
    if (!row.dataset.date) return;
    const days = daysUntil(row.dataset.date);
    const flap = row.querySelector(".flap--days");
    if (flap) setFlap(flap, paddedDays(days));
    const sr = flap?.querySelector(".sr-only");
    if (sr) sr.textContent = days === 0 ? "today" : `${Math.abs(days)} days ${days < 0 ? "ago" : "from now"}`;
    const unit = row.querySelector("[data-unit]");
    if (unit) unit.textContent = days < 0 ? "days ago" : days === 1 ? "day" : "days";
  });
}

function matches(row) {
  if (state.provider && row.dataset.provider !== state.provider) return false;
  if (state.type && row.dataset.type !== state.type) return false;
  if (state.within) {
    if (!row.dataset.date) return false;
    const days = daysUntil(row.dataset.date);
    if (days < 0 || days > Number(state.within)) return false;
  }
  return true;
}

function applyFilters() {
  let shown = 0;
  rows.forEach((row) => {
    const visible = matches(row);
    row.hidden = !visible;
    if (visible) shown += 1;
  });
  document.querySelectorAll(".dep-board").forEach((board) => {
    board.hidden = ![...board.querySelectorAll(".dep__row")].some((row) => !row.hidden);
  });
  countEl.textContent = `Showing ${shown} of ${rows.length} changes`;
  noneEl.hidden = shown > 0;
}

function syncUrl() {
  const params = new URLSearchParams();
  FILTERS.forEach((key) => {
    if (state[key]) params.set(key, state[key]);
  });
  const query = params.toString();
  history.replaceState(null, "", query ? `?${query}` : location.pathname);
}

function syncChips() {
  form.querySelectorAll(".chip").forEach((chip) => {
    chip.setAttribute("aria-pressed", String(state[chip.dataset.filter] === chip.dataset.value));
  });
}

function initFilters() {
  if (!form) return;
  form.hidden = false;
  form.addEventListener("submit", (event) => event.preventDefault());
  form.addEventListener("click", (event) => {
    const chip = event.target.closest(".chip");
    if (!chip) return;
    state[chip.dataset.filter] = chip.dataset.value;
    syncChips();
    applyFilters();
    syncUrl();
  });
  const params = new URLSearchParams(location.search);
  FILTERS.forEach((key) => {
    const value = params.get(key) ?? "";
    if (form.querySelector(`.chip[data-filter="${key}"][data-value="${CSS.escape(value)}"]`)) state[key] = value;
  });
  syncChips();
  applyFilters();
}

/** The board arrives by flipping into place: first the headline row, then each visible day count. */
function arrive() {
  if (!document.documentElement.classList.contains("anim")) return;
  const next = [...document.querySelectorAll(".nextup .flap")];
  next.forEach((flap, i) => {
    const text = flap.dataset.to;
    setFlap(flap, "");
    setTimeout(() => flipTo(flap, text, { spins: 2, stagger: 22 }), 120 + i * 220);
  });
  const dayFlaps = rows
    .filter((row) => !row.hidden && row.dataset.date && !row.closest("details"))
    .slice(0, 14)
    .map((row) => row.querySelector(".flap--days"));
  dayFlaps.forEach((flap, i) => {
    const text = [...flap.querySelectorAll(".t")].map((tile) => tile.dataset.c).join("");
    setFlap(flap, "---");
    setTimeout(() => flipTo(flap, text, { spins: 2, stagger: 24 }), 420 + i * 70);
  });
}

refreshDays();
initFilters();
arrive();
