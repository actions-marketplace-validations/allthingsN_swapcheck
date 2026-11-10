// Runs before first paint so the page never flashes the wrong theme or a half-built hero.
(function () {
  var root = document.documentElement;
  try {
    var saved = localStorage.getItem("swapcheck-theme");
    if (saved === "light" || saved === "dark") root.setAttribute("data-theme", saved);
  } catch (e) { /* storage blocked: follow the system theme */ }
  root.classList.add("js");
  if (window.matchMedia && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    root.classList.add("anim");
  }
})();
