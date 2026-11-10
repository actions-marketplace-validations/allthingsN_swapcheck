// The five diagrams on the home page.
import { createDiagram, observeDiagram, motionAllowed, within } from "./motion.js";
import { flipTo, setFlap } from "./flap.js";
import { SCENARIOS, STAT_RUNS } from "./stats-data.js";

const on = (el) => el.classList.add("on");
const off = (el) => el.classList.remove("on");

/* 1. Hero: green CI on both sides of a silent swap. */
function initHero() {
  const fig = document.getElementById("hero-fig");
  if (!fig) return;
  const $ = within(fig);
  const checks = $.all(".check");
  const ticket = $.one(".ticket");
  const flaps = {
    date: $.one("#hero-date"),
    served: $.one("#hero-served"),
    status: $.one("#hero-status"),
    run: $.one("#hero-run"),
  };
  const late = $.all(".hero-late");
  const counter = $.one(".ci__count");
  const move = (i) => ticket.style.setProperty("--i", i);

  function arm() {
    checks.forEach(off);
    late.forEach(off);
    off(ticket);
    off(counter);
    move(-1);
    Object.values(flaps).forEach((flap) => setFlap(flap, flap.dataset.from));
  }

  function run(start, spacing) {
    const steps = [[start, () => { on(ticket); move(0); }]];
    checks.forEach((check, i) => {
      if (i > 0) steps.push([start + spacing * i, () => move(i)]);
      steps.push([start + spacing * i + spacing * 0.62, () => on(check)]);
    });
    const end = start + spacing * checks.length + 60;
    steps.push([end, () => { off(ticket); on(counter); }]);
    return steps;
  }

  const steps = [
    ...run(500, 520),
    [3750, () => flipTo(flaps.date, flaps.date.dataset.to, { spins: 2 })],
    [4300, () => flipTo(flaps.served, flaps.served.dataset.to, { spins: 4, stagger: 42 })],
    [4800, () => flipTo(flaps.status, flaps.status.dataset.to, { spins: 3 })],
    [5450, () => on(late[0])],
    [5900, () => { checks.forEach(off); off(counter); flipTo(flaps.run, flaps.run.dataset.to, { spins: 1 }); }],
    ...run(6250, 420),
    [8900, () => late.forEach(on)],
  ];

  const diagram = createDiagram(fig, { arm, steps });
  observeDiagram(fig, diagram);
}

/* 2. The line: registry events to a pull request. */
function initLine() {
  const fig = document.getElementById("line-fig");
  if (!fig) return;
  const $ = within(fig);
  const stops = $.all(".stop");
  const train = $.one(".train");
  const pr = $.one(".pr");
  const tickets = $.all(".ev");
  const rail = $.one(".line__rail");
  const line = $.one(".line");

  // The stops are unevenly spaced and the line turns vertical on phones, so positions are measured.
  function fitRail() {
    rail.style.removeProperty("bottom");
    if (getComputedStyle(rail).width !== "6px") return;
    const lastDot = stops[stops.length - 1].querySelector(".stop__dot").getBoundingClientRect();
    rail.style.bottom = `${line.getBoundingClientRect().bottom - (lastDot.top + lastDot.height / 2)}px`;
  }

  function move(i) {
    const box = rail.getBoundingClientRect();
    const dot = stops[i].querySelector(".stop__dot").getBoundingClientRect();
    const vertical = box.height > box.width;
    const x = vertical ? 0 : dot.left + dot.width / 2 - box.left;
    const y = vertical ? dot.top + dot.height / 2 - box.top : 0;
    train.style.setProperty("--x", `${x.toFixed(1)}px`);
    train.style.setProperty("--y", `${y.toFixed(1)}px`);
    rail.style.setProperty("--p", (vertical ? y / box.height : x / box.width).toFixed(4));
  }

  function arm() {
    stops.forEach(off);
    tickets.forEach(off);
    off(pr);
    off(train);
    fitRail();
    move(0);
  }

  const gap = 1500;
  const steps = [
    ...tickets.map((ticket, i) => [250 + i * 260, () => on(ticket)]),
    [1050, () => { on(train); on(stops[0]); }],
  ];
  stops.forEach((stop, i) => {
    if (i === 0) return;
    steps.push([1050 + gap * i, () => move(i)]);
    steps.push([1050 + gap * i + 760, () => on(stop)]);
  });
  const last = 1050 + gap * (stops.length - 1);
  steps.push([last + 900, () => { on(pr); off(train); }]);

  observeDiagram(fig, createDiagram(fig, { arm, steps, hold: 3600 }));
  window.addEventListener("resize", () => {
    if (fig.classList.contains("armed")) fitRail();
  }, { passive: true });
}

/* 3. The funnel: many models, five candidates, one tested result. */
function initFunnel() {
  const fig = document.getElementById("funnel-fig");
  if (!fig) return;
  const $ = within(fig);
  const rows = $.all(".fun__row").map((row) => $.all(`.tk[data-r="${row.dataset.row}"]`));
  const fins = $.all(".fin");
  const winner = $.one(".fin--win");

  rows.forEach((ticks) => {
    ticks.forEach((tick, i) => tick.style.setProperty("--d", `${Math.min(i * 9, 520)}ms`));
  });

  function arm() {
    rows.flat().forEach((tick) => {
      off(tick);
      tick.classList.remove("out");
    });
    fins.forEach(off);
    winner.classList.remove("won");
  }

  const steps = [];
  rows.forEach((ticks, r) => {
    const at = 300 + r * 1120;
    steps.push([at, () => ticks.forEach(on)]);
    if (r > 0) {
      const keep = ticks.length;
      steps.push([at - 300, () => rows[r - 1].slice(keep).forEach((t) => t.classList.add("out"))]);
    }
  });
  const fan = 300 + rows.length * 1120 + 100;
  fins.forEach((fin, i) => steps.push([fan + i * 180, () => on(fin)]));
  steps.push([fan + fins.length * 180 + 700, () => winner.classList.add("won")]);

  observeDiagram(fig, createDiagram(fig, { arm, steps }));
}

/* 4. The statistics: dots build up, then resolve into a verdict. */
function initStats() {
  const fig = document.getElementById("stats-fig");
  if (!fig) return;
  const $ = within(fig);
  const rows = $.all(".st__row");
  const verdictFlap = $.one("#stat-verdict");
  const verdictBox = $.one(".st__verdict");
  const note = $.one(".st__note");
  const buttons = $.all("[data-scenario]");
  let scenario = SCENARIOS.regressed;

  function paintRow(row, data) {
    row.classList.toggle("is-flag", Boolean(data.flag));
    row.querySelector(".st__case").textContent = data.id;
    row.querySelector(".st__q").textContent = data.q;
    ["base", "cand", "fresh"].forEach((col) => {
      const bits = col === "fresh" ? data.fresh : data[col];
      row.querySelectorAll(`[data-col="${col}"] .dot`).forEach((dot, i) => {
        dot.classList.toggle("dot--none", !bits);
        if (bits) {
          dot.classList.toggle("is-pass", bits[i] === "1");
          dot.classList.toggle("is-fail", bits[i] !== "1");
        } else {
          dot.classList.remove("is-pass", "is-fail");
        }
      });
    });
  }

  function paint() {
    rows.forEach((row, i) => paintRow(row, scenario.cases[i]));
    note.textContent = scenario.note;
    verdictBox.dataset.tone = scenario.tone;
    setFlap(verdictFlap, scenario.verdict);
  }

  function arm() {
    fig.querySelectorAll(".st__row .dot, .st__q, .st__row, .st__note").forEach(off);
    setFlap(verdictFlap, "");
  }

  function steps() {
    const list = [];
    rows.forEach((row, r) => {
      const at = 250 + r * 230;
      row.querySelectorAll('[data-col="base"] .dot').forEach((dot, n) => list.push([at + n * 52, () => on(dot)]));
      row.querySelectorAll('[data-col="cand"] .dot').forEach((dot, n) => list.push([at + 280 + n * 52, () => on(dot)]));
    });
    let t = 250 + rows.length * 230 + 520;
    rows.forEach((row, r) => list.push([t + r * 45, () => on(row.querySelector(".st__q"))]));
    t += 620;
    const flagged = rows.find((row) => row.classList.contains("is-flag"));
    if (flagged) {
      list.push([t, () => on(flagged)]);
      t += 700;
      flagged.querySelectorAll('[data-col="fresh"] .dot').forEach((dot, n) => list.push([t + n * 200, () => on(dot)]));
      t += STAT_RUNS * 200 + 520;
    }
    list.push([t, () => flipTo(verdictFlap, scenario.verdict, { spins: 3, stagger: 30 })]);
    list.push([t + 1100, () => on(note)]);
    return list;
  }

  const diagram = createDiagram(fig, { arm, steps });
  observeDiagram(fig, diagram);

  buttons.forEach((button) => {
    button.hidden = false;
    button.addEventListener("click", () => {
      scenario = SCENARIOS[button.dataset.scenario];
      buttons.forEach((b) => b.setAttribute("aria-pressed", String(b === button)));
      paint();
      if (motionAllowed()) diagram.play();
    });
  });
  if (buttons.length) buttons[0].parentElement.hidden = false;
}

/* 5. The terminal replay. Every line is already in the page; playing only reveals it. */
function initTerminal() {
  const fig = document.getElementById("term-fig");
  if (!fig || !motionAllowed()) {
    const replayBtn = fig?.querySelector("[data-replay]");
    if (replayBtn) replayBtn.hidden = true;
    return;
  }
  const lines = [...fig.querySelectorAll(".term .l")];
  const typed = new Map();

  lines
    .filter((line) => line.classList.contains("cmd"))
    .forEach((line) => {
      const text = line.querySelector("code");
      const chars = [...text.textContent].map((c) => {
        const span = document.createElement("span");
        span.className = "ch";
        span.textContent = c;
        return span;
      });
      text.textContent = "";
      chars.forEach((span) => text.append(span));
      typed.set(line, chars);
    });

  function arm() {
    lines.forEach(off);
    typed.forEach((chars) => chars.forEach(off));
  }

  function steps() {
    const list = [];
    const rhythm = [38, 52, 44, 66, 40, 58];
    let t = 300;
    lines.forEach((line) => {
      const chars = typed.get(line);
      if (chars) {
        t += 520;
        const start = t;
        list.push([start - 180, () => on(line)]);
        chars.forEach((char, i) => {
          t += rhythm[i % rhythm.length];
          const at = t;
          list.push([at, () => on(char)]);
        });
        t += 460;
      } else {
        t += line.classList.contains("blank") ? 40 : 95;
        const at = t;
        list.push([at, () => on(line)]);
      }
    });
    return list;
  }

  observeDiagram(fig, createDiagram(fig, { arm, steps }));
}

initHero();
initLine();
initFunnel();
initStats();
initTerminal();
