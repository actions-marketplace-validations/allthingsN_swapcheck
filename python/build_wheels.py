#!/usr/bin/env python3
"""Builds platform wheels holding a `bun build --compile` binary.

Needs dist/cli.mjs (run `node build.mjs` first) and bun on PATH. Standard library only,
because a wheel is a zip with a known layout and no build backend knows how to tag a
foreign binary.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import re
import stat
import subprocess
import sys
import tempfile
import zipfile
from dataclasses import dataclass
from pathlib import Path

try:
    import tomllib
except ModuleNotFoundError:  # Python < 3.11
    sys.exit("build_wheels.py needs Python 3.11 or newer.")

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
PACKAGE = HERE / "swapcheck"
# A fixed timestamp keeps wheels reproducible.
ZIP_TIME = (2020, 1, 1, 0, 0, 0)


@dataclass(frozen=True)
class Target:
    name: str
    bun_target: str
    wheel_tag: str
    binary: str


# Tags reflect Bun's documented minimums: glibc 2.27+ on Linux (rounded up to the next
# manylinux baseline with broad runner coverage) and macOS 13 on arm64.
TARGETS = {
    "linux-x64": Target("linux-x64", "bun-linux-x64", "manylinux_2_28_x86_64", "swapcheck"),
    "linux-arm64": Target("linux-arm64", "bun-linux-arm64", "manylinux_2_28_aarch64", "swapcheck"),
    "macos-arm64": Target("macos-arm64", "bun-darwin-arm64", "macosx_13_0_arm64", "swapcheck"),
    "windows-x64": Target("windows-x64", "bun-windows-x64", "win_amd64", "swapcheck.exe"),
}


def read_project() -> dict:
    return tomllib.loads((HERE / "pyproject.toml").read_text(encoding="utf-8"))["project"]


def check_versions(project: dict) -> str:
    version = project["version"]
    node = json.loads((REPO / "package.json").read_text(encoding="utf-8"))["version"]
    if version != node:
        sys.exit(f"python/pyproject.toml says {version} but package.json says {node}. Make them match.")
    init = (PACKAGE / "__init__.py").read_text(encoding="utf-8")
    declared = re.search(r'__version__ = "([^"]+)"', init)
    if not declared or declared.group(1) != version:
        sys.exit(f"python/swapcheck/__init__.py does not declare version {version}.")
    return version


def compile_binary(target: Target, output: Path) -> None:
    entry = REPO / "dist" / "cli.mjs"
    if not entry.is_file():
        sys.exit("dist/cli.mjs is missing. Run `node build.mjs` first.")
    subprocess.run(
        ["bun", "build", "--compile", f"--target={target.bun_target}", str(entry), "--outfile", str(output)],
        check=True,
    )


def metadata(project: dict) -> str:
    urls = "".join(f"Project-URL: {key}, {value}\n" for key, value in project.get("urls", {}).items())
    classifiers = "".join(f"Classifier: {value}\n" for value in project.get("classifiers", []))
    readme = (HERE / project["readme"]).read_text(encoding="utf-8")
    return (
        "Metadata-Version: 2.4\n"
        f"Name: {project['name']}\n"
        f"Version: {project['version']}\n"
        f"Summary: {project['description']}\n"
        f"License-Expression: {project['license']}\n"
        f"Requires-Python: {project['requires-python']}\n"
        f"{urls}{classifiers}"
        "Description-Content-Type: text/markdown\n\n"
        f"{readme}"
    )


def digest(data: bytes) -> str:
    encoded = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode()
    return f"sha256={encoded}"


class WheelWriter:
    def __init__(self, path: Path) -> None:
        self.zip = zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED)
        self.records: list[tuple[str, str, int]] = []

    def add(self, name: str, data: bytes, mode: int = 0o644) -> None:
        info = zipfile.ZipInfo(name, date_time=ZIP_TIME)
        info.compress_type = zipfile.ZIP_DEFLATED
        info.create_system = 3  # Unix, so external_attr carries POSIX permissions.
        info.external_attr = (stat.S_IFREG | mode) << 16
        self.zip.writestr(info, data)
        self.records.append((name, digest(data), len(data)))

    def finish(self, record_name: str) -> None:
        lines = [f"{name},{sha},{size}" for name, sha, size in self.records]
        lines.append(f"{record_name},,")
        info = zipfile.ZipInfo(record_name, date_time=ZIP_TIME)
        info.create_system = 3
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = (stat.S_IFREG | 0o644) << 16
        self.zip.writestr(info, "\n".join(lines) + "\n")
        self.zip.close()


def build_wheel(target: Target, project: dict, version: str, output_dir: Path, binary: Path) -> Path:
    name = project["name"]
    tag = f"py3-none-{target.wheel_tag}"
    wheel = output_dir / f"{name}-{version}-{tag}.whl"
    dist_info = f"{name}-{version}.dist-info"
    writer = WheelWriter(wheel)
    for source in sorted(PACKAGE.iterdir()):
        if source.is_file() and source.suffix in {".py", ".typed"}:
            writer.add(f"swapcheck/{source.name}", source.read_bytes())
    writer.add(f"swapcheck/_bin/{target.binary}", binary.read_bytes(), 0o755)
    writer.add(f"{dist_info}/METADATA", metadata(project).encode())
    wheel_file = f"Wheel-Version: 1.0\nGenerator: swapcheck-build-wheels\nRoot-Is-Purelib: false\nTag: {tag}\n"
    writer.add(f"{dist_info}/WHEEL", wheel_file.encode())
    scripts = "".join(f"{key} = {value}\n" for key, value in project["scripts"].items())
    writer.add(f"{dist_info}/entry_points.txt", f"[console_scripts]\n{scripts}".encode())
    writer.add(f"{dist_info}/licenses/LICENSE", license_text())
    writer.finish(f"{dist_info}/RECORD")
    return wheel


def license_text() -> bytes:
    path = REPO / "LICENSE"
    return path.read_bytes() if path.is_file() else b"Apache-2.0\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", action="append", choices=[*TARGETS, "all"], required=True)
    parser.add_argument("--output", type=Path, default=HERE / "dist")
    args = parser.parse_args()

    project = read_project()
    version = check_versions(project)
    names = list(TARGETS) if "all" in args.target else args.target
    args.output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="swapcheck-wheel-") as temp:
        for name in names:
            target = TARGETS[name]
            binary = Path(temp) / target.binary
            compile_binary(target, binary)
            print(build_wheel(target, project, version, args.output, binary))
            binary.unlink()
    return 0


if __name__ == "__main__":
    sys.exit(main())
