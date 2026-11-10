import type { Check, TestCase } from "../../types.ts";
import { SwapcheckError } from "../../util/errors.ts";
import { asObject, normalizeMessages, str } from "./shared.ts";

function checksForOracle(oracle: Record<string, unknown> | undefined, id: string): Check[] | undefined {
  const kind = str(oracle?.kind);
  if (kind === "tools") return undefined;
  if (kind === "json") return [{ type: "json_valid" }];
  if (kind === "text") return [{ type: "no_refusal" }, { type: "meaning" }];
  if (kind === "label") {
    const labels = Array.isArray(oracle?.labels) ? oracle.labels.filter((label): label is string => typeof label === "string" && label !== "") : [];
    if (labels.length < 2) throw new SwapcheckError(`The ModelBump case ${id} has a label oracle with fewer than two labels.`);
    return [{ type: "label_in", labels }];
  }
  throw new SwapcheckError(`The ModelBump case ${id} has an oracle kind Swapcheck does not know: ${String(kind)}.`);
}

/** Reads a ModelBump suite file (version 1). Tool-call cases are not supported upstream, so they are skipped. */
export function parseModelbump(data: unknown, file: string): TestCase[] {
  const suite = asObject(data);
  if (!suite || suite.version !== 1 || !Array.isArray(suite.cases)) {
    throw new SwapcheckError(`${file} is not a version 1 ModelBump suite: expected an object with version 1 and a cases array.`);
  }
  const cases: TestCase[] = [];
  for (const raw of suite.cases) {
    const item = asObject(raw);
    const id = str(item?.id);
    if (!item || !id) throw new SwapcheckError(`${file} has a ModelBump case with no id.`);
    const checks = checksForOracle(asObject(item.oracle), id);
    if (!checks) continue;
    const messages = normalizeMessages(item.messages);
    if (messages.length === 0) throw new SwapcheckError(`The ModelBump case ${id} has no messages.`);
    const tags = ["modelbump"];
    if (item.generated_by) tags.push("generated-input");
    cases.push({ id: `modelbump:${id}`, origin: "imported", accepted: true, messages, checks, tags });
  }
  return cases;
}
