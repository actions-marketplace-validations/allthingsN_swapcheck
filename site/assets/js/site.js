// Shared by every page: theme toggle, copy buttons, live day counts.
const root = document.documentElement;

function effectiveTheme() {
  const set = root.getAttribute("data-theme");
  if (set) return set;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function initTheme() {
  const button = document.getElementById("theme-toggle");
  if (!button) return;
  const sync = () => {
    const next = effectiveTheme() === "dark" ? "light" : "dark";
    button.setAttribute("aria-label", `Switch to ${next} theme`);
  };
  sync();
  button.addEventListener("click", () => {
    const next = effectiveTheme() === "dark" ? "light" : "dark";
    root.setAttribute("data-theme", next);
    try {
      localStorage.setItem("swapcheck-theme", next);
    } catch {
      /* The choice lasts for this page only. */
    }
    sync();
  });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", sync);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function initCopy() {
  document.querySelectorAll("[data-copy]").forEach((button) => {
    button.hidden = false;
    const idle = button.textContent;
    let timer = 0;
    button.addEventListener("click", async () => {
      const target = button.dataset.copy ? null : button.closest("[data-copy-root]")?.querySelector("code");
      const ok = await copyText(button.dataset.copy || target?.textContent || "");
      button.textContent = ok ? "Copied" : "Press Ctrl+C";
      clearTimeout(timer);
      timer = setTimeout(() => {
        button.textContent = idle;
      }, 1600);
    });
  });
}

const DAY = 86400000;

function todayUtc() {
  const now = new Date();
  return Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
}

export const daysUntil = (iso) => Math.round((Date.parse(`${iso}T00:00:00Z`) - todayUtc()) / DAY);

function initDayCounts() {
  document.querySelectorAll("[data-days-to]").forEach((el) => {
    const days = daysUntil(el.dataset.daysTo);
    el.textContent = days < 0 ? `${-days} days ago` : days === 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`;
  });
}

initTheme();
initCopy();
initDayCounts();
