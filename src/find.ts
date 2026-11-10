import type { FindResult, ModelCapabilities, PolicyConfig, RegistryEvent, RegistryModel, RegistrySnapshot, Requirements, ShortlistEntry } from "./types.ts";
import { firstPartyRouteFor, vendorOfId } from "./scan/ids.ts";
import { daysUntil } from "./watch.ts";

const DEFAULT_LIMIT = 5;
const RETIREMENT_HORIZON_DAYS = 90;
const OTHER_VENDOR_SLOTS = 2;

function vendorFor(row: RegistryModel): string {
  return vendorOfId(row.id) ?? row.provider;
}

const REQUIRED_CAPABILITIES: Array<{ need: keyof Requirements; has: keyof ModelCapabilities; label: string }> = [
  { need: "tools", has: "tools", label: "tool calling" },
  { need: "structured_output", has: "structured_output", label: "structured output" },
  { need: "vision", has: "vision", label: "image input" },
  { need: "audio", has: "audio", label: "audio input" },
  { need: "pdf", has: "pdf", label: "PDF input" },
];

function missingCapability(row: RegistryModel, reqs: Requirements): string | null {
  for (const { need, has, label } of REQUIRED_CAPABILITIES) {
    if (reqs[need] && !row.capabilities[has]) return `does not support ${label}, which this code uses`;
  }
  return null;
}

function retiringSoon(row: RegistryModel, events: RegistryEvent[], now: Date): string | null {
  for (const event of events) {
    if (event.model !== row.id || event.route !== row.route) continue;
    if (event.type !== "retirement" && event.type !== "reroute") continue;
    if (event.effective === undefined) return `has an announced ${event.type} with no date yet`;
    const days = daysUntil(event.effective, now);
    if (days !== null && days <= RETIREMENT_HORIZON_DAYS) return days < 0 ? `was already subject to a ${event.type} on ${event.effective}` : `has a ${event.type} on ${event.effective}, within ${RETIREMENT_HORIZON_DAYS} days`;
  }
  return null;
}

function includesFolded(list: string[], value: string): boolean {
  const lowered = value.toLowerCase();
  return list.some((item) => item.toLowerCase() === lowered);
}

function policyRejection(row: RegistryModel, policy: PolicyConfig): string | null {
  if (policy.providers && !includesFolded(policy.providers, row.provider) && !includesFolded(policy.providers, vendorFor(row))) {
    return `provider ${row.provider} is not allowed by policy`;
  }
  if (policy.regions) {
    const regions = row.region ?? [];
    if (regions.length === 0) return "its regions are unknown, and policy restricts regions";
    if (!regions.some((region) => includesFolded(policy.regions as string[], region))) return "it is not offered in a region allowed by policy";
  }
  if (policy.licenses) {
    if (row.license === undefined) return "its license is unknown, and policy restricts licenses";
    if (!includesFolded(policy.licenses, row.license)) return `license ${row.license} is not allowed by policy`;
  }
  if (policy.max_usd_per_million_output !== undefined && row.cost.output > policy.max_usd_per_million_output) {
    return `output price $${row.cost.output} per million is above the policy limit of $${policy.max_usd_per_million_output}`;
  }
  return null;
}

function rejectionReason(row: RegistryModel, reqs: Requirements, events: RegistryEvent[], policy: PolicyConfig, now: Date): string | null {
  if (row.status === "retired" || row.status === "deprecated") return `its status is ${row.status}`;
  const capability = missingCapability(row, reqs);
  if (capability) return capability;
  if (row.limit.context < reqs.min_context) return `context of ${row.limit.context} tokens is below the required ${reqs.min_context}`;
  if (row.limit.output < reqs.min_output) return `maximum output of ${row.limit.output} tokens is below the required ${reqs.min_output}`;
  return retiringSoon(row, events, now) ?? policyRejection(row, policy);
}

function releaseValue(row: RegistryModel): number {
  if (!row.release_date) return 0;
  const parsed = Date.parse(row.release_date.length === 7 ? `${row.release_date}-01` : row.release_date.length === 4 ? `${row.release_date}-01-01` : row.release_date);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function byId(a: RegistryModel, b: RegistryModel): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Newest first, then cheapest. Capabilities play no part: a flag can only remove a model. */
function byRank(a: RegistryModel, b: RegistryModel): number {
  return releaseValue(b) - releaseValue(a) || a.cost.output - b.cost.output || byId(a, b);
}

function namedSuccessor(model: string, route: string | undefined, events: RegistryEvent[]): string | undefined {
  const named = events.filter((event) => event.model === model && event.to !== undefined && event.successor_basis === "provider_named");
  return (named.find((event) => event.route === route) ?? named[0])?.to;
}

function routePreference(row: RegistryModel, route: string | undefined): number {
  if (route !== undefined && row.route === route) return 0;
  return row.route === firstPartyRouteFor(vendorFor(row)) ? 1 : 2;
}

/** Keeps one row per model ID so the shortlist offers distinct models, not distinct routes. */
function chooseRoutes(rows: RegistryModel[], route: string | undefined, rejected: FindResult["rejected"]): RegistryModel[] {
  const best = new Map<string, RegistryModel>();
  for (const row of rows) {
    const current = best.get(row.id);
    if (!current) {
      best.set(row.id, row);
      continue;
    }
    const swap = routePreference(row, route) - routePreference(current, route) || (row.route < current.route ? -1 : 1);
    const [keep, drop] = swap < 0 ? [row, current] : [current, row];
    best.set(row.id, keep);
    rejected.push({ model: drop.id, reason: `the ${drop.route} route was not chosen; ${keep.route} is preferred for this model` });
  }
  return [...best.values()];
}

/** Same family first, then the nearest price, which approximates the same capability tier. */
function closestSameVendor(pool: RegistryModel[], current: RegistryModel | undefined): RegistryModel | undefined {
  if (!current) return pool[0];
  const distance = (row: RegistryModel): number => {
    if (row.cost.output <= 0 || current.cost.output <= 0) return Number.POSITIVE_INFINITY;
    return Math.abs(Math.log(row.cost.output / current.cost.output));
  };
  const familyMatch = (row: RegistryModel): number => (current.family !== undefined && row.family === current.family ? 0 : 1);
  return [...pool].sort((a, b) => familyMatch(a) - familyMatch(b) || distance(a) - distance(b) || byRank(a, b))[0];
}

function cheapest(pool: RegistryModel[]): RegistryModel | undefined {
  const compare = (a: RegistryModel, b: RegistryModel): number => a.cost.output - b.cost.output || a.cost.input - b.cost.input || byRank(a, b);
  // A price of zero usually means the catalog has no price, so it should not win "cheapest".
  const priced = pool.filter((row) => row.cost.output > 0);
  return [...(priced.length > 0 ? priced : pool)].sort(compare)[0];
}

function toEntry(row: RegistryModel, reason: ShortlistEntry["reason"], current: RegistryModel | undefined): ShortlistEntry {
  const entry: ShortlistEntry = {
    model: row.id,
    provider: row.provider,
    route: row.route,
    reason,
    estimated_usd_per_million_output: row.cost.output,
    estimated_cost_change: current && current.cost.output > 0 ? row.cost.output / current.cost.output - 1 : null,
    capabilities: row.capabilities,
    source: row.source,
  };
  if (row.release_date !== undefined) entry.release_date = row.release_date;
  return entry;
}

interface Selection {
  chosen: ShortlistEntry[];
  taken: Set<string>;
}

function take(selection: Selection, row: RegistryModel | undefined, reason: ShortlistEntry["reason"], current: RegistryModel | undefined, limit: number): void {
  if (!row || selection.chosen.length >= limit || selection.taken.has(row.id)) return;
  selection.taken.add(row.id);
  selection.chosen.push(toEntry(row, reason, current));
}

export function findReplacements(model: string, reqs: Requirements, snapshot: RegistrySnapshot, policy: PolicyConfig, opts: { limit?: number; now?: Date; route?: string } = {}): FindResult {
  const now = opts.now ?? new Date();
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const current = snapshot.models.find((row) => row.id === model && (opts.route === undefined || row.route === opts.route)) ?? snapshot.models.find((row) => row.id === model);
  const preferredRoute = opts.route ?? current?.route;
  const vendor = current ? vendorFor(current) : vendorOfId(model);
  const rejected: FindResult["rejected"] = [];

  const qualifying: RegistryModel[] = [];
  for (const row of snapshot.models) {
    if (row.id === model) continue;
    const reason = rejectionReason(row, reqs, snapshot.events, policy, now);
    if (reason) rejected.push({ model: row.id, reason: `${row.route}: ${reason}` });
    else qualifying.push(row);
  }

  const pool = chooseRoutes(qualifying, preferredRoute, rejected).sort(byRank);
  const successorId = namedSuccessor(model, preferredRoute, snapshot.events);
  const selection: Selection = { chosen: [], taken: new Set() };
  const open = (): RegistryModel[] => pool.filter((row) => !selection.taken.has(row.id));

  take(selection, pool.find((row) => row.id === successorId), "provider_successor", current, limit);
  take(selection, closestSameVendor(open().filter((row) => vendorFor(row) === vendor), current), "same_vendor", current, limit);
  take(selection, cheapest(open()), "cheapest", current, limit);

  const usedVendors = new Set<string>();
  for (const row of open()) {
    if (usedVendors.size >= OTHER_VENDOR_SLOTS) break;
    const rowVendor = vendorFor(row);
    if (rowVendor === vendor || usedVendors.has(rowVendor)) continue;
    usedVendors.add(rowVendor);
    take(selection, row, "other_vendor", current, limit);
  }

  for (const row of open()) {
    take(selection, row, vendorFor(row) === vendor ? "same_vendor" : "other_vendor", current, limit);
  }

  return { model, requirements: reqs, shortlist: selection.chosen, rejected, tested: false };
}
