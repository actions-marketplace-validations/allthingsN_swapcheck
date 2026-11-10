import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { scanProgress } from "../../src/cli/output.ts";
import { refuseBroadFolder } from "../../src/cli/project.ts";

function tempDir(): string {
  return realpathSync(mkdtempSync(path.join(os.tmpdir(), "swapcheck-broad-")));
}

test("a home folder that is not a project is refused with a plain next step", async () => {
  const home = tempDir();
  try {
    await assert.rejects(refuseBroadFolder(home, home), (error: Error) => {
      assert.match(error.message, /is your home folder, not a project/);
      assert.match(error.message, /--cwd <folder>/);
      return true;
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a home folder kept under git or with a manifest is still scanned", async () => {
  for (const marker of [".git", "package.json", "swapcheck.yml"]) {
    const home = tempDir();
    try {
      if (marker === ".git") mkdirSync(path.join(home, marker));
      else writeFileSync(path.join(home, marker), "{}");
      await refuseBroadFolder(home, home);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
});

test("a project folder inside the home folder is never refused", async () => {
  const home = tempDir();
  try {
    const project = path.join(home, "code", "app");
    mkdirSync(project, { recursive: true });
    await refuseBroadFolder(project, home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the top of the disk is refused", async () => {
  const top = path.parse(process.cwd()).root;
  const hasMarker = [".git", "package.json"].some((name) => {
    try {
      return realpathSync(path.join(top, name)) !== "";
    } catch {
      return false;
    }
  });
  if (hasMarker) return;
  await assert.rejects(refuseBroadFolder(top, tempDir()), /is the top of the disk, not a project/);
});

test("scan progress stays silent off a terminal and for quick scans, and clears what it drew", async () => {
  const off: string[] = [];
  const offProgress = scanProgress(false, (text) => off.push(text));
  assert.equal(offProgress.onProgress, undefined);
  offProgress.done();
  assert.deepEqual(off, []);

  const quick: string[] = [];
  const quickProgress = scanProgress(true, (text) => quick.push(text));
  quickProgress.onProgress?.(10);
  quickProgress.done();
  assert.deepEqual(quick, [], "nothing is drawn in the first 1.5 seconds");

  const slow: string[] = [];
  const slowProgress = scanProgress(true, (text) => slow.push(text));
  await new Promise((resolve) => setTimeout(resolve, 1600));
  slowProgress.onProgress?.(12345);
  slowProgress.done();
  assert.equal(slow.length, 2);
  assert.match(slow[0] as string, /^\rScanning: 12,345 files read\. Press Ctrl\+C to stop\.$/);
  assert.equal(slow[1], "\r\x1b[K");
});
