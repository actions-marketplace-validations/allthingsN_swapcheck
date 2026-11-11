"""Thin Python API over the swapcheck binary's ``--format json`` output."""

from __future__ import annotations

import json
import subprocess
from typing import Any, Mapping, Optional, Sequence

from ._binary import binary_path

__version__ = "0.1.5"
__all__ = ["SwapcheckError", "find", "scan", "test", "watch"]

_EXIT_FINDINGS = 1
_DEFAULT_TIMEOUT_SECONDS = 3600


class SwapcheckError(RuntimeError):
    """The command could not do what was asked. ``exit_code`` is 2 for usage and 3 for not measured."""

    def __init__(self, message: str, exit_code: int) -> None:
        super().__init__(message)
        self.exit_code = exit_code


def _run(
    args: list,
    *,
    path: Optional[str],
    registry_url: Optional[str],
    offline: bool,
    env: Optional[Mapping[str, str]],
    timeout: Optional[float],
) -> Any:
    # Global options go first so a model name after "--" can never be read as one.
    command = [binary_path(), "--format", "json"]
    if path is not None:
        command += ["--cwd", str(path)]
    if registry_url is not None:
        command += ["--registry-url", registry_url]
    if offline:
        command.append("--offline")
    command += args
    completed = subprocess.run(
        command,
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=False,
        timeout=timeout,
        env=dict(env) if env is not None else None,
        stdin=subprocess.DEVNULL,
    )
    # Exit 1 is a finding, not a failure: the JSON on stdout carries the result.
    if completed.returncode not in (0, _EXIT_FINDINGS):
        message = completed.stderr.strip() or f"swapcheck exited with code {completed.returncode}."
        raise SwapcheckError(message, completed.returncode)
    try:
        return json.loads(completed.stdout)
    except json.JSONDecodeError as error:
        raise SwapcheckError(f"swapcheck did not return JSON: {error}", 3) from error


def scan(
    path: str = ".",
    *,
    no_lock: bool = False,
    registry_url: Optional[str] = None,
    offline: bool = False,
    env: Optional[Mapping[str, str]] = None,
    timeout: Optional[float] = 120,
) -> Any:
    """Find models in the project and report exposure. Spends nothing."""
    args = ["scan"] + (["--no-lock"] if no_lock else [])
    return _run(args, path=path, registry_url=registry_url, offline=offline, env=env, timeout=timeout)


def watch(
    path: str = ".",
    *,
    fail_within_days: Optional[int] = None,
    registry_url: Optional[str] = None,
    offline: bool = False,
    env: Optional[Mapping[str, str]] = None,
    timeout: Optional[float] = 120,
) -> Any:
    """Compare models.lock to the registry. Spends nothing."""
    args = ["watch"]
    if fail_within_days is not None:
        args += ["--fail-within-days", str(int(fail_within_days))]
    return _run(args, path=path, registry_url=registry_url, offline=offline, env=env, timeout=timeout)


def find(
    model: str,
    *,
    path: str = ".",
    limit: Optional[int] = None,
    registry_url: Optional[str] = None,
    offline: bool = False,
    env: Optional[Mapping[str, str]] = None,
    timeout: Optional[float] = 120,
) -> Any:
    """Shortlist replacements for ``model``. Spends nothing."""
    args = ["find"]
    if limit is not None:
        args += ["--limit", str(int(limit))]
    args += ["--", model]
    return _run(args, path=path, registry_url=registry_url, offline=offline, env=env, timeout=timeout)


def test(
    to: Sequence[str],
    *,
    path: str = ".",
    from_model: Optional[str] = None,
    runs: Optional[int] = None,
    max_usd: Optional[float] = None,
    yes: bool = False,
    registry_url: Optional[str] = None,
    offline: bool = False,
    env: Optional[Mapping[str, str]] = None,
    timeout: Optional[float] = _DEFAULT_TIMEOUT_SECONDS,
) -> Any:
    """Compare candidates on your cases. Spends money, so it needs ``yes=True``."""
    if isinstance(to, str):
        to = [to]
    args = ["test", "--to", ",".join(to)]
    if from_model is not None:
        args += ["--from", from_model]
    if runs is not None:
        args += ["--runs", str(int(runs))]
    if max_usd is not None:
        args += ["--max-usd", str(max_usd)]
    if yes:
        args.append("--yes")
    return _run(args, path=path, registry_url=registry_url, offline=offline, env=env, timeout=timeout)
