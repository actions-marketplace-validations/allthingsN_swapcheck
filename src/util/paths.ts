import { realpath } from "node:fs/promises";
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

/** True when an existing path, after following symlinks, is still inside `root`. */
export async function realInsideRoot(root: string, target: string): Promise<boolean> {
  const [realBase, realTarget] = await Promise.all([realpath(root), realpath(target)]);
  return realTarget === realBase || realTarget.startsWith(realBase + path.sep);
}
