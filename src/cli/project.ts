import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../config.ts";
import { loadRegistry, type LoadedRegistry } from "../registry/client.ts";
import type { SwapcheckConfig } from "../types.ts";
import { SwapcheckError } from "../util/errors.ts";
import { insideRoot, realInsideRoot } from "../util/paths.ts";

export interface Project {
  root: string;
  config: SwapcheckConfig;
  registry: LoadedRegistry;
}

export interface OpenOptions {
  cwd?: string;
  configPath?: string;
  registryUrl?: string;
  offline?: boolean;
  /** Give up on the network after this long and use the bundled snapshot. */
  registryDeadlineMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Test seam: use this registry instead of loading one. */
  registry?: LoadedRegistry;
}

function withDeadline(ms: number): typeof fetch {
  return (input, init) => {
    const deadline = AbortSignal.timeout(ms);
    const signal = init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
    return fetch(input, { ...init, signal });
  };
}

export async function resolveRoot(cwd: string | undefined): Promise<string> {
  const root = path.resolve(cwd ?? process.cwd());
  const info = await stat(root).catch(() => null);
  if (!info?.isDirectory()) throw new SwapcheckError(`The project folder ${root} does not exist. Check --cwd.`);
  return realpath(root);
}

/** Resolves a user-supplied file, refusing anything outside the project, including through symlinks. */
export async function resolveInsideProject(root: string, relative: string): Promise<string> {
  const target = insideRoot(root, relative);
  const info = await stat(target).catch(() => null);
  if (!info) throw new SwapcheckError(`The file ${relative} does not exist.`);
  if (!(await realInsideRoot(root, target))) {
    throw new SwapcheckError(`The path ${relative} leads outside the project folder through a symlink, so Swapcheck will not use it.`);
  }
  return target;
}

export async function openProject(options: OpenOptions): Promise<Project> {
  const env = options.env ?? process.env;
  const root = await resolveRoot(options.cwd);
  const configPath = options.configPath ? await resolveInsideProject(root, options.configPath) : undefined;
  const config = await loadConfig(root, configPath ? path.relative(root, configPath) : undefined);
  const url = options.registryUrl ?? env.SWAPCHECK_REGISTRY_URL;
  // An explicit registry URL means the user wants that data, so only the default fetch gets the short leash.
  const fetchImpl = !url && options.registryDeadlineMs ? withDeadline(options.registryDeadlineMs) : undefined;
  const registry = options.registry ?? (await loadRegistry({ url, offline: options.offline, fetchImpl }));
  return { root, config, registry };
}
