# Security policy

Swapcheck handles API keys and reads source code, so we treat security reports as our top priority.

## Reporting a vulnerability

Please use [GitHub private vulnerability reporting](https://github.com/allthingsN/swapcheck/security/advisories/new). Do not open a public issue.

We aim to acknowledge reports within three working days and to tell you what we plan to do within ten. We are a very small team, so these are goals and not guarantees. We will credit you unless you prefer otherwise.

## Supported versions

Only the latest release receives security fixes.

## Security model

| Property | How it holds |
| --- | --- |
| Your keys stay with you | Keys are read from environment variables and sent only to the model provider you are testing. There is no Swapcheck service. |
| No telemetry | The only network calls are the registry fetch, model providers you chose, and the GitHub API during `bump --open-pr`. |
| Model-requested actions are never run | Tool calls are recorded and mocked. Swapcheck does not execute them. |
| Scanned code is never run | The scanner reads files as text with a hand-written lexer. |
| Registry data is authenticated | Snapshots are verified with a pinned Ed25519 key before parsing. A failed signature falls back to the snapshot bundled in the release. |
| Reports do not contain prompts by default | Reports store case hashes and scores. Including text is opt-in. |
| Output cannot inject into CI or PRs | Workflow commands, step summaries and Markdown from external text are escaped. |
| Forks cannot spend your money | Fork pull requests get the free scan only. Paid modes run only on `pull_request`, `push`, `schedule`, `workflow_dispatch`, `merge_group` and `release`, and refuse every other trigger, including `pull_request_target`, `workflow_run` and `issue_comment`. |
| Releases are traceable | The npm package is published with provenance, and every release file has a GitHub build attestation. Python wheels are attached to GitHub releases and are not on PyPI yet; when they are, PyPI will use OIDC trusted publishing. npm allows trusted publishing only on an existing package, so the first npm release uses a short-lived token that is deleted afterwards. Releases run from `v*` tags in a `release` environment that needs a maintainer's approval. |
| Small supply chain | The published npm package has zero runtime dependencies. |

## What Swapcheck does not protect against

- Prompts and cases are sent to the providers you test. Each run lists those vendors first, and your policy file can restrict them.
- A malicious dependency or compromised machine in your own environment can read your keys.
- Redaction of imported traces uses patterns and can miss sensitive data. Review imported cases before committing them.
