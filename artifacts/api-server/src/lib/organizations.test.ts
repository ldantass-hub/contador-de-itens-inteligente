import { describe, expect, it } from "vitest";
import { isHistoricalOrganization, isOrganization } from "./organizations.js";

describe("isOrganization", () => {
  it("accepts the combined TV/PC organization", () => {
    expect(isOrganization("TV/PC")).toBe(true);
  });

  it.each(["TV", "PC"])("rejects legacy organization %s for new operations", (value) => {
    expect(isOrganization(value)).toBe(false);
    expect(isHistoricalOrganization(value)).toBe(true);
  });
});