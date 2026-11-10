# Contributing

Thank you for helping. Issues and pull requests are welcome.

## Setup

You need Node 22.14 or later.

```sh
npm ci
npm run check
npm run e2e
```

Tests need no network and no API keys. Provider behaviour is tested against a local emulator.

## Rules for changes

- The published package must keep zero runtime dependencies. `yaml` is bundled at build time.
- Never execute anything that comes from a case, prompt, model output, registry entry or scanned file.
- Every paid code path must go through the budget check.
- Add a test for each behaviour change, and a regression test for each bug.
- Reports say what was measured. They never call a model safe or better.

## Changes to model data

Model dates, prices and capabilities live in [swapcheck-registry](https://github.com/allthingsN/swapcheck-registry). Please open corrections there, with a source link.

## Sign-off

Commits need a [Developer Certificate of Origin](https://developercertificate.org/) sign-off. Use `git commit -s`. There is no CLA.

## Security issues

See [SECURITY.md](SECURITY.md). Please do not open public issues for vulnerabilities.
