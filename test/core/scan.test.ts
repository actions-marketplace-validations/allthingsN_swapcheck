import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { isDocumentationPath, isIgnored, matchSegment, parseEnvPairs, parseIgnoreRule, parseJsonPairs, parseTomlPairs, parseYamlPairs, scanProject } from "../../src/scan/scan.ts";
import { modelsIn, scanFiles, snapshot, withProject } from "./helpers.ts";

const expectModels = async (name: string, source: string, expected: string[]): Promise<void> => {
  assert.deepEqual(await modelsIn(name, source), expected);
};

test("python keyword argument", () => expectModels("a.py", `client.chat.completions.create(model="gpt-4o", messages=m)`, ["gpt-4o"]));
test("typescript object property", () => expectModels("a.ts", `await client.messages.create({ model: "claude-sonnet-4-5", max_tokens: 10 });`, ["claude-sonnet-4-5"]));
test("JSON-style quoted key", () => expectModels("a.ts", `const b = { "model": "gpt-4o" };`, ["gpt-4o"]));
test("constant assignment", () => expectModels("a.py", `MODEL = "gpt-9-preview"`, ["gpt-9-preview"]));
test("annotated assignment", () => expectModels("a.py", `model: str = "gpt-9-preview"`, ["gpt-9-preview"]));
test("typed const", () => expectModels("a.ts", `const modelName: string = "gpt-9-preview";`, ["gpt-9-preview"]));
test("default parameter", () => expectModels("a.py", `def run(model="gpt-9-preview"):\n    pass`, ["gpt-9-preview"]));
test("self attribute", () => expectModels("a.py", `self.model = "gpt-9-preview"`, ["gpt-9-preview"]));
test("subscript assignment", () => expectModels("a.py", `params["model"] = "gpt-9-preview"`, ["gpt-9-preview"]));
test("engine and deployment parameters", async () => {
  await expectModels("a.py", `openai.Completion.create(engine="text-davinci-003")`, ["text-davinci-003"]);
  await expectModels("a.py", `AzureChatOpenAI(azure_deployment="gpt-4o-prod-9")`, ["gpt-4o-prod-9"]);
});
test("first positional argument of a known client", async () => {
  await expectModels("a.ts", `const m = openai("gpt-9-preview");`, ["gpt-9-preview"]);
  await expectModels("a.py", `m = genai.GenerativeModel("gemini-9-pro")`, ["gemini-9-pro"]);
  await expectModels("a.py", `llm = ChatOpenAI("gpt-9-preview")`, ["gpt-9-preview"]);
});
test("env default via getenv", () => expectModels("a.py", `m = os.getenv("OPENAI_MODEL", "gpt-9-preview")`, ["gpt-9-preview"]));
test("env default via environ.get", () => expectModels("a.py", `m = os.environ.get("MODEL", "gpt-9-preview")`, ["gpt-9-preview"]));
test("env fallback with ||", () => expectModels("a.ts", `const m = process.env.MODEL || "gpt-9-preview";`, ["gpt-9-preview"]));
test("env fallback with ??", () => expectModels("a.ts", `const m = process.env.OPENAI_MODEL ?? "gpt-9-preview";`, ["gpt-9-preview"]));
test("python or-fallback", () => expectModels("a.py", `m = model or "gpt-9-preview"`, ["gpt-9-preview"]));
test("ternary branches keep the key", () => expectModels("a.ts", `f({ model: fast ? "gpt-9-mini" : "gpt-9-large", t: 1 });`, ["gpt-9-mini", "gpt-9-large"]));
test("python conditional keeps the key", () => expectModels("a.py", `f(model="gpt-9-mini" if fast else "gpt-9-large")`, ["gpt-9-mini", "gpt-9-large"]));
test("list under a model key", () => expectModels("a.py", `FALLBACK_MODELS = ["gpt-9-mini", "gpt-9-large"]`, ["gpt-9-mini", "gpt-9-large"]));
test("nested model name", () => expectModels("a.ts", `const c = { model: { name: "gpt-9-preview" } };`, ["gpt-9-preview"]));
test("JSX attribute", () => expectModels("a.tsx", `const a = <Chat model="gpt-9-preview" />;`, ["gpt-9-preview"]));
test("JSX expression attribute", () => expectModels("a.tsx", `const a = <Chat model={fast ? "gpt-9-mini" : "gpt-9-large"} />;`, ["gpt-9-mini", "gpt-9-large"]));
test("static template", () => expectModels("a.ts", "f({ model: `gpt-9-preview` });", ["gpt-9-preview"]));
test("static f-string", () => expectModels("a.py", `f(model=f"gpt-9-preview")`, ["gpt-9-preview"]));
test("known model outside model context", () => expectModels("a.py", `chosen = "claude-sonnet-4-5"`, ["claude-sonnet-4-5"]));

test("comments do not count", async () => {
  await expectModels("a.py", `# model="gpt-4o"\nx = 1`, []);
  await expectModels("a.ts", `// model: "gpt-4o"\n/* model: "gpt-4o" */\nconst x = 1;`, []);
});
test("docstrings do not count", () => expectModels("a.py", `def f():\n    """Uses model="gpt-4o" or gpt-4o"""\n    return 1`, []));
test("string with spaces does not count", () => expectModels("a.py", `f(model="gpt-4o is fast")`, []));
test("JSX text does not count", () => expectModels("a.tsx", `const a = <p>gpt-4o "gpt-4o"</p>;`, []));
test("unknown pattern outside model context is dropped", async () => {
  await expectModels("a.py", `tag = "gpt-9-preview"`, []);
  await expectModels("a.ts", `const label = "claude-9-opus";`, []);
});
test("short known ID outside model context is dropped", () => expectModels("a.py", `plan = "o1"`, []));
test("short known ID inside model context counts", () => expectModels("a.py", `f(model="o1")`, ["o1"]));
test("package names and paths in model context are dropped", async () => {
  await expectModels("a.py", `f(model="./models/gpt-4o.bin")`, []);
  await expectModels("a.ts", `const model = "@anthropic-ai/sdk";`, []);
  await expectModels("a.py", `model = "https://x.test/gpt-4o"`, []);
});
test("imports are dropped", async () => {
  await expectModels("a.ts", `import x from "gpt-4o";`, []);
  await expectModels("a.ts", `const x = require("gpt-4o");`, []);
});
test("comparisons are dropped", async () => {
  await expectModels("a.py", `if model == "gpt-4o":\n    pass`, []);
  await expectModels("a.ts", `if (model === "gpt-4o") {}`, []);
  await expectModels("a.ts", `if ("gpt-4o" !== model) {}`, []);
  await expectModels("a.py", `if "gpt-4o" in name:\n    pass`, []);
  await expectModels("a.ts", `switch (m) { case "gpt-4o": break; }`, []);
});
test("membership lists are dropped", async () => {
  await expectModels("a.py", `if model in ["gpt-4o", "gpt-4.1"]:\n    pass`, []);
  await expectModels("a.ts", `if (["gpt-4o", "gpt-4.1"].includes(model)) {}`, []);
});
test("string method arguments are dropped", async () => {
  await expectModels("a.ts", `if (m.startsWith("gpt-4o")) {}`, []);
  await expectModels("a.py", `m.startswith("gpt-4o")`, []);
});
test("logging is dropped", async () => {
  await expectModels("a.py", `print("gpt-4o")`, []);
  await expectModels("a.ts", `console.log("gpt-4o");`, []);
  await expectModels("a.py", `logger.info("gpt-4o")`, []);
});
test("tokenizer lookups are dropped", async () => {
  await expectModels("a.py", `tiktoken.encoding_for_model("gpt-4o")`, []);
  await expectModels("a.py", `AutoTokenizer.from_pretrained("meta-llama/Llama-3.3-70B")`, []);
});
test("price tables are dropped", async () => {
  await expectModels("a.py", `PRICES = {"gpt-4o": 2.5, "claude-sonnet-4-5": 3}`, []);
  await expectModels("a.ts", `const MODEL_COST = { "gpt-4o": { input: 1 } };`, []);
  await expectModels("a.py", `PRICING = [{"model": "gpt-4o", "input": 2.5}]`, []);
  await expectModels("a.py", `TABLE = {"model": "gpt-4o", "input_price": 2.5}`, []);
  await expectModels("a.ts", `const t = [{ model: "gpt-4o", cost: 3 }];`, []);
});
test("object keys are lookups, not uses", () => expectModels("a.py", `LIMITS = {"gpt-4o": 128000}`, []));
test("subscript lookups are dropped", () => expectModels("a.py", `x = LIMITS["gpt-4o"]`, []));
test("map get lookups are dropped", () => expectModels("a.ts", `const x = LIMITS.get("gpt-4o");`, []));
test("TS type declarations are dropped", async () => {
  await expectModels("a.ts", `type M = "gpt-4o" | "gpt-4.1";`, []);
  await expectModels("a.ts", `type M = "gpt-4o";`, []);
  await expectModels("a.ts", `export interface X { model: "gpt-4o" }`, []);
  await expectModels("a.ts", `function f(m: "gpt-4o" | "gpt-4.1") {}`, []);
});
test("python Literal is dropped", () => expectModels("a.py", `M = Literal["gpt-4o", "gpt-4.1"]`, []));
test("key context does not leak across statements", () => expectModels("a.ts", `const model = pick();\nconst tag = "gpt-9-preview";`, []));
test("key context does not leak across commas", () => expectModels("a.ts", `f({ model: m, tag: "gpt-9-preview" });`, []));
test("key context does not leak across python lines", () => expectModels("a.py", `model = pick()\ntag = "gpt-9-preview"`, []));
test("a false-friend key stays out of model context", () => expectModels("a.py", `model_path = "gpt-9-preview"`, []));
test("class names and CSS-like strings are dropped", () => expectModels("a.tsx", `const a = <div className="gpt-9-button" />;`, []));

test("positions point at the first character of the ID", async () => {
  const result = await scanFiles({ "a.py": `\n\nf(model="gpt-4o")` });
  assert.deepEqual(result.findings[0], { model: "gpt-4o", file: "a.py", line: 3, column: 10, kind: "code", known: true, provider: "openai", route: "openai-api" });
});

test("template with interpolation under a model key is unresolved", async () => {
  const result = await scanFiles({ "a.ts": "f({ model: `gpt-${v}` });" });
  assert.equal(result.findings.length, 0);
  assert.equal(result.unresolved.length, 1);
  assert.match(result.unresolved[0]?.reason ?? "", /template literal/);
  assert.equal(result.unresolved[0]?.expression, "`gpt-${v}`");
});

test("f-string under a model parameter is unresolved", async () => {
  const result = await scanFiles({ "a.py": `f(model=f"gpt-{v}")` });
  assert.equal(result.unresolved.length, 1);
  assert.match(result.unresolved[0]?.reason ?? "", /f-string/);
});

test("interpolated display labels under a model key are not unresolved", async () => {
  const result = await scanFiles({ "a.ts": "const d = { model: `${brand} ${name}` };\nconst e = { model: brand + ' TV' };" });
  assert.deepEqual(result.unresolved, []);
});

test("pydantic create_model and model_ methods are not model context", async () => {
  const result = await scanFiles({ "a.py": `Args = create_model(f"{name}_args", a=(int, 1))\nx = Foo.model_validate(f"{y}")\nz = create_model("gpt-9-preview")` });
  assert.deepEqual(result.unresolved, []);
  assert.deepEqual(result.findings, []);
});

test("a named first argument does not inherit the callee's model context", async () => {
  const result = await scanFiles({ "a.py": `AgentModel(agent_id=f"{a}:{b}")\nAgent(tag="gpt-9-preview")` });
  assert.deepEqual(result.unresolved, []);
  assert.deepEqual(result.findings, []);
});

test("interpolated strings elsewhere are not reported", async () => {
  const result = await scanFiles({ "a.ts": "const m = `hello ${who}`;", "b.py": `x = f"hello {who}"` });
  assert.equal(result.unresolved.length, 0);
});

test("concatenation and .format under a model key are unresolved", async () => {
  const concat = await scanFiles({ "a.ts": `f({ model: "gpt-" + v });` });
  assert.equal(concat.unresolved.length, 1);
  const format = await scanFiles({ "a.py": `f(model="gpt-{}".format(v))` });
  assert.equal(format.unresolved.length, 1);
});

test("unresolved expressions are capped and redacted", async () => {
  const secret = `sk-${"a".repeat(40)}`;
  const result = await scanFiles({ "a.ts": `f({ model: \`${secret}\${x}${"y".repeat(500)}\` });` });
  const expression = result.unresolved[0]?.expression ?? "";
  assert.ok(expression.length <= 120);
  assert.ok(!expression.includes(secret));
});

test("route: bedrock ID form", async () => {
  const { findings } = await scanFiles({ "a.py": `f(modelId="anthropic.claude-3-haiku-20240307-v1:0")` });
  assert.equal(findings[0]?.route, "aws-bedrock");
  assert.equal(findings[0]?.known, true);
});

test("route: vertex path form", async () => {
  const { findings } = await scanFiles({ "a.py": `f(model="publishers/google/models/gemini-2.5-pro")` });
  assert.equal(findings[0]?.model, "gemini-2.5-pro");
  assert.equal(findings[0]?.route, "google-vertex");
});

test("route: AnthropicBedrock constructor", async () => {
  const { findings } = await scanFiles({ "a.py": `c = AnthropicBedrock()\nc.messages.create(model="claude-3-5-sonnet-20241022")` });
  assert.equal(findings[0]?.route, "aws-bedrock");
});

test("route: ChatBedrock and VertexAI constructors", async () => {
  assert.equal((await scanFiles({ "a.py": `ChatBedrock(model_id="claude-9-sonnet")` })).findings[0]?.route, "aws-bedrock");
  assert.equal((await scanFiles({ "a.py": `v = VertexAI(project="p")\nv.generate(model="gemini-2.5-pro")` })).findings[0]?.route, "google-vertex");
});

test("route: base URL nearby", async () => {
  const { findings } = await scanFiles({ "a.ts": `const c = new OpenAI({ baseURL: "https://openrouter.ai/api/v1" });\nawait c.chat.completions.create({ model: "gpt-4o" });` });
  assert.equal(findings[0]?.route, "openrouter");
});

test("route: boto3 bedrock-runtime client", async () => {
  const { findings } = await scanFiles({ "a.py": `c = boto3.client("bedrock-runtime")\nc.converse(modelId="claude-3-5-sonnet-20241022")` });
  assert.equal(findings[0]?.route, "aws-bedrock");
});

test("route: Azure client applies only to OpenAI models", async () => {
  const { findings } = await scanFiles({ "a.py": `c = AzureOpenAI()\nc.create(model="gpt-4o")\nd(model="claude-sonnet-4-5")` });
  assert.equal(findings[0]?.route, "azure-openai");
  assert.equal(findings[1]?.route, "anthropic-api");
});

test("route: default is the vendor's first-party API", async () => {
  const { findings } = await scanFiles({ "a.py": `f(model="gpt-9-preview")\ng(model="claude-9-opus")\nh(model="gemini-9-pro")` });
  assert.deepEqual(findings.map((f) => f.route), ["openai-api", "anthropic-api", "google-ai-studio"]);
});

test("route: an ID's own form beats a nearby client", async () => {
  const { findings } = await scanFiles({ "a.py": `c = OpenAI()\nf(model="anthropic.claude-3-haiku-20240307-v1:0")` });
  assert.equal(findings[0]?.route, "aws-bedrock");
});

test("route: the same model on two routes stays as two findings", async () => {
  const source = `a = Anthropic()\na.messages.create(model="claude-3-5-sonnet-20241022")\n\nb = AnthropicBedrock()\nb.messages.create(model="claude-3-5-sonnet-20241022")\n`;
  const { findings } = await scanFiles({ "a.py": source });
  assert.deepEqual(findings.map((f) => [f.model, f.route]), [
    ["claude-3-5-sonnet-20241022", "anthropic-api"],
    ["claude-3-5-sonnet-20241022", "aws-bedrock"],
  ]);
});

test("config: YAML keys, nested names, lists and comments", async () => {
  const source = `# model: gpt-4o\nllm:\n  model: gpt-4o\nagents:\n  - name: writer\n    model: "claude-sonnet-4-5"\nfallback_models:\n  - gemini-2.5-flash\nmodel:\n  name: grok-4\ndescription: gpt-4.1\n`;
  const { findings } = await scanFiles({ "app.yaml": source });
  assert.deepEqual(findings.map((f) => [f.model, f.kind, f.line]), [
    ["gpt-4o", "config", 3],
    ["claude-sonnet-4-5", "config", 6],
    ["gemini-2.5-flash", "config", 8],
    ["grok-4", "config", 10],
  ]);
});

test("config: YAML column points at the value", () => {
  assert.equal(parseYamlPairs(`a:\n  model: "gpt-4o" # note`)[0]?.column, 11);
});

test("config: YAML block scalars are not scanned", async () => {
  const { findings } = await scanFiles({ "a.yml": `prompt: |\n  model: gpt-4o\n  more\nmodel: gpt-4.1\n` });
  assert.deepEqual(findings.map((f) => f.model), ["gpt-4.1"]);
});

test("config: YAML flow list", async () => {
  const { findings } = await scanFiles({ "a.yml": `models: [gpt-4o, "gpt-4.1"]` });
  assert.deepEqual(findings.map((f) => f.model), ["gpt-4o", "gpt-4.1"]);
});

test("config: broken YAML does not throw", () => {
  assert.doesNotThrow(() => parseYamlPairs(`a: [\n  : : :\n{{ template }}\n- - -\n"unterminated: x`));
});

test("config: JSON keys and nesting", async () => {
  const { findings } = await scanFiles({ "c.json": `{"model": "gpt-4o", "other": "gpt-4.1", "llm": {"models": ["grok-4", "o1"], "name": "x"}, "tag": "gemini-2.5-flash"}` });
  assert.deepEqual(findings.map((f) => f.model), ["gpt-4o", "grok-4", "o1"]);
});

test("config: JSON run output and datasets are not configuration", async () => {
  const record = `{"model": "gpt-4o"}`;
  const result = await scanFiles({ "results/run1/summary.json": record, "data/seed.json": record, "logs/a.json": record, "config/a.json": record });
  assert.deepEqual(result.findings.map((f) => f.file), ["config/a.json"]);
});

test("config: JSON keys named after models are not values", () => {
  assert.deepEqual(parseJsonPairs(`{"gpt-4o": {"input": 1}}`), []);
});

test("config: JSON comma clears the pending key", () => {
  const pairs = parseJsonPairs(`{"a": "x", "b": "y"}`);
  assert.deepEqual(pairs.map((p) => p.path), [["a"], ["b"]]);
});

test("config: TOML sections, arrays and comments", async () => {
  const source = `# model = "gpt-4o"\n[tool.ai]\nmodel = "gpt-4o"  # note\nname = "gpt-4.1"\nmodels = ["grok-4", "o1"]\nfallback_models = [\n  "gemini-2.5-flash",\n]\n`;
  const { findings } = await scanFiles({ "c.toml": source });
  assert.deepEqual(findings.map((f) => f.model), ["gpt-4o", "grok-4", "o1", "gemini-2.5-flash"]);
});

test("config: TOML multi-line strings are skipped", () => {
  assert.deepEqual(parseTomlPairs(`p = """\nmodel = "gpt-4o"\n"""\nq = 1`).map((x) => x.value), ["1"]);
});

test("config: .env and .env.example", async () => {
  const { findings } = await scanFiles({ ".env": `OPENAI_MODEL=gpt-4o\nexport LLM_MODEL="grok-4"\nSECRET=claude-sonnet-4-5\n# MODEL=gpt-4.1\n`, ".env.example": `DEFAULT_MODEL=gemini-2.5-flash # note\n` });
  assert.deepEqual(findings.map((f) => [f.model, f.kind, f.file]), [
    ["gpt-4o", "env", ".env"],
    ["grok-4", "env", ".env"],
    ["gemini-2.5-flash", "env", ".env.example"],
  ]);
});

test("config: env column includes the export prefix", () => {
  assert.equal(parseEnvPairs(`export MODEL="gpt-4o"`)[0]?.column, 15);
});

test("config: Bedrock switch in .env sets the route", async () => {
  const { findings } = await scanFiles({ ".env": `CLAUDE_CODE_USE_BEDROCK=1\nANTHROPIC_MODEL=claude-3-5-sonnet-20241022\n` });
  assert.equal(findings[0]?.route, "aws-bedrock");
});

test("config: a disabled route switch has no effect", async () => {
  const { findings } = await scanFiles({ ".env": `CLAUDE_CODE_USE_BEDROCK=0\nANTHROPIC_MODEL=claude-3-5-sonnet-20241022\n` });
  assert.equal(findings[0]?.route, "anthropic-api");
});

test("config: provider key sets the route for a sibling model", async () => {
  const { findings } = await scanFiles({ "a.yaml": `provider: bedrock\nmodel: claude-3-5-sonnet-20241022\n` });
  assert.equal(findings[0]?.route, "aws-bedrock");
});

test("config: env values are never reported beyond the model", async () => {
  const result = await scanFiles({ ".env": `API_KEY=sk-${"a".repeat(40)}\nMODEL=gpt-4o\n` });
  assert.ok(!JSON.stringify(result).includes("sk-a"));
});

test("skips dependency, build, vendored and generated folders", async () => {
  const code = `f(model="gpt-4o")`;
  const dirs = ["node_modules/x", "dist", "build", "venv", ".venv", "vendor", "third_party", "generated", "__generated__", ".git/x", "coverage", "site-packages", ".next"];
  const files = Object.fromEntries(dirs.map((dir) => [`${dir}/a.py`, code]));
  const result = await scanFiles({ ...files, "src/a.py": code });
  assert.deepEqual(result.findings.map((f) => f.file), ["src/a.py"]);
});

test("skips virtualenvs by marker file whatever the folder is called", async () => {
  const result = await scanFiles({ "myenv/pyvenv.cfg": "home = /x", "myenv/lib/a.py": `f(model="gpt-4o")` });
  assert.equal(result.findings.length, 0);
});

test("scans .github workflows but no other hidden folders", async () => {
  const result = await scanFiles({ ".github/workflows/a.yml": "model: gpt-4o", ".claude/b.yml": "model: gpt-4o" });
  assert.deepEqual(result.findings.map((f) => f.file), [".github/workflows/a.yml"]);
});

test("skips minified files by name and shape", async () => {
  const code = `f({model:"gpt-4o"});`;
  const dense = `${code}${"x".repeat(5000)}`;
  const result = await scanFiles({ "a.min.js": code, "b.js": dense });
  assert.equal(result.findings.length, 0);
});

test("skips lockfiles and swapcheck's own files", async () => {
  const yaml = "model: gpt-4o";
  const result = await scanFiles({ "pnpm-lock.yaml": yaml, "package-lock.json": `{"model":"gpt-4o"}`, "models.lock": `{"model":"gpt-4o"}`, "swapcheck.yaml": yaml, "swapcheck/cases/a.json": `{"model":"gpt-4o"}` });
  assert.equal(result.findings.length, 0);
});

test("skips files over 2 MB", async () => {
  const big = `f(model="gpt-4o")\n${"# pad\n".repeat(400_000)}`;
  assert.ok(big.length > 2 * 1024 * 1024);
  const result = await scanFiles({ "big.py": big, "ok.py": `f(model="gpt-4o")` });
  assert.deepEqual(result.findings.map((f) => f.file), ["ok.py"]);
  assert.equal(result.files_scanned, 1);
});

test("skips binaries", async () => {
  const result = await scanFiles({ "a.py": `f(model="gpt-4o")\0binary` });
  assert.equal(result.findings.length, 0);
});

test("skips generated code by header", async () => {
  const result = await scanFiles({ "a.ts": `// @generated\nf({ model: "gpt-4o" });`, "b.py": `# DO NOT EDIT\nf(model="gpt-4o")` });
  assert.equal(result.findings.length, 0);
});

test("skips declaration files", () => expectModels("a.d.ts", `declare const m = "gpt-4o";`, []));

test("tests, fixtures, examples and docs folders do not count by default", async () => {
  const code = `f(model="gpt-4o")`;
  const result = await scanFiles({ "tests/a.py": code, "src/__tests__/a.py": code, "fixtures/a.py": code, "src/a_test.py": code, "src/test_a.py": code, "src/a.test.py": code, "conftest.py": code, "examples/a.py": code, "docs/a.py": code, "e2e/a.py": code });
  assert.equal(result.findings.length, 0);
  assert.equal(result.files_scanned, 0);
});

test("JS test files do not count by default", async () => {
  const code = `f({ model: "gpt-4o" });`;
  const result = await scanFiles({ "src/a.test.ts": code, "src/a.spec.js": code, "src/a.stories.tsx": code });
  assert.equal(result.findings.length, 0);
});

test("isDocumentationPath leaves production paths alone", () => {
  for (const rel of ["src/a.py", "src/contest/a.py", "latest/a.py", "src/testing.py", "src/attest_test_x.py"]) assert.equal(isDocumentationPath(rel), false, rel);
});

test("seed scripts, benchmarks and recorded results are not production use", async () => {
  for (const rel of ["src/app/seed.py", "db/seeds.ts", "benchmarks/kernels/run.py", "conformance/gen.py"]) assert.equal(isDocumentationPath(rel), true, rel);
  for (const rel of ["src/seeding.py", "src/seed_model.py", "src/benchmark_api.py"]) assert.equal(isDocumentationPath(rel), false, rel);
  const result = await scanFiles({
    "artifacts/e2e_results.json": `{"selection_model": "gpt-4o"}`,
    "conformance/vectors.json": `{"request_model": "gpt-4o"}`,
    "src/seed.py": `Row(model="gpt-4o")`,
    "src/app.py": `client.create(model="gpt-4.1")`,
  });
  assert.deepEqual(result.findings.map((f) => f.model), ["gpt-4.1"]);
});

test("includeDocs reports comments, docstrings, tests and markdown as docs", async () => {
  const result = await scanFiles(
    { "a.py": `# uses gpt-4o\ndef f():\n    """Model: claude-sonnet-4-5."""\n`, "tests/b.py": `f(model="gpt-4.1")`, "README.md": "Try `grok-4` today.\n" },
    { includeDocs: true },
  );
  assert.deepEqual(result.findings.map((f) => [f.model, f.kind]).sort(), [
    ["claude-sonnet-4-5", "docs"],
    ["gpt-4.1", "docs"],
    ["gpt-4o", "docs"],
    ["grok-4", "docs"],
  ]);
});

test("includeDocs reports the right line in a multi-line docstring", async () => {
  const result = await scanFiles({ "a.py": `"""first\n\n  uses gpt-4o here\n"""\n` }, { includeDocs: true });
  assert.equal(result.findings[0]?.line, 3);
  assert.equal(result.findings[0]?.column, 8);
});

test("gitignore: patterns, directories, anchoring and negation", async () => {
  const code = `f(model="gpt-4o")`;
  const result = await scanFiles({
    ".gitignore": `# comment\n*.gen.py\nignored/\n/rootonly.py\nsub/dir/*.py\n!keep.gen.py\n`,
    "a.gen.py": code,
    "keep.gen.py": code,
    "ignored/a.py": code,
    "nested/ignored/a.py": code,
    "rootonly.py": code,
    "nested/rootonly.py": code,
    "sub/dir/a.py": code,
    "sub/other/a.py": code,
  });
  assert.deepEqual(result.findings.map((f) => f.file), ["keep.gen.py", "nested/rootonly.py", "sub/other/a.py"]);
});

test("gitignore: nested file applies only below itself and can re-include", async () => {
  const code = `f(model="gpt-4o")`;
  const result = await scanFiles({ ".gitignore": `*.py\n!a/\n!*/`, "a/.gitignore": `!keep.py\nnope.py\n`, "a/keep.py": code, "a/nope.py": code, "b/keep.py": code });
  assert.deepEqual(result.findings.map((f) => f.file), ["a/keep.py"]);
});

test("gitignore: a file cannot be re-included under an ignored folder", async () => {
  const result = await scanFiles({ ".gitignore": `out2/\n!out2/keep.py\n`, "out2/keep.py": `f(model="gpt-4o")` });
  assert.equal(result.findings.length, 0);
});

test("gitignore: double star forms", () => {
  const applies = (pattern: string, rel: string): boolean => isIgnored([parseIgnoreRule(pattern, "")!], rel, false);
  assert.equal(applies("**/foo.py", "foo.py"), true);
  assert.equal(applies("**/foo.py", "a/b/foo.py"), true);
  assert.equal(applies("a/**", "a/b/c.py"), true);
  assert.equal(applies("a/**", "b/c.py"), false);
  assert.equal(applies("a/**/z.py", "a/z.py"), true);
  assert.equal(applies("a/**/z.py", "a/b/c/z.py"), true);
  assert.equal(applies("a/*/z.py", "a/b/c/z.py"), false);
});

test("gitignore: unanchored name matches at any depth, slash anchors", () => {
  const applies = (pattern: string, rel: string): boolean => isIgnored([parseIgnoreRule(pattern, "")!], rel, false);
  assert.equal(applies("foo.py", "x/y/foo.py"), true);
  assert.equal(applies("/foo.py", "x/foo.py"), false);
  assert.equal(applies("x/foo.py", "y/x/foo.py"), false);
});

test("gitignore: directory-only rule skips files of that name", () => {
  assert.equal(isIgnored([parseIgnoreRule("foo/", "")!], "foo", false), false);
  assert.equal(isIgnored([parseIgnoreRule("foo/", "")!], "foo", true), true);
});

test("gitignore: comments, blanks and escapes", () => {
  assert.equal(parseIgnoreRule("# c", ""), null);
  assert.equal(parseIgnoreRule("", ""), null);
  assert.equal(parseIgnoreRule("   ", ""), null);
  assert.equal(parseIgnoreRule("\\#x", "")?.segments[0], "#x");
  assert.equal(parseIgnoreRule("\\!x", "")?.negated, false);
  assert.equal(parseIgnoreRule("x".repeat(600), ""), null);
});

test("glob: star, question mark and classes", () => {
  assert.equal(matchSegment("a*c", "abbbc"), true);
  assert.equal(matchSegment("a?c", "abc"), true);
  assert.equal(matchSegment("a?c", "ac"), false);
  assert.equal(matchSegment("[ab]x", "bx"), true);
  assert.equal(matchSegment("[!ab]x", "bx"), false);
  assert.equal(matchSegment("[a-c]x", "cx"), true);
  assert.equal(matchSegment("[a", "[a"), true);
  assert.equal(matchSegment("", ""), true);
  assert.equal(matchSegment("*", ""), true);
});

test("glob: pathological patterns stay fast", () => {
  const started = Date.now();
  assert.equal(matchSegment("*a".repeat(200) + "b", "a".repeat(5000)), false);
  assert.ok(Date.now() - started < 2000);
});

test("exclude option uses gitignore syntax", async () => {
  const code = `f(model="gpt-4o")`;
  const result = await scanFiles({ "skip/a.py": code, "b.gen.py": code, "c.py": code }, { exclude: ["skip/", "*.gen.py"] });
  assert.deepEqual(result.findings.map((f) => f.file), ["c.py"]);
});

test("adversarial: a 10k long line with a model call", async () => {
  const source = `x = "${"y".repeat(10_000)}"\nf(model="gpt-4o")\n${"# pad\n".repeat(40)}`;
  assert.deepEqual(await modelsIn("a.py", source), ["gpt-4o"]);
});

test("adversarial: unterminated strings in code do not hide later lines", async () => {
  await expectModels("a.ts", `const a = "oops\nf({ model: "gpt-4o" });`, ["gpt-4o"]);
  await expectModels("a.py", `a = 'oops\nf(model="gpt-4o")`, ["gpt-4o"]);
});

test("adversarial: an unterminated model string is not reported", () => expectModels("a.py", `f(model="gpt-4o`, []));

test("adversarial: unbalanced brackets do not throw", async () => {
  await expectModels("a.ts", `}})]] f({ model: "gpt-4o" }); ((((`, ["gpt-4o"]);
  await expectModels("a.py", `)))]]} f(model="gpt-4o") (((`, ["gpt-4o"]);
});

test("adversarial: deeply nested brackets", async () => {
  const deep = "[".repeat(100_000);
  await assert.doesNotReject(() => scanFiles({ "a.ts": `${deep}\n`, "b.py": `${deep}\n`, "c.json": deep, "d.yaml": `a: ${deep}`, "e.toml": `a = ${deep}` }));
});

test("adversarial: random bytes in every supported format", async () => {
  const noise = Array.from({ length: 4000 }, (_, i) => "\"'`\\${}[]()<>/*#:=\n ab1-"[(i * 7919) % 24]).join("");
  await assert.doesNotReject(() => scanFiles({ "a.ts": noise, "a.tsx": noise, "a.py": noise, "a.json": noise, "a.yaml": noise, "a.toml": noise, ".env": noise }));
});

test("findings are capped, in a stable order", async () => {
  const result = await scanFiles({ "b.py": `f(model="gpt-4o")`, "a.py": `\n\nf(model="gpt-4o")\nf(model="gpt-4.1")` });
  assert.deepEqual(result.findings.map((f) => `${f.file}:${f.line}`), ["a.py:3", "a.py:4", "b.py:1"]);
});

test("a missing root fails with a plain sentence", async () => {
  await assert.rejects(() => scanProject("/nonexistent/swapcheck-root", snapshot()), /does not exist/);
});

test("symlink: a link to a file outside the root is not read", async () => {
  const outside = await mkdtemp(path.join(tmpdir(), "swapcheck-out-"));
  try {
    await writeFile(path.join(outside, "secret.py"), `f(model="gpt-4o")`);
    await withProject({ "ok.py": `f(model="gpt-4.1")` }, async (root) => {
      await symlink(path.join(outside, "secret.py"), path.join(root, "link.py"));
      const result = await scanProject(root, snapshot());
      assert.deepEqual(result.findings.map((f) => f.model), ["gpt-4.1"]);
    });
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

test("symlink: a link to a folder outside the root is not walked", async () => {
  const outside = await mkdtemp(path.join(tmpdir(), "swapcheck-out-"));
  try {
    await writeFile(path.join(outside, "secret.py"), `f(model="gpt-4o")`);
    await withProject({}, async (root) => {
      await symlink(outside, path.join(root, "linked"));
      assert.equal((await scanProject(root, snapshot())).findings.length, 0);
    });
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

test("symlink: a loop inside the root terminates and counts once", async () => {
  await withProject({ "src/a.py": `f(model="gpt-4o")` }, async (root) => {
    await symlink(path.join(root, "src"), path.join(root, "src", "loop"));
    await symlink(path.join(root, "src", "a.py"), path.join(root, "alias.py"));
    const result = await scanProject(root, snapshot());
    assert.deepEqual(result.findings.map((f) => f.file), ["src/a.py"]);
  });
});

test("symlink: a dangling link is ignored", async () => {
  await withProject({}, async (root) => {
    await symlink(path.join(root, "gone.py"), path.join(root, "broken.py"));
    assert.equal((await scanProject(root, snapshot())).files_scanned, 0);
  });
});

test("a root reached through a symlink still scans", async () => {
  await withProject({ "real/a.py": `f(model="gpt-4o")` }, async (base) => {
    const link = path.join(base, "viaLink");
    await symlink(path.join(base, "real"), link);
    const result = await scanProject(link, snapshot());
    assert.deepEqual(result.findings.map((f) => f.file), ["a.py"]);
    assert.equal(result.root, link);
  });
});

test("an unreadable file is skipped without failing the scan", { skip: process.getuid?.() === 0 }, async () => {
  await withProject({ "a.py": `f(model="gpt-4o")`, "b.py": `f(model="gpt-4.1")` }, async (root) => {
    await chmod(path.join(root, "a.py"), 0o000);
    const result = await scanProject(root, snapshot());
    assert.deepEqual(result.findings.map((f) => f.model), ["gpt-4.1"]);
  });
});

test("precision corpus: real-shaped code yields only true uses", async () => {
  const files: Record<string, string> = {
    "src/llm.ts": [
      `import OpenAI from "openai";`,
      `import type { Model } from "gpt-4o";`,
      `const PRICE_PER_MTOK: Record<string, number> = { "gpt-4o": 2.5, "gpt-4.1": 2 };`,
      `export const SUPPORTED = new Set(["claude-sonnet-4-5"]);`,
      `// migrated from gpt-3.5-turbo`,
      `const css = "gpt-9-card";`,
      `const url = "https://platform.openai.com/docs/models/gpt-4o";`,
      `const file = "gpt-4o.json";`,
      `const msg = "Model gpt-4o is unavailable";`,
      `if (name.startsWith("gpt-4o")) throw new Error("no gpt-4o");`,
      `export async function ask(c: OpenAI) {`,
      `  return c.chat.completions.create({ model: "gpt-4o", messages: [] });`,
      `}`,
    ].join("\n"),
    "src/agent.py": [
      `"""Agent. Defaults to gpt-4o."""`,
      `import os`,
      `from anthropic import Anthropic`,
      `CONTEXT = {"gpt-4o": 128000, "claude-sonnet-4-5": 200000}`,
      `DEFAULT = os.getenv("AGENT_MODEL", "claude-sonnet-4-5")`,
      `def pick(name):`,
      `    if name == "gpt-4o":`,
      `        return None`,
      `    print("claude-sonnet-4-5")`,
      `    return Anthropic().messages.create(model=DEFAULT)`,
    ].join("\n"),
    "tests/test_agent.py": `def test_a():\n    run(model="gpt-4o")\n`,
    "config/app.yaml": `llm:\n  model: gemini-2.5-flash\nimage: gpt-4o\n`,
  };
  const expected = ["claude-sonnet-4-5", "gemini-2.5-flash", "gpt-4o"].sort();
  const result = await scanFiles(files);
  // SUPPORTED is a genuine list of supported models; everything else here is a lookalike.
  const reported = result.findings.map((f) => f.model).sort();
  assert.deepEqual([...new Set(reported)], expected);
  assert.equal(result.findings.length, 4);
});

test("scan does not write anything into the project", async () => {
  await withProject({ "a.py": `f(model="gpt-4o")` }, async (root) => {
    await mkdir(path.join(root, "empty"));
    await scanProject(root, snapshot());
    const { readdir } = await import("node:fs/promises");
    assert.deepEqual((await readdir(root)).sort(), ["a.py", "empty"]);
  });
});
