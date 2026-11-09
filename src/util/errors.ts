import { EXIT } from "../types.ts";

/** An expected failure. The message is shown to the user as written. */
export class SwapcheckError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode: number = EXIT.USAGE) {
    super(message);
    this.name = "SwapcheckError";
    this.exitCode = exitCode;
  }
}
