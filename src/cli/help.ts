const GLOBAL = `Global options:
  --format text|json|markdown|sarif   Output format (default text)
  --cwd <dir>                         Project folder (default: current folder)
  --config <file>                     Config file inside the project
  --registry-url <url>                Registry snapshot to use
  --offline                           Use the cached or bundled registry only
  --yes                               Agree to spending without being asked
  --no-color                          Plain output
  --debug                             Show stack traces on failure
  --help, --version`;

const PAID = `  --runs <n>                          Runs per case (default from config)
  --max-usd <amount>                  Hard spending limit (default from config)
  --judge <model>                     Model that grades "meaning" checks
  --route <route>                     Where the model is served, e.g. aws-bedrock
  --allow-unknown-prices              Run models the registry has no price for;
                                      the maximum cost is then your --max-usd`;

export const HELP: Record<string, string> = {
  root: `swapcheck: know when your LLM model is changing, and prove a move on your own cases.

Usage: swapcheck [command] [options]

Free:
  (no command), scan   Find models in this repo and show what is changing
  watch                Compare models.lock to the registry
  find <model>         Shortlist replacements
  cases init           Write contract checks and drafts from your code
  cases import         Import suites or traces, redacted
  cases accept         Accept generated drafts
  bump <m> --to <m>    Edit model IDs in code and config
  report <file>        Render a saved report
  mcp                  MCP server on stdio

Spends money, after showing the maximum cost and asking:
  baseline             Measure the current model and its noise
  test --to a,b        Compare candidates on your cases
  find <model> --test  Shortlist, then test it

${GLOBAL}

Exit codes: 0 fine; 1 regression or change inside the failure window;
2 config or usage; 3 could not measure.

Run swapcheck <command> --help for details.`,

  scan: `Usage: swapcheck [scan] [--no-lock]

Finds model IDs in code and config, shows which are changing with dates and
source links, and writes models.lock. Needs no keys or config. Spends nothing.

  --no-lock                           Do not write models.lock

${GLOBAL}`,

  watch: `Usage: swapcheck watch [--fail-within-days N]

Compares models.lock to the registry. Exits 1 when a change takes effect
inside the window. Spends nothing.

  --fail-within-days <n>              Window in days (default from config)

${GLOBAL}`,

  find: `Usage: swapcheck find <model> [--limit N] [--test]

Shortlists replacements that meet what your code needs. Spends nothing
unless you add --test.

  --limit <n>                         Candidates to show (default 5)
  --test                              Test the shortlist on your cases (spends)
${PAID}

${GLOBAL}`,

  cases: `Usage:
  swapcheck cases init
  swapcheck cases import <modelbump|modelpin|otel|litellm|langfuse> <path> [--allow-unredacted]
  swapcheck cases accept <id>... | --all

init writes contract checks and drafts from your code. import redacts traces
unless you pass --allow-unredacted. Generated drafts do not run until accepted.
Spends nothing.

  --allow-unredacted                  Keep trace text exactly as logged
  --all                               Accept every generated draft

${GLOBAL}`,

  baseline: `Usage: swapcheck baseline [--model <model>]

Runs your cases against the current model to measure it and its noise.
Spends money: shows the maximum cost and the vendors first, then asks.

  --model <model>                     Model to measure (default: the only one found)
${PAID}

${GLOBAL}`,

  test: `Usage: swapcheck test --to <model,model> [--from <model>]

Compares candidates with the current model on your cases.
Spends money: shows the maximum cost and the vendors first, then asks.

  --to <list>                         Comma-separated candidates
  --from <model>                      Current model (default: the only one found)
${PAID}

${GLOBAL}`,

  bump: `Usage: swapcheck bump <model> --to <model> [--open-pr] [--dry-run]

Edits the model ID in code and config at the exact positions the scan found,
removes parameters the target rejects, and updates models.lock. Never touches
comments, docs or price tables, and lists everything it skipped. Spends nothing.

  --to <model>                        Replacement model
  --dry-run                           Show the edits without writing
  --open-pr                           Open or update one pull request for this
                                      model. Needs GITHUB_TOKEN.
  --evidence <file>                   Saved report to attach to the pull request

${GLOBAL}`,

  report: `Usage: swapcheck report <file>

Renders a saved report as text, markdown, sarif or json. Exits with the code
the report's verdict implies. Spends nothing.

${GLOBAL}`,

  mcp: `Usage: swapcheck mcp

Runs an MCP server on stdio with the tools scan, watch, find and explain_event.
Tools that spend money appear only when SWAPCHECK_MCP_ALLOW_SPEND=1.

${GLOBAL}`,
};

export function helpFor(command: string | undefined): string {
  return HELP[command ?? "root"] ?? HELP.root ?? "";
}
