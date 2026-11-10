// Split-flap tiles. Each flip creates three short-lived leaves and animates only
// rotateX, so a resting board has no extra layers and a moving one stays on the compositor.
const NBSP = " ";
const CYCLE = "abcdefghijklmnopqrstuvwxyz0123456789-.";
const LEAF_MS = 62;

let instant = false;
const motionAllowed = () => !instant && document.documentElement.classList.contains("anim");

/** Runs fn with every flip landing at once. Used to jump a diagram to its finished state. */
export function withInstantFlips(fn) {
  instant = true;
  try {
    fn();
  } finally {
    instant = false;
  }
}

/** A newer write to a tile cancels any spin still in progress on it. */
const generation = new WeakMap();
const nextRun = (tile) => {
  const run = (generation.get(tile) ?? 0) + 1;
  generation.set(tile, run);
  return run;
};

function landAt(tile, char) {
  nextRun(tile);
  tile.querySelectorAll(".leaf").forEach((leaf) => leaf.remove());
  tile.dataset.c = char;
}

function pad(text, length) {
  return [...text.padEnd(length, " ")].map((c) => (c === " " ? NBSP : c));
}

function tilesOf(flap) {
  return [...flap.querySelectorAll(".t")];
}

function label(flap, text) {
  const sr = flap.querySelector(".sr-only");
  if (sr) sr.textContent = text.trim();
}

/** Shows text at once, with no animation. */
export function setFlap(flap, text) {
  const tiles = tilesOf(flap);
  pad(text, tiles.length).forEach((c, i) => {
    if (tiles[i]) landAt(tiles[i], c);
  });
  label(flap, text);
}

function makeLeaf(tile, cls, char) {
  const leaf = document.createElement("i");
  leaf.className = `leaf ${cls}`;
  leaf.dataset.c = char;
  tile.append(leaf);
  return leaf;
}

function flipOnce(tile, next) {
  const previous = tile.dataset.c;
  const under = makeLeaf(tile, "leaf--bot", previous);
  tile.dataset.c = next;
  const top = makeLeaf(tile, "leaf--top", previous);
  const bottom = makeLeaf(tile, "leaf--bot leaf--drop", next);
  const options = { duration: LEAF_MS, fill: "forwards" };
  return top
    .animate([{ transform: "rotateX(0deg)" }, { transform: "rotateX(-90deg)" }], { ...options, easing: "ease-in" })
    .finished.then(() => {
      top.remove();
      return bottom.animate([{ transform: "rotateX(90deg)" }, { transform: "rotateX(0deg)" }], { ...options, easing: "ease-out" }).finished;
    })
    .then(() => {
      under.remove();
      bottom.remove();
    })
    .catch(() => {
      tile.querySelectorAll(".leaf").forEach((leaf) => leaf.remove());
    });
}

function chainFor(from, to, spins, seed) {
  const chain = [];
  let index = Math.abs(CYCLE.indexOf(String(from).toLowerCase())) + seed;
  for (let n = 0; n < spins; n += 1) {
    index = (index + 5) % CYCLE.length;
    chain.push(CYCLE[index]);
  }
  chain.push(to);
  return chain;
}

async function spin(tile, chain, delay) {
  const run = nextRun(tile);
  if (delay) {
    await tile.animate([{ opacity: 1 }, { opacity: 1 }], { duration: delay }).finished.catch(() => {});
  }
  for (const char of chain) {
    if (generation.get(tile) !== run) return;
    await flipOnce(tile, char);
  }
}

/** Animates to text, flipping only the tiles that differ. Resolves when every tile has landed. */
export function flipTo(flap, text, { stagger = 34, spins = 3 } = {}) {
  label(flap, text);
  const tiles = tilesOf(flap);
  const target = pad(text, tiles.length);
  if (!motionAllowed()) {
    target.forEach((c, i) => {
      if (tiles[i]) landAt(tiles[i], c);
    });
    return Promise.resolve();
  }
  let order = 0;
  const jobs = [];
  tiles.forEach((tile, i) => {
    if (tile.dataset.c === target[i]) return;
    tile.querySelectorAll(".leaf").forEach((leaf) => leaf.remove());
    jobs.push(spin(tile, chainFor(tile.dataset.c, target[i], spins + (i % 2), i), order * stagger));
    order += 1;
  });
  return Promise.all(jobs);
}
