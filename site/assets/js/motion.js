// One clock for every diagram. A diagram advances only while it is on screen.
// The markup is the finished state, so anything that stops this code still reads correctly.
import { withInstantFlips } from "./flap.js";

const running = new Set();
const diagrams = new Set();
let frameId = 0;
let lastFrame = 0;

function frame(now) {
  const elapsed = Math.min(now - lastFrame, 100);
  lastFrame = now;
  for (const diagram of [...running]) diagram.tick(elapsed);
  frameId = running.size ? requestAnimationFrame(frame) : 0;
}

function wake() {
  if (frameId) return;
  lastFrame = performance.now();
  frameId = requestAnimationFrame(frame);
}

export const motionAllowed = () => document.documentElement.classList.contains("anim");

/**
 * root: figure element. arm(): put the figure in its start state, without transitions.
 * steps: [ms, fn] pairs, or a function returning them. hold: ms before looping (omit to play once).
 */
export function createDiagram(root, { arm, steps, hold }) {
  let time = 0;
  let cursor = 0;
  let plan = [];
  let state = "idle"; // idle | armed | playing | paused | done

  const resolvePlan = () => (typeof steps === "function" ? steps() : steps).slice().sort((a, b) => a[0] - b[0]);
  const cancelMotion = () => root.getAnimations({ subtree: true }).forEach((a) => a.cancel());

  function prepare() {
    root.classList.add("no-tx", "live", "armed");
    arm();
    void root.offsetWidth; // Commit the start state so the first change can transition.
    root.classList.remove("no-tx");
    if (state === "idle") state = "armed";
  }

  const diagram = {
    get state() {
      return state;
    },
    tick(delta) {
      time += delta;
      while (cursor < plan.length && plan[cursor][0] <= time) {
        plan[cursor][1]();
        cursor += 1;
      }
      if (cursor < plan.length) return;
      if (hold === undefined) {
        running.delete(diagram);
        state = "done";
        root.classList.remove("armed");
        root.classList.add("played");
      } else if (time >= plan[plan.length - 1][0] + hold) {
        diagram.play();
      }
    },
    arm() {
      if (state === "idle") prepare();
    },
    play() {
      cancelMotion();
      prepare();
      plan = resolvePlan();
      time = 0;
      cursor = 0;
      state = "playing";
      running.add(diagram);
      wake();
    },
    pause() {
      if (state !== "playing") return;
      state = "paused";
      running.delete(diagram);
      root.getAnimations({ subtree: true }).forEach((a) => a.pause());
    },
    resume() {
      if (state !== "paused") return;
      state = "playing";
      root.getAnimations({ subtree: true }).forEach((a) => a.play());
      running.add(diagram);
      wake();
    },
    /** Jumps to the finished state, so nothing offscreen is ever left half-drawn. */
    settle() {
      root.classList.add("live");
      if (state === "idle" || state === "done") return;
      const hadStarted = state !== "armed";
      running.delete(diagram);
      root.classList.add("no-tx");
      cancelMotion();
      if (!hadStarted) {
        plan = resolvePlan();
        cursor = 0;
      }
      withInstantFlips(() => {
        for (; cursor < plan.length; cursor += 1) plan[cursor][1]();
      });
      root.classList.remove("armed");
      void root.offsetWidth;
      root.classList.remove("no-tx");
      state = hadStarted && hold === undefined ? "done" : "idle";
    },
  };
  diagrams.add(diagram);
  return diagram;
}

/** Arms a diagram just before it scrolls in, plays it when visible, pauses it when not. */
export function observeDiagram(root, diagram) {
  if (!motionAllowed()) return;
  if (!("IntersectionObserver" in window)) {
    document.documentElement.classList.remove("anim");
    return;
  }
  const armer = new IntersectionObserver(
    (entries) => {
      if (entries[entries.length - 1].isIntersecting) diagram.arm();
      else diagram.settle();
    },
    { rootMargin: "45% 0px 45% 0px" },
  );
  armer.observe(root);
  const visibility = new IntersectionObserver(
    (entries) => {
      const visible = entries[entries.length - 1].isIntersecting;
      if (!visible) {
        diagram.pause();
      } else if (diagram.state === "paused") {
        diagram.resume();
      } else if (diagram.state === "idle" || diagram.state === "armed") {
        diagram.play();
      }
    },
    { threshold: 0.3 },
  );
  visibility.observe(root);
  const replay = root.querySelector("[data-replay]");
  if (replay) {
    replay.hidden = false;
    replay.addEventListener("click", () => diagram.play());
  }
}

function settleEverything() {
  diagrams.forEach((diagram) => diagram.settle());
}

window.addEventListener("beforeprint", settleEverything);
matchMedia("(prefers-reduced-motion: reduce)").addEventListener("change", (event) => {
  if (!event.matches) return;
  settleEverything();
  document.documentElement.classList.remove("anim");
});

/** Selector helper bound to a root element. */
export const within = (root) => ({
  one: (selector) => root.querySelector(selector),
  all: (selector) => [...root.querySelectorAll(selector)],
});
