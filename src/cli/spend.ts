import { createInterface } from "node:readline/promises";
import { EXIT } from "../types.ts";
import { SwapcheckError } from "../util/errors.ts";
import { usd } from "./output.ts";

export interface SpendGate {
  yes: boolean;
  isTty: boolean;
  /** Asks the question and returns the typed answer. Replaceable so tests need no terminal. */
  ask?: (question: string) => Promise<string>;
}

async function askOnTerminal(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    // Ctrl+D closes the prompt without an answer, which must count as no.
    return await new Promise<string>((resolve) => {
      rl.once("close", () => resolve(""));
      rl.question(question).then(resolve, () => resolve(""));
    });
  } finally {
    rl.close();
  }
}

/** The one place that decides whether money may be spent. */
export async function confirmSpend(maxUsd: number, gate: SpendGate): Promise<void> {
  if (gate.yes) return;
  if (!gate.isTty) {
    throw new SwapcheckError(`This would spend up to ${usd(maxUsd)}, and nothing has been spent. Re-run with --yes to agree.`);
  }
  const answer = await (gate.ask ?? askOnTerminal)(`Spend up to ${usd(maxUsd)}? [y/N] `);
  if (!/^y(es)?$/i.test(answer.trim())) {
    throw new SwapcheckError("Stopped before spending anything.", EXIT.USAGE);
  }
}
