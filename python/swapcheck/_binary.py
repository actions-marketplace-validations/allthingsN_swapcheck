"""Finds the compiled swapcheck binary shipped inside the wheel."""

from __future__ import annotations

import os
import sys
from pathlib import Path


def binary_path() -> str:
    name = "swapcheck.exe" if sys.platform == "win32" else "swapcheck"
    path = Path(__file__).resolve().parent / "_bin" / name
    if not path.is_file():
        raise FileNotFoundError(
            "The swapcheck binary is missing from this install. "
            "Install a platform wheel with: pip install --force-reinstall swapcheck"
        )
    if sys.platform != "win32" and not os.access(path, os.X_OK):
        raise PermissionError(f"The swapcheck binary at {path} is not executable.")
    return str(path)
