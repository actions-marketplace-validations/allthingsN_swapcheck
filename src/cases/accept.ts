import path from "node:path";
import { SwapcheckError } from "../util/errors.ts";
import { caseFiles, readCaseFile, saveCases } from "./load.ts";

/** Marks generated drafts as accepted. Unknown ids are refused so a typo is not silently ignored. */
export async function acceptCases(root: string, dir: string, ids: string[] | "all"): Promise<number> {
  const { files } = await caseFiles(root, dir);
  const wanted = ids === "all" ? null : new Set(ids);
  const found = new Set<string>();
  let changed = 0;
  for (const file of files) {
    const cases = await readCaseFile(root, file);
    let dirty = false;
    for (const testCase of cases) {
      if (wanted && !wanted.has(testCase.id)) continue;
      found.add(testCase.id);
      if (!testCase.accepted) {
        testCase.accepted = true;
        changed++;
        dirty = true;
      }
    }
    if (dirty) await saveCases(root, dir, path.basename(file), cases);
  }
  if (wanted) {
    const missing = [...wanted].filter((id) => !found.has(id));
    if (missing.length > 0) throw new SwapcheckError(`No case has the id ${missing.join(", ")}. Check the ids in ${dir}.`);
  }
  return changed;
}
