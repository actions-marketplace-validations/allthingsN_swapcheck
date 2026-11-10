import assert from "node:assert/strict";
import { test } from "node:test";
import { lexJs, lexPython } from "../../src/scan/lexer.ts";
import type { Token } from "../../src/scan/lexer.ts";

const ofKind = (tokens: Token[], kind: Token["kind"]): string[] => tokens.filter((t) => t.kind === kind).map((t) => t.value);
const js = (src: string, jsx = false): Token[] => lexJs(src, { jsx }).tokens;
const py = (src: string): Token[] => lexPython(src).tokens;

test("js: strings report the position of their first character", () => {
  const [, , , str] = js('const a =\n  "gpt-4o";');
  assert.equal(str?.value, "gpt-4o");
  assert.equal(str?.line, 2);
  assert.equal(str?.column, 4);
});

test("js: escaped quotes stay inside the string", () => {
  assert.deepEqual(ofKind(js(String.raw`x = "a\"b"; y = 'c\'d';`), "string"), ['a"b', "c'd"]);
});

test("js: hex and unicode escapes decode", () => {
  assert.deepEqual(ofKind(js(String.raw`"\x67pt"; "\u0067pt"; "\u{67}pt";`), "string"), ["gpt", "gpt", "gpt"]);
});

test("js: line continuation inside a string", () => {
  assert.deepEqual(ofKind(js('"gpt\\\n-4";'), "string"), ["gpt-4"]);
});

test("js: an unterminated string stops at the newline and the next line still lexes", () => {
  const tokens = js('a = "oops\nb = "fine";');
  const strings = tokens.filter((t) => t.kind === "string");
  assert.equal(strings[0]?.unterminated, true);
  assert.equal(strings[1]?.value, "fine");
  assert.equal(strings[1]?.unterminated, undefined);
});

test("js: line and block comments are separated from code", () => {
  const tokens = js('// "gpt-4"\n/* "gpt-3" */ const a = "real";');
  assert.deepEqual(ofKind(tokens, "string"), ["real"]);
  assert.equal(ofKind(tokens, "comment").length, 2);
});

test("js: an unterminated block comment swallows the rest without hanging", () => {
  const tokens = js('/* never closed "gpt-4"');
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0]?.unterminated, true);
});

test("js: a quote in a comment does not open a string", () => {
  assert.deepEqual(ofKind(js("// don't\nconst a = 'x';"), "string"), ["x"]);
});

test("js: hashbang is skipped", () => {
  assert.deepEqual(ofKind(js('#!/usr/bin/env node "x"\nconst a = "y";'), "string"), ["y"]);
});

test("js: template without interpolation is static", () => {
  const [, , , t] = js("const a = `gpt-4o`;");
  assert.equal(t?.kind, "template");
  assert.equal(t?.value, "gpt-4o");
  assert.equal(t?.dynamic, false);
});

test("js: template with interpolation keeps static parts only", () => {
  const t = js("x = `gpt-${v}-mini`;").find((token) => token.kind === "template");
  assert.equal(t?.dynamic, true);
  assert.deepEqual(t?.parts, ["gpt-", "-mini"]);
  assert.equal(t?.value, "gpt--mini");
});

test("js: nested templates and strings inside interpolation", () => {
  const tokens = js('a = `outer ${ `inner ${ "deep" } end` } tail`;');
  const templates = tokens.filter((t) => t.kind === "template");
  assert.deepEqual(templates[0]?.parts, ["outer ", " tail"]);
  assert.deepEqual(templates[1]?.parts, ["inner ", " end"]);
  assert.deepEqual(ofKind(tokens, "string"), ["deep"]);
});

test("js: object literal braces inside an interpolation do not end it", () => {
  const tokens = js('a = `x${ f({ model: "gpt-4" }) }y`;');
  const template = tokens.find((t) => t.kind === "template");
  assert.deepEqual(template?.parts, ["x", "y"]);
  assert.deepEqual(ofKind(tokens, "string"), ["gpt-4"]);
});

test("js: escaped backtick and dollar in a template", () => {
  const t = js("a = `a\\`b\\${c}`;").find((token) => token.kind === "template");
  assert.equal(t?.dynamic, false);
  assert.equal(t?.value, "a`b${c}");
});

test("js: unterminated template ends cleanly at end of file", () => {
  const t = js("a = `never ${x} closed").find((token) => token.kind === "template");
  assert.equal(t?.unterminated, true);
  assert.deepEqual(t?.parts, ["never ", " closed"]);
});

test("js: regex literals are not strings, even with quotes", () => {
  const tokens = js(`const r = /["']gpt-4["']/g; const s = "after";`);
  assert.equal(tokens.filter((t) => t.kind === "regex").length, 1);
  assert.deepEqual(ofKind(tokens, "string"), ["after"]);
});

test("js: regex character class may contain a slash", () => {
  const tokens = js('const r = /[/"]/; const s = "x";');
  assert.deepEqual(ofKind(tokens, "string"), ["x"]);
});

test("js: division is not a regex", () => {
  const tokens = js('const a = b / c; const s = "x" / 2;');
  assert.equal(tokens.filter((t) => t.kind === "regex").length, 0);
  assert.deepEqual(ofKind(tokens, "string"), ["x"]);
});

test("js: regex after return and after an opening paren", () => {
  assert.equal(js("return /'/.test(x);").filter((t) => t.kind === "regex").length, 1);
  assert.equal(js("f(/'/);").filter((t) => t.kind === "regex").length, 1);
});

test("js: regex without closing slash falls back to punctuation", () => {
  const tokens = js('x = /unclosed\ny = "ok";');
  assert.deepEqual(ofKind(tokens, "string"), ["ok"]);
  assert.equal(tokens.filter((t) => t.kind === "regex").length, 0);
});

test("jsx: text is not lexed as code", () => {
  const tokens = js(`const a = <p>don't use "gpt-4" here</p>; const b = "after";`, true);
  assert.deepEqual(ofKind(tokens, "string"), ["after"]);
});

test("jsx: attributes are strings and expressions recurse", () => {
  const tokens = js(`<Chat model="gpt-4o" title={"t"} other={\`x\${y}\`} />`, true);
  assert.deepEqual(ofKind(tokens, "string"), ["gpt-4o", "t"]);
  assert.equal(tokens.filter((t) => t.kind === "template").length, 1);
});

test("jsx: attribute strings have no escapes and may span lines", () => {
  const strings = ofKind(js('<a b="x\\y\nz" />', true), "string");
  assert.deepEqual(strings, ["x\\y\nz"]);
});

test("jsx: nested elements, fragments and expression children", () => {
  const tokens = js(`const a = <><b>one's {"x"} <i>two's</i></b></>; const s = "end";`, true);
  assert.deepEqual(ofKind(tokens, "string"), ["x", "end"]);
});

test("jsx: generic arrows are not elements", () => {
  assert.deepEqual(ofKind(js('const f = <T,>(x: T) => "a";', true), "string"), ["a"]);
  assert.deepEqual(ofKind(js('const f = <T extends U>(x: T) => "a";', true), "string"), ["a"]);
});

test("jsx: less-than after a value stays an operator", () => {
  assert.deepEqual(ofKind(js('const a = b < c; const s = "x";', true), "string"), ["x"]);
});

test("ts: without jsx, angle brackets are operators", () => {
  assert.deepEqual(ofKind(js('const a = <string>b; const s = "x";'), "string"), ["x"]);
});

test("js: non-ASCII identifiers and astral characters do not derail the lexer", () => {
  const tokens = js('const ñandú = "a"; const 𝒳 = "b";');
  assert.deepEqual(ofKind(tokens, "string"), ["a", "b"]);
  assert.ok(ofKind(tokens, "ident").includes("ñandú"));
});

test("js: a byte order mark does not shift the first column", () => {
  assert.equal(js('\uFEFF"a";')[0]?.column, 2);
});

test("js: CRLF and lone CR both count as lines", () => {
  const tokens = js('"a";\r\n"b";\r"c";');
  assert.deepEqual(tokens.filter((t) => t.kind === "string").map((t) => t.line), [1, 2, 3]);
});

test("js: a 100k long line lexes quickly", () => {
  const src = `const a = "${"x".repeat(100_000)}"; const b = "after";`;
  const started = Date.now();
  assert.deepEqual(ofKind(js(src), "string").at(-1), "after");
  assert.ok(Date.now() - started < 2000);
});

test("js: pathological unmatched backslashes and quotes terminate", () => {
  assert.doesNotThrow(() => js('"\\'.repeat(20_000)));
  assert.doesNotThrow(() => js("`\\".repeat(20_000)));
});

test("js: very deep template nesting stops without a stack overflow", () => {
  const result = lexJs("`${".repeat(5000));
  assert.equal(result.truncated, true);
});

test("js: very deep JSX nesting stops without a stack overflow", () => {
  assert.doesNotThrow(() => lexJs("<a>".repeat(5000), { jsx: true }));
});

test("js: token count is capped", () => {
  const result = lexJs("a ".repeat(600_000));
  assert.equal(result.truncated, true);
  assert.equal(result.tokens.length, 500_000);
});

test("py: single, double and triple quoted strings", () => {
  assert.deepEqual(ofKind(py(`x = 'a'; y = "b"; z = '''c\nd'''`), "string"), ["a", "b", "c\nd"]);
});

test("py: escaped quotes", () => {
  assert.deepEqual(ofKind(py(String.raw`x = "a\"b"`), "string"), ['a"b']);
});

test("py: raw strings keep backslashes and still honour an escaped quote", () => {
  assert.deepEqual(ofKind(py(String.raw`x = r"a\nb"; y = r"c\"d"`), "string"), [String.raw`a\nb`, String.raw`c\"d`]);
});

test("py: string prefixes in any case", () => {
  assert.deepEqual(ofKind(py(`a = R"x"; b = Rb"y"; c = u"z"; d = BR"w"`), "string"), ["x", "y", "z", "w"]);
});

test("py: an identifier ending in a prefix letter is not a prefix", () => {
  const tokens = py(`bar = "x"`);
  assert.deepEqual(ofKind(tokens, "ident"), ["bar"]);
});

test("py: comments are separated and a hash inside a string is not a comment", () => {
  const tokens = py(`x = "a#b"  # "gpt-4"`);
  assert.deepEqual(ofKind(tokens, "string"), ["a#b"]);
  assert.deepEqual(ofKind(tokens, "comment"), [' "gpt-4"']);
});

test("py: module, function and class docstrings", () => {
  const src = `"""module gpt-4"""\ndef f():\n    """function gpt-4"""\n    return 1\nclass A:\n    'class gpt-4'\n`;
  const tokens = py(src);
  assert.equal(ofKind(tokens, "docstring").length, 3);
  assert.deepEqual(ofKind(tokens, "string"), []);
});

test("py: a string used as a value is not a docstring", () => {
  const tokens = py(`x = """value"""\nf("""arg""")\n("""parens""")\n"""a""" + b\n`);
  assert.deepEqual(ofKind(tokens, "docstring"), []);
  assert.equal(ofKind(tokens, "string").length, 4);
});

test("py: docstring followed by a comment or semicolon", () => {
  assert.equal(ofKind(py(`"""doc"""  # note\n`), "docstring").length, 1);
  assert.equal(ofKind(py(`"""doc"""; x = 1\n`), "docstring").length, 1);
});

test("py: backslash continuation does not start a logical line", () => {
  assert.deepEqual(ofKind(py(`x = \\\n"value"\n`), "docstring"), []);
});

test("py: f-string keeps static parts and is marked dynamic", () => {
  const t = py(`x = f"gpt-{v}-mini"`).find((token) => token.kind === "fstring");
  assert.equal(t?.dynamic, true);
  assert.deepEqual(t?.parts, ["gpt-", "-mini"]);
});

test("py: f-string with only doubled braces is static", () => {
  const t = py(`x = f"a{{b}}c"`).find((token) => token.kind === "fstring");
  assert.equal(t?.dynamic, false);
  assert.equal(t?.value, "a{b}c");
});

test("py: format spec and nested fields", () => {
  const t = py(`x = f"{a:>{w}} tail"`).find((token) => token.kind === "fstring");
  assert.deepEqual(t?.parts, ["", " tail"]);
});

test("py: format spec with quotes-like characters does not break out", () => {
  const tokens = py(`x = f"{a!r:>10}"\ny = "after"`);
  assert.deepEqual(ofKind(tokens, "string"), ["after"]);
});

test("py: strings inside f-string expressions are real strings", () => {
  const tokens = py(`x = f"{d['key']} and {g("arg")}"`);
  assert.deepEqual(ofKind(tokens, "string"), ["key", "arg"]);
});

test("py: same-quote nesting from Python 3.12", () => {
  const tokens = py(`x = f"{f"{inner}"}"\ny = "after"`);
  assert.equal(tokens.filter((t) => t.kind === "fstring").length, 2);
  assert.deepEqual(ofKind(tokens, "string"), ["after"]);
});

test("py: triple-quoted f-string spans lines", () => {
  const t = py(`x = f"""a\n{b}\nc"""`).find((token) => token.kind === "fstring");
  assert.deepEqual(t?.parts, ["a\n", "\nc"]);
});

test("py: raw f-string keeps a backslash before a field", () => {
  const t = py(String.raw`x = rf"\d{n}"`).find((token) => token.kind === "fstring");
  assert.deepEqual(t?.parts, [String.raw`\d`, ""]);
});

test("py: unterminated single-quoted string stops at the newline", () => {
  const tokens = py(`x = "oops\ny = "fine"`);
  const strings = tokens.filter((t) => t.kind === "string");
  assert.equal(strings[0]?.unterminated, true);
  assert.equal(strings[1]?.value, "fine");
});

test("py: unterminated triple quote and f-string end at end of file", () => {
  assert.equal(py(`x = """never`)[2]?.unterminated, true);
  assert.equal(py(`x = f"never`).find((t) => t.kind === "fstring")?.unterminated, true);
  assert.equal(py(`x = f"""never {a`).find((t) => t.kind === "fstring")?.unterminated, true);
});

test("py: a 100k long line and repeated quotes terminate", () => {
  assert.equal(ofKind(py(`x = "${"y".repeat(100_000)}"`), "string")[0]?.length, 100_000);
  assert.doesNotThrow(() => py('"\\'.repeat(20_000)));
});

test("py: very deep f-string nesting stops without a stack overflow", () => {
  assert.equal(lexPython('f"{'.repeat(5000)).truncated, true);
});
