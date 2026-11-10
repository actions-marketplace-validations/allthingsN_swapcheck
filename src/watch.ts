import type { LoadedRegistry } from "./registry/client.ts";
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
}

function statusFromCatalog(row: RegistryModel | undefined): ExposureItem["status"] {
  if (!row) return "unknown";
  if (row.status === "retired") return "retired";
  if (row.status === "deprecated") return "retiring";
  return row.status === "active" ? "ok" : "unknown";
}

/** Events only apply on the exact route: a Bedrock retirement says nothing about the first-party API. */
function exposureOf(model: string, route: string, snapshot: RegistrySnapshot, now: Date): ModelExposure {
  const matching = snapshot.events.filter((event) => event.model === model && event.route === route);
  const outlooks = matching.flatMap((event) => outlookOf(event, now) ?? []).sort(compareOutlook);
  const ordered = [...outlooks.map((outlook) => outlook.event), ...matching.filter((event) => !outlooks.some((outlook) => outlook.event === event))];
  const primary = outlooks[0];
  if (primary) {
    const result: ModelExposure = { events: ordered, status: primary.status };
    if (primary.days !== undefined) result.days_until = primary.days;
    return result;
  }
  return { events: ordered, status: statusFromCatalog(snapshot.models.find((row) => row.id === model && row.route === route)) };
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
    const key = `${finding.model}\0${route}`;
    let item = groups.get(key);
    if (!item) {
      item = { model: finding.model, route, locations: [], ...exposureOf(finding.model, route, snapshot, now) };
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
    .map((entry): ExposureItem => ({ model: entry.id, route: entry.route, locations: [], ...exposureOf(entry.id, entry.route, loaded.snapshot, now) }))
    .sort(compareItems);
  return {
    registry_generated_at: loaded.snapshot.generated_at,
    registry_age_days: loaded.age_days,
    registry_source: loaded.source,
    items,
    due: dueItems(items, opts.failWithinDays),
  };
}
