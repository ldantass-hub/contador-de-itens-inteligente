import { describe, expect, it } from "vitest";
import { isHistoricalOrganization, ORGANIZATIONS } from "./organizations";

describe("frontend organization options", () => {
  it("offers one TV/PC option and keeps the other organizations", () => {
    expect(ORGANIZATIONS).toEqual(["TV/PC", "MEDIA", "ARCON", "MWO"]);
    expect(ORGANIZATIONS).not.toContain("TV");
    expect(ORGANIZATIONS).not.toContain("PC");
  });

  it("recognizes old labels only for historical session resumption", () => {
    expect(isHistoricalOrganization("TV")).toBe(true);
    expect(isHistoricalOrganization("PC")).toBe(true);
    expect(isHistoricalOrganization("TV/PC")).toBe(false);
  });
});