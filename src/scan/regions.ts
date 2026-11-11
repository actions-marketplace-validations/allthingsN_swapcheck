import type { RegistryEvent } from "../types.ts";

/** An AWS region code such as us-west-2, ap-south-1 or us-gov-west-1. */
export const AWS_REGION = /^(?:us-gov|us|eu|ap|ca|sa|me|af|il|mx)-[a-z]+-\d$/;

const REGION_KEY = /^(?:aws_?)?(?:default_?)?region(?:_?name)?$|^bedrock_?region$/;

/** Keys that set the region a cloud call runs in: region, region_name, aws_region_name, AWS_REGION, regionName. */
export function isRegionKey(key: string): boolean {
  return key.length <= 40 && REGION_KEY.test(key.toLowerCase());
}

const PROFILE_PREFIX = /(?:^|[/:])(us-gov|us|eu|apac|au|jp|in|ca|sa|global)\.[a-z]/;

/** Regions a Bedrock geographic inference profile routes to. */
const PROFILE_REACH: Record<string, RegExp> = {
  "us-gov": /^us-gov-/,
  us: /^us-(?:east|west)-\d$/,
  eu: /^eu-/,
  apac: /^ap-/,
  au: /^ap-southeast-[24]$/,
  jp: /^ap-northeast-[13]$/,
  in: /^ap-south-[12]$/,
  ca: /^ca-/,
  sa: /^sa-/,
  global: /./,
};

const PROFILE_NAME: Record<string, string> = {
  "us-gov": "US GovCloud",
  us: "US",
  eu: "EU",
  apac: "Asia Pacific",
  au: "Australia",
  jp: "Japan",
  in: "India",
  ca: "Canada",
  sa: "South America",
  global: "global",
};

/** `profile:us` for an ID such as `bedrock/us.anthropic.claude-...`, or undefined when it names no profile. */
export function profileToken(raw: string): string | undefined {
  const geo = PROFILE_PREFIX.exec(raw)?.[1];
  return geo ? `profile:${geo}` : undefined;
}

/** True when a call limited to `token` (a region or a profile) can run in `region`. */
export function reaches(token: string, region: string): boolean {
  if (!token.startsWith("profile:")) return token === region;
  return PROFILE_REACH[token.slice("profile:".length)]?.test(region) ?? false;
}

export function describeRegion(token: string): string {
  if (!token.startsWith("profile:")) return token;
  const geo = token.slice("profile:".length);
  return `${PROFILE_NAME[geo] ?? geo} inference profile`;
}

/**
 * Narrows a region-limited event to the rows the call can reach, with the earliest of their dates.
 * Null when none of the event's regions apply. Events without a schedule, or calls with no known region, pass unchanged.
 */
export function forRegions(event: RegistryEvent, regions: string[] | undefined): RegistryEvent | null {
  if (!event.region_schedule || !regions || regions.length === 0) return event;
  const rows = event.region_schedule.filter((row) => row.regions.some((region) => regions.some((token) => reaches(token, region))));
  if (rows.length === 0) return null;
  const effective = rows.map((row) => row.effective).sort()[0] as string;
  return { ...event, effective, region_schedule: rows };
}

export function listedRegions(event: RegistryEvent): string[] {
  return [...new Set((event.region_schedule ?? []).flatMap((row) => row.regions))];
}
