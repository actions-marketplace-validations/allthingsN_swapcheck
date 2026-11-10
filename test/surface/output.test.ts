import assert from "node:assert/strict";
import { test } from "node:test";
import { alignRows, clean, mdEscape, mdLink, pct, plural, usd, wantsColor } from "../../src/cli/output.ts";
import { confirmSpend } from "../../src/cli/spend.ts";
import { SwapcheckError } from "../../src/util/errors.ts";

test("color needs a TTY and respects NO_COLOR, --no-color and dumb terminals", () => {
  assert.equal(wantsColor({ isTTY: true }, {}, false), true);
  assert.equal(wantsColor({ isTTY: false }, {}, false), false);
  assert.equal(wantsColor({}, {}, false), false);
  assert.equal(wantsColor({ isTTY: true }, { NO_COLOR: "1" }, false), false);
  assert.equal(wantsColor({ isTTY: true }, {}, true), false);
  assert.equal(wantsColor({ isTTY: true }, { TERM: "dumb" }, false), false);
});

test("clean removes terminal control sequences and bidi overrides", () => {
  assert.equal(clean("a\u001b[31mb\u0007"), "a [31mb ");
  assert.equal(clean("x\u202ey"), "x y");
  assert.equal(clean("abcdef", 4), "abc…");
});

test("mdEscape neutralises markup and mentions", () => {
  const out = mdEscape("<img src=x> @team [a](b) `c` | d");
  assert.ok(!out.includes("<img"));
  assert.ok(!out.includes("@team"));
  assert.ok(!out.includes("["));
  assert.ok(!out.includes("|"));
});

test("mdLink only links http and https", () => {
  assert.match(mdLink("x", "https://example.com/a(b)"), /^\[x\]\(https:\/\/example\.com\/a%28b%29\)$/);
  assert.ok(!mdLink("x", "javascript:alert(1)").includes("]("));
  assert.ok(!mdLink("x", "not a url").includes("]("));
});

test("alignRows pads to the widest cell and leaves no trailing space", () => {
  assert.deepEqual(alignRows([["a", "1"], ["long", "2"]]), ["a     1", "long  2"]);
});

test("number formats", () => {
  assert.equal(usd(0), "$0.00");
  assert.equal(usd(0.001), "$0.0010");
  assert.equal(usd(12.5), "$12.50");
  assert.equal(pct(0.25), "+25%");
  assert.equal(pct(-0.1), "-10%");
  assert.equal(pct(null), "n/a");
  assert.equal(plural(1, "case"), "1 case");
  assert.equal(plural(2, "case"), "2 cases");
});

test("spending without a terminal needs --yes", async () => {
  await assert.rejects(confirmSpend(1.5, { yes: false, isTty: false }), (e: SwapcheckError) => e.exitCode === 2 && /--yes/.test(e.message) && /\$1\.50/.test(e.message));
  await confirmSpend(1.5, { yes: true, isTty: false });
});

test("on a terminal only an explicit yes spends", async () => {
  await confirmSpend(1, { yes: false, isTty: true, ask: async () => "y" });
  await confirmSpend(1, { yes: false, isTty: true, ask: async () => " YES " });
  for (const answer of ["", "n", "maybe", "yep"]) {
    await assert.rejects(confirmSpend(1, { yes: false, isTty: true, ask: async () => answer }), /Stopped before spending/);
  }
});
