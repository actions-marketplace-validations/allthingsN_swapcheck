import { EXIT } from "../types.ts";
import { SwapcheckError } from "../util/errors.ts";
import { redactSecrets } from "../util/redact.ts";
import { VERSION } from "../version.ts";
import { boolFlag, parseArgs, type ParsedArgs } from "./args.ts";
import { printHelp, runBaseline, runBump, runCases, runFind, runReport, runScan, runTest, runWatch, type Env } from "./commands.ts";
import { clean, emit, note, stylerFor, wantsColor } from "./output.ts";
import { runMcpCommand } from "../mcp/server.ts";

const HANDLERS: Record<string, (context: Env) => Promise<number>> = {
  scan: runScan,
  watch: runWatch,
  find: runFind,
  cases: runCases,
  baseline: runBaseline,
  test: runTest,
  bump: runBump,
  report: runReport,
};

async function dispatch(args: ParsedArgs): Promise<number> {
  if (boolFlag(args, "version")) {
    emit(VERSION);
    return EXIT.OK;
  }
  if (args.command === "help") {
    printHelp(args.positionals[0]);
    return EXIT.OK;
  }
  if (boolFlag(args, "help")) {
    printHelp(process.argv.slice(2).some((token) => token === args.command) ? args.command : undefined);
    return EXIT.OK;
  }
  if (args.command === "mcp") return runMcpCommand(args);
  const handler = HANDLERS[args.command];
  if (!handler) throw new SwapcheckError(`${args.command} is not a Swapcheck command. Run swapcheck --help.`);
  const color = wantsColor(process.stdout, process.env, boolFlag(args, "no-color"));
  return handler({ args, style: stylerFor(color), isTty: Boolean(process.stdin.isTTY && process.stderr.isTTY), env: process.env });
}

function reportFailure(error: unknown, debug: boolean): number {
  if (error instanceof SwapcheckError) {
    note(clean(redactSecrets(error.message), 2000));
    if (debug && error.stack) note(redactSecrets(error.stack));
    return error.exitCode;
  }
  const message = error instanceof Error ? error.message : String(error);
  note(clean(redactSecrets(`Swapcheck stopped unexpectedly: ${message}. Run again with --debug for details.`), 2000));
  if (debug && error instanceof Error && error.stack) note(redactSecrets(error.stack));
  return EXIT.UNMEASURED;
}

export async function main(argv: string[]): Promise<number> {
  const debug = argv.includes("--debug");
  try {
    return await dispatch(parseArgs(argv));
  } catch (error) {
    return reportFailure(error, debug);
  }
}

// A reader that closes early (head, less) is not a failure worth reporting.
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") process.exit(EXIT.OK);
  throw error;
});

process.exitCode = await main(process.argv.slice(2));
