#!/usr/bin/env bash
# Builds the wheel for this machine, installs it in a clean venv, and exercises the API and the
# console script. Needs bun, python3 and a prior `node build.mjs`. Deletes everything it builds.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work="$(mktemp -d "${TMPDIR:-/tmp}/swapcheck-python.XXXXXX")"
trap 'rm -rf "$work"' EXIT

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) target=macos-arm64 ;;
  Linux-x86_64) target=linux-x64 ;;
  Linux-aarch64) target=linux-arm64 ;;
  *) echo "No wheel target for this machine." >&2; exit 1 ;;
esac

[[ -f "$repo/dist/cli.mjs" ]] || node "$repo/build.mjs"
python3 "$repo/python/build_wheels.py" --target "$target" --output "$work/wheels"

python3 -m venv "$work/venv"
"$work/venv/bin/python" -m pip install --quiet --no-index "$work"/wheels/*.whl

export HOME="$work/home" XDG_CACHE_HOME="$work/home/.cache"
mkdir -p "$HOME" "$work/project/src"

model="$(python3 -c '
import json, sys
snapshot = json.load(open(sys.argv[1]))
print(next(e["model"] for e in snapshot["events"] if e["type"] == "retirement" and e.get("to") and e["route"] == "openai-api" and e["model"].startswith("gpt-")))
' "$repo/data/registry.snapshot.json")"

cat > "$work/project/src/llm.ts" <<TS
import OpenAI from "openai";
const client = new OpenAI();
export const reply = await client.chat.completions.create({ model: "$model", messages: [] });
TS

"$work/venv/bin/python" -I - "$work"/wheels/*.whl <<'PY'
import stat, sys, zipfile
wheel = sys.argv[1]
name = wheel.rsplit("/", 1)[-1]
assert "-py3-none-" in name, name
with zipfile.ZipFile(wheel) as z:
    names = z.namelist()
    binary = next(n for n in names if n.startswith("swapcheck/_bin/"))
    mode = z.getinfo(binary).external_attr >> 16
    assert stat.S_ISREG(mode) and mode & 0o111 == 0o111, oct(mode)
    record = next(n for n in names if n.endswith(".dist-info/RECORD"))
    assert binary in z.read(record).decode()
    wheel_meta = z.read(next(n for n in names if n.endswith(".dist-info/WHEEL"))).decode()
    assert "Root-Is-Purelib: false" in wheel_meta and "Tag: py3-none-" in wheel_meta
print("wheel layout ok:", name)
PY

version="$("$work/venv/bin/swapcheck" --version)"
expected="$(node -p "require('$repo/package.json').version")"
[[ "$version" == "$expected" ]] || { echo "binary reports $version, package says $expected" >&2; exit 1; }

"$work/venv/bin/swapcheck" --cwd "$work/project" --offline --no-lock | grep -q "$model"

code=0
"$work/venv/bin/swapcheck" nonsense 2>/dev/null || code=$?
[[ "$code" == "2" ]] || { echo "usage error exited $code" >&2; exit 1; }

cd "$work"
SWAPCHECK_MODEL="$model" SWAPCHECK_PROJECT="$work/project" "$work/venv/bin/python" -I - <<'PY'
import os
import swapcheck

model = os.environ["SWAPCHECK_MODEL"]
project = os.environ["SWAPCHECK_PROJECT"]

result = swapcheck.scan(project, offline=True)
assert result["schema"] == "swapcheck.scan/v1"
assert any(item["model"] == model for item in result["items"])
assert os.path.exists(os.path.join(project, "models.lock"))

watched = swapcheck.watch(project, fail_within_days=3650, offline=True)
assert watched["schema"] == "swapcheck.watch/v1"

found = swapcheck.find(model, path=project, limit=2, offline=True)
assert found["model"] == model and len(found["shortlist"]) <= 2

try:
    swapcheck.test(["some-model"], path=project, from_model=model, offline=True)
except swapcheck.SwapcheckError as error:
    assert error.exit_code == 2, error.exit_code
else:
    raise AssertionError("test() ran without yes=True or cases")

try:
    swapcheck.find("--not-a-flag", path="/nonexistent-folder", offline=True)
except swapcheck.SwapcheckError as error:
    assert error.exit_code == 2 and "does not exist" in str(error)
else:
    raise AssertionError("a bad folder should raise")
print("python api ok")
PY
echo "python e2e passed"
