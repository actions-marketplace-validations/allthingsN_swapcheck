# Swapcheck for Python

Know when your hosted LLM model is changing, find what to move to, and prove the move on your own cases.

```
pip install swapcheck
swapcheck
```

From Python:

```python
import swapcheck

exposure = swapcheck.scan(".")
changes = swapcheck.watch(".", fail_within_days=30)
options = swapcheck.find("gpt-4o", path=".")
report = swapcheck.test(["gpt-5"], path=".", from_model="gpt-4o", max_usd=5, yes=True)
```

Each function returns the JSON the `swapcheck` command prints with `--format json`. `test` spends money and sends your cases to the model vendors, so it refuses to run without `yes=True`.

Wheels hold a compiled binary for Linux x64, Linux arm64, macOS arm64 and Windows x64. Source: https://github.com/allthingsN/swapcheck
