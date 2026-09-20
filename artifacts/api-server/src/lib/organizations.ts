export const ORGANIZATIONS = ["PC", "TV", "MEDIA", "ARCON", "MWO"] as const;

export type Organization = (typeof ORGANIZATIONS)[number];

export function isOrganization(value: unknown): value is Organization {
  return typeof value === "string" &&
    (ORGANIZATIONS as readonly string[]).includes(value);
}