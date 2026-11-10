"""Console script: hands straight over to the compiled binary."""

from __future__ import annotations

import os
import subprocess
import sys

from ._binary import binary_path


def main() -> int:
    binary = binary_path()
    args = sys.argv[1:]
    if sys.platform == "win32":
        return subprocess.run([binary, *args], check=False).returncode
    os.execv(binary, [binary, *args])
    return 0  # Unreachable: execv replaces this process.


if __name__ == "__main__":
    sys.exit(main())
