# Swapcheck

Know when the hosted LLM model you depend on is being retired, re-routed or repriced. Find what to move to. Then test the move on your own cases before you ship it.

Swapcheck is free and open source (Apache-2.0). It runs on your machine or in your CI. Your keys and prompts never go anywhere except the model provider you choose to test.

- **Scan:** finds the model IDs your code uses and checks each one against a signed public registry of model changes.
- **Watch:** fails CI when a model you use changes inside a window you set.
- **Find:** lists replacements that keep the features your code needs.
- **Test:** runs your cases on the current model and the candidates, measures noise, and only reports a drop that reproduces on fresh samples.
- **Bump:** edits the model ID in your source and opens a pull request.

## Quick start

```sh
npx @allthingsai/swapcheck
```

To keep it installed, run `npm install -g @allthingsai/swapcheck` and then use the `swapcheck` command. For Python, signed wheels for Linux, macOS (Apple silicon) and Windows are attached to each [release](https://github.com/allthingsN/swapcheck/releases/latest). They are not on PyPI yet.

Real output on a small app that calls Claude Sonnet 4.5 (registry of 2026-11-10):

```text
Scanned 1 file. Found 1 model.
Registry: 2026-11-10 (bundled)

  claude-sonnet-4-5-20250929  retires 2026-11-30, in 20 days; successor claude-sonnet-5-5
    app.py:7
    source: https://platform.claude.com/docs/en/about-claude/model-deprecations
    parameters changed 2026-10-21
    source: https://platform.claude.com/docs/en/about-claude/model-deprecations#api-parameter-deprecations

1 of 1 model has a change in the registry.
Wrote models.lock.
```

Scanning is free and needs no API key. It writes `models.lock`, which `swapcheck watch` checks later.

```sh
swapcheck find claude-sonnet-4-5-20250929
```

```text
Replacements for claude-sonnet-4-5-20250929
Needs: 50 tokens of output

  1  claude-sonnet-5-5             provider successor  $10.00/M output  -33%   2026-09-28
  2  claude-sonnet-4-6             same vendor         $15.00/M output  0%     2026-02-17
  ...
Listed by what the registry says. Prove one on your cases with: swapcheck test --to claude-sonnet-5-5
```

## Test a move on your cases

Put cases in `swapcheck/cases/*.json`, or start from `swapcheck cases init`, which drafts contract checks from your code. You can also import suites from ModelBump, Modelpin, OpenTelemetry, LiteLLM or Langfuse with `swapcheck cases import`.

```sh
export ANTHROPIC_API_KEY=...
swapcheck test --to claude-haiku-5-5,claude-sonnet-4-6 --runs 3 --max-usd 1
```

Before it spends anything, Swapcheck prints the worst-case cost and the vendors that will see your cases. Without `--yes` on a non-interactive shell it stops there. A real run on 8 support-ticket classification cases:

```text
Models: claude-haiku-4-5-20251001, claude-haiku-5-5, claude-sonnet-4-6
Cases: 8, 3 runs each
Maximum cost: $0.22, up to 504 calls
Vendors that will see your case content: anthropic
...
Noise: model against itself flagged 0 cases (false-change rate 0%).

  claude-haiku-5-5  No change detected
    No difference beyond the measured noise was detected on the 8 cases tested. This covers only those cases.
    pass rate      92% to 100%
    p50 latency    529 ms to 808 ms

  claude-sonnet-4-6  No change detected
    pass rate      92% to 88%
    p50 latency    529 ms to 925 ms

Spent $0.0074 of a $1.00 limit.
```

Verdicts are `NO_CHANGE_DETECTED`, `CHANGED`, `REGRESSED` and `NOT_ENOUGH_EVIDENCE`. A report never calls a model safe or better. It says what was measured and lists its limits.

### How the test decides

1. The current model runs twice as many times as each candidate, in two halves. Comparing the halves measures how much the model differs from itself.
2. Each case is compared with Fisher's exact test. The suite is compared with a paired permutation test and a bootstrap confidence interval.
3. A case that looks worse is re-run on fresh samples. It only counts as a regression if the drop reproduces, with a correction for the number of cases re-run.
4. Too many errors, a budget stop, or fewer than 6 usable cases gives `NOT_ENOUGH_EVIDENCE`, not a guess.

In simulation (`e2e/stats-calibration.test.ts`) false alarms stay between 0.5% and 2.2%, and seeded regressions are caught 93% to 100% of the time. A single case dropping by 0.6 in a 10-case suite is caught about 74% of the time. The full method is in [docs/DESIGN.md](docs/DESIGN.md).

## GitHub Action

```yaml
name: Model changes
on:
  schedule: [{ cron: "0 8 * * 1" }]
  pull_request:
permissions:
  contents: read
jobs:
  watch:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: allthingsN/swapcheck@v1
        with:
          mode: watch
          fail-within-days: 30
```

Modes are `watch`, `find`, `check` (spends money, needs `max-usd` and provider keys in `env`) and `bump` (opens one pull request per model with `open-prs: true` and `GITHUB_TOKEN` in `env`). Pull requests from forks only ever get the free scan. Paid modes refuse to run on `pull_request_target`, `workflow_run`, `issue_comment` and every other trigger outside `pull_request`, `push`, `schedule`, `workflow_dispatch`, `merge_group` and `release`.

## MCP server

Swapcheck speaks MCP over stdio, so coding agents can ask it what is changing:

```json
{ "mcpServers": { "swapcheck": { "command": "npx", "args": ["-y", "@allthingsai/swapcheck", "mcp"] } } }
```

The free tools (`scan`, `watch`, `find`, `explain_event`) are always on. The paid `test` tool only appears when you set `SWAPCHECK_MCP_ALLOW_SPEND=1`, and it can never spend more than your config budget or `SWAPCHECK_MCP_MAX_USD`, whatever the agent asks for.

## Python

Swapcheck is not on PyPI yet. Download the wheel for your platform from the [latest release](https://github.com/allthingsN/swapcheck/releases/latest) and install it:

```sh
pip install ./swapcheck-*.whl
```

```python
import swapcheck
result = swapcheck.scan(".")
```

The wheel ships the same compiled CLI and a thin wrapper over its JSON output.

## Providers

| Provider | Key | Notes |
| --- | --- | --- |
| OpenAI | `OPENAI_API_KEY` | `SWAPCHECK_OPENAI_BASE_URL` for any OpenAI-compatible endpoint |
| Anthropic | `ANTHROPIC_API_KEY` | `SWAPCHECK_ANTHROPIC_BASE_URL` for a gateway |
| Google Gemini | `GEMINI_API_KEY` or `GOOGLE_API_KEY` | `SWAPCHECK_GEMINI_BASE_URL` for a gateway |
| OpenRouter | `OPENROUTER_API_KEY` | Route `openrouter` |

Base URLs must be HTTPS, except on localhost. Redirects are never followed, so a key can't be carried to another host.

## The registry

Model dates, prices and capabilities come from [swapcheck-registry](https://github.com/allthingsN/swapcheck-registry), which parses 16 provider pages and catalogs every 6 hours. Each snapshot is signed with Ed25519. Swapcheck verifies the signature with a pinned key before it parses anything, refuses a snapshot older than one it already has, and falls back to the copy bundled with the release. Every event links to its source. Corrections are welcome there.

Change notices and open test workloads live in [swapcheck-reports](https://github.com/allthingsN/swapcheck-reports). Every post there is checked against its data and signed before it is published.

## What it does not do

- It only covers the cases you test. Behavior on anything else is not measured.
- API replay can't see changes in a consumer product or an agent harness around the model.
- The scanner reads JavaScript, TypeScript, Python and common config formats. It does not read shell scripts or other languages, and a model ID built at runtime is listed as unresolved rather than guessed.

## Security and privacy

No telemetry. The only network calls are the registry fetch, the providers you choose to test, and the GitHub API during `bump --open-pr`. Tool calls a model asks for are recorded and mocked, never run. See [SECURITY.md](SECURITY.md) for the full model and how to report a vulnerability.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Tests need no network and no keys: `npm ci && npm test && npm run e2e`.

## License

Code: Apache-2.0. Registry data: CC BY 4.0. Built by [All Things AI](https://allthingsn.com).
