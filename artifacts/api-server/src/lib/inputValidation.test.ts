import { describe, expect, it } from "vitest";
import { parsePostgresId, parsePostgresQuantity } from "./inputValidation.js";

describe("parsePostgresId", () => {
  it.each([
    [1, 1],
    ["1", 1],
    ["00042", 42],
    [2_147_483_647, 2_147_483_647],
    ["2147483647", 2_147_483_647],
  ])("accepts a valid PostgreSQL integer id (%j)", (value, expected) => {
    expect(parsePostgresId(value)).toBe(expected);
  });

  it.each([
    null,
    undefined,
    true,
    {},
    0,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    2_147_483_648,
    "",
    "0",
    "-1",
    "+1",
    "1.0",
    "1e2",
    " 1",
    "2147483648",
  ])("rejects an invalid PostgreSQL integer id (%j)", (value) => {
    expect(parsePostgresId(value)).toBeNull();
  });
});

describe("parsePostgresQuantity", () => {
  it.each([0, 1, 2_147_483_647])("accepts a valid PostgreSQL quantity (%j)", (value) => {
    expect(parsePostgresQuantity(value)).toBe(value);
  });

  it.each([
    null,
    undefined,
    true,
    "1",
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
    2_147_483_648,
  ])("rejects an invalid PostgreSQL quantity (%j)", (value) => {
    expect(parsePostgresQuantity(value)).toBeNull();
  });
});