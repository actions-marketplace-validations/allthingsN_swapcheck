import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { SwapcheckError } from "./errors.ts";

/** Resolves `relative` under `root`, refusing traversal. Does not touch the filesystem. */
export function insideRoot(root: string, relative: string): string {
  const base = path.resolve(root);
  const target = path.resolve(base, relative);
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new SwapcheckError(`The path ${relative} is outside the project folder, so Swapcheck will not use it.`);
  }
  return target;
}

function isWithin(realBase: string, realTarget: string): boolean {
  return realTarget === realBase || realTarget.startsWith(realBase + path.sep);
}

/** True when an existing path, after following symlinks, is still inside `root`. */
export async function realInsideRoot(root: string, target: string): Promise<boolean> {
  const [realBase, realTarget] = await Promise.all([realpath(root), realpath(target)]);
  return isWithin(realBase, realTarget);
}

/** Windows searches the working directory for executables, so a repo must never be the cwd of a spawned tool. */
export function neutralCwd(): string {
  return path.dirname(process.execPath);
}

/** Walks down from the real root one folder at a time, so nothing is created before its parent is proven inside. */
async function ensureRealDir(realBase: string, segments: string[], shown: string): Promise<string> {
  let current = realBase;
  for (const segment of segments) {
    const next = path.join(current, segment);
    let info = await lstat(next).catch(() => null);
    if (!info) {
      await mkdir(next).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
      info = await lstat(next);
    }
    if (info.isSymbolicLink()) {
      const resolved = await realpath(next).catch(() => null);
      if (!resolved || !isWithin(realBase, resolved)) throw new SwapcheckError(`${shown} points outside the project, so Swapcheck will not write there.`);
      if (!(await stat(resolved)).isDirectory()) throw new SwapcheckError(`${shown} has a part that is not a folder, so Swapcheck will not write there.`);
      current = resolved;
    } else if (info.isDirectory()) {
      current = next;
    } else {
      throw new SwapcheckError(`${shown} has a part that is not a folder, so Swapcheck will not write there.`);
    }
  }
  return current;
}

/**
 * Writes a file under the project root. An exclusive temp file renamed over the target means a
 * planted symlink at a predictable name is never written through, and folders are created only
 * after the real path above them is checked.
 */
export async function writeInsideRoot(root: string, target: string, content: string | Uint8Array, options: { mode?: number } = {}): Promise<void> {
  const base = path.resolve(root);
  const relative = path.relative(base, insideRoot(base, path.resolve(target)));
  const shown = relative.split(path.sep).join("/");
  const parts = relative.split(path.sep);
  const name = parts.pop();
  if (!name) throw new SwapcheckError(`${shown || "The project folder"} is not a file, so Swapcheck will not write to it.`);
  const realBase = await realpath(base).catch(() => null);
  if (!realBase) throw new SwapcheckError(`The project folder ${base} does not exist.`);
  const directory = await ensureRealDir(realBase, parts, shown);
  const finalPath = path.join(directory, name);
  const existing = await lstat(finalPath).catch(() => null);
  if (existing?.isSymbolicLink()) throw new SwapcheckError(`${shown} is a symbolic link, so Swapcheck will not write to it. Replace it with a regular file.`);
  if (existing && !existing.isFile()) throw new SwapcheckError(`${shown} is not a regular file, so Swapcheck will not write to it.`);
  const temp = path.join(directory, `.swapcheck-${randomBytes(6).toString("hex")}.tmp`);
  const mode = existing ? existing.mode & 0o777 : (options.mode ?? 0o666);
  try {
    await writeFile(temp, content, { flag: "wx", mode });
    if (existing) await chmod(temp, mode);
    await rename(temp, finalPath);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}
