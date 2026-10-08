export const ORGANIZATIONS = ["TV/PC", "MEDIA", "ARCON", "MWO"] as const;

export type Organization = (typeof ORGANIZATIONS)[number];

export function isHistoricalOrganization(value: unknown): boolean {
  return value === "TV" || value === "PC";
}

export function isOrganization(value: unknown): value is Organization {
  return typeof value === "string" &&
    (ORGANIZATIONS as readonly string[]).includes(value);
}