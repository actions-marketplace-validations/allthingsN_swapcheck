import type { LoadedRegistry } from "./registry/client.ts";
import { forRegions } from "./scan/regions.ts";
import type { ExposureItem, LockFile, ModelStatus, RegistryEvent, RegistryModel, RegistrySnapshot, ScanResult, WatchResult } from "./types.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

function utcDay(date: Date): number {
  return Math.floor(date.getTime() / DAY_MS);
}

/** Whole calendar days from `now` to an ISO date; negative once it has passed. Null if unparseable. */
export function daysUntil(effective: string, now: Date): number | null {
  const parsed = Date.parse(`${effective}T00:00:00Z`);
  return Number.isNaN(parsed) ? null : Math.floor(parsed / DAY_MS) - utcDay(now);
}

interface EventOutlook {
  event: RegistryEvent;
  status: ModelStatus;
  days?: number;
  landed: boolean;
}

function retirementLike(event: RegistryEvent, days: number | null): Omit<EventOutlook, "event"> {
  const landed = days !== null && days < 0;
  const retirement = event.type === "retirement";
  const status: ModelStatus = retirement ? (landed ? "retired" : "retiring") : landed ? "rerouted" : "reroute_scheduled";
  return days === null ? { status, landed } : { status, days, landed };
}

/** Null when the event leaves nothing to act on, such as a price change already in effect. */
function outlookOf(event: RegistryEvent, now: Date): EventOutlook | null {
  const days = event.effective === undefined ? null : daysUntil(event.effective, now);
  if (event.type === "retirement" || event.type === "reroute" || event.type === "alias_move") {
    return { event, ...retirementLike(event, days) };
  }
  if (event.type !== "price_change" && event.type !== "parameter_change") return null;
  if (days !== null && days < 0) return null;
  const status: ModelStatus = event.type === "price_change" ? "repricing" : "parameter_change";
  return days === null ? { event, status, landed: false } : { event, status, days, landed: false };
}

const SEVERITY: Record<ModelStatus, number> = { retired: 0, rerouted: 1, retiring: 2, reroute_scheduled: 3, parameter_change: 4, repricing: 5 };

/** Changes that already landed come first, then the soonest date; undated changes come last. */
function compareOutlook(a: EventOutlook, b: EventOutlook): number {
  if (a.landed !== b.landed) return a.landed ? -1 : 1;
  const aDays = a.days ?? Number.POSITIVE_INFINITY;
  const bDays = b.days ?? Number.POSITIVE_INFINITY;
  if (a.landed) return SEVERITY[a.status] - SEVERITY[b.status] || bDays - aDays;
  return aDays - bDays || SEVERITY[a.status] - SEVERITY[b.status];
}

interface ModelExposure {
  events: RegistryEvent[];
  status: ExposureItem["status"];
  days_until?: number;
  resolved_as?: string[];
  /** Region-limited events that were left out because the call runs elsewhere. */
  other_regions?: RegistryEvent[];
}

function statusFromCatalog(row: RegistryModel | undefined): ExposureItem["status"] {
  if (!row) return "unknown";
  if (row.status === "retired") return "retired";
  if (row.status === "deprecated") return "retiring";
  return row.status === "active" ? "ok" : "unknown";
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Dated IDs on the same route that an undated ID stands for: Anthropic's `claude-opus-4-1` is
 * `claude-opus-4-1-20250805`, and an Azure `gpt-4o` deployment runs one of the dated gpt-4o versions.
 */
function datedVersions(model: string, route: string, snapshot: RegistrySnapshot): string[] {
  const dated = new RegExp(`^${escapeRegExp(model)}[-@](?:\\d{8}|\\d{4}-\\d{2}-\\d{2})$`);
  const ids = new Set<string>();
  for (const event of snapshot.events) if (event.route === route && dated.test(event.model)) ids.add(event.model);
  for (const row of snapshot.models) if (row.route === route && dated.test(row.id)) ids.add(row.id);
  return [...ids].sort();
}

function exposureFor(ids: string[], route: string, snapshot: RegistrySnapshot, now: Date, regions: string[] | undefined): ModelExposure {
  const onRoute = snapshot.events.filter((event) => ids.includes(event.model) && event.route === route);
  const matching = onRoute.flatMap((event) => forRegions(event, regions) ?? []);
  const elsewhere = onRoute.filter((event) => forRegions(event, regions) === null);
  // Every event is for regions this call never runs in, so nothing is announced for it.
  if (matching.length === 0 && elsewhere.length > 0) return { events: [], status: "ok", other_regions: elsewhere };
  const outlooks = matching.flatMap((event) => outlookOf(event, now) ?? []).sort(compareOutlook);
  const ordered = [...outlooks.map((outlook) => outlook.event), ...matching.filter((event) => !outlooks.some((outlook) => outlook.event === event))];
  const primary = outlooks[0];
  if (primary) {
    const result: ModelExposure = { events: ordered, status: primary.status };
    if (primary.days !== undefined) result.days_until = primary.days;
    return result;
  }
  const statuses = ids.map((id) => statusFromCatalog(snapshot.models.find((row) => row.id === id && row.route === route)));
  const listed = statuses.filter((status) => status !== "unknown");
  return { events: ordered, status: listed.find((status) => status !== "ok") ?? listed[0] ?? "unknown" };
}

/** Events only apply on the exact route: a Bedrock retirement says nothing about the first-party API. */
function exposureOf(model: string, route: string, snapshot: RegistrySnapshot, now: Date, regions?: string[]): ModelExposure {
  const listed = snapshot.events.some((event) => event.model === model && event.route === route) || snapshot.models.some((row) => row.id === model && row.route === route);
  if (listed) return exposureFor([model], route, snapshot, now, regions);
  const versions = datedVersions(model, route, snapshot);
  if (versions.length === 0) return exposureFor([model], route, snapshot, now, regions);
  // With several versions the deployed one is unknown from the repo, so the soonest change decides.
  return { ...exposureFor(versions, route, snapshot, now, regions), resolved_as: versions };
}

function compareItems(a: ExposureItem, b: ExposureItem): number {
  const aDays = a.days_until ?? Number.POSITIVE_INFINITY;
  const bDays = b.days_until ?? Number.POSITIVE_INFINITY;
  if (aDays !== bDays) return aDays - bDays;
  const aRank = a.status === "ok" || a.status === "unknown" ? 1 : 0;
  const bRank = b.status === "ok" || b.status === "unknown" ? 1 : 0;
  if (aRank !== bRank) return aRank - bRank;
  if (a.model !== b.model) return a.model < b.model ? -1 : 1;
  return a.route < b.route ? -1 : a.route > b.route ? 1 : 0;
}

export function computeExposure(scan: ScanResult, snapshot: RegistrySnapshot, now: Date = new Date()): ExposureItem[] {
  const groups = new Map<string, ExposureItem>();
  for (const finding of scan.findings) {
    if (finding.kind === "docs") continue;
    const route = finding.route ?? "unknown";
    const key = `${finding.model}\0${route}\0${(finding.regions ?? []).join(",")}`;
    let item = groups.get(key);
    if (!item) {
      item = { model: finding.model, route, locations: [], ...(finding.regions ? { regions: finding.regions } : {}), ...exposureOf(finding.model, route, snapshot, now, finding.regions) };
      groups.set(key, item);
    }
    if (!item.locations.some((location) => location.file === finding.file && location.line === finding.line)) {
      item.locations.push({ file: finding.file, line: finding.line });
    }
  }
  return [...groups.values()].sort(compareItems);
}

export function dueItems(items: ExposureItem[], failWithinDays: number): ExposureItem[] {
  return items.filter((item) => {
    if (item.status === "ok" || item.status === "unknown") return false;
    if (item.status === "retired" || item.status === "rerouted") return true;
    return item.days_until !== undefined && item.days_until <= failWithinDays;
  });
}

export function watchLock(lock: LockFile, loaded: LoadedRegistry, opts: { failWithinDays: number; now?: Date }): WatchResult {
  const now = opts.now ?? new Date();
  const items = lock.models
    .map((entry): ExposureItem => ({ model: entry.id, route: entry.route, locations: [], ...(entry.regions ? { regions: entry.regions } : {}), ...exposureOf(entry.id, entry.route, loaded.snapshot, now, entry.regions) }))
    .sort(compareItems);
  return {
    registry_generated_at: loaded.snapshot.generated_at,
    registry_age_days: loaded.age_days,
    registry_source: loaded.source,
    items,
    due: dueItems(items, opts.failWithinDays),
  };
}
