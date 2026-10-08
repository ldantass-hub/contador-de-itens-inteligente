export const ORGANIZATIONS = ["TV/PC", "MEDIA", "ARCON", "MWO"] as const;

export type Organization = (typeof ORGANIZATIONS)[number];

export function isHistoricalOrganization(value: string | null | undefined): boolean {
  return value === "TV" || value === "PC";
}