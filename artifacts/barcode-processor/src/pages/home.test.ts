import { describe, expect, it } from "vitest";
import { processInput } from "../lib/barcodeProcessor";
import { removeScanEntry } from "../lib/scanEntryRemoval";

describe("removeScanEntry", () => {
  it("removes one scan and recalculates the total from the remaining raw lines", () => {
    const items = [
      { id: "newer", isError: false },
      { id: "older", isError: false },
    ];
    const rawLines = ["ABCDEFGHIJK;4", "ABCDEFGHIJK;7"];

    const remaining = removeScanEntry(items, rawLines, "newer");

    expect(remaining.items.map(item => item.id)).toEqual(["older"]);
    expect(remaining.rawLines).toEqual(["ABCDEFGHIJK;4"]);
    expect(processInput(remaining.rawLines.join("\n")).total).toBe(4);
  });

  it("keeps equal-code readings independent by their local IDs", () => {
    const items = [
      { id: "second", isError: false },
      { id: "first", isError: false },
    ];
    const rawLines = ["ABCDEFGHIJK;4", "ABCDEFGHIJK;7"];

    const remaining = removeScanEntry(items, rawLines, "first");

    expect(remaining.items.map(item => item.id)).toEqual(["second"]);
    expect(remaining.rawLines).toEqual(["ABCDEFGHIJK;7"]);
    expect(processInput(remaining.rawLines.join("\n")).total).toBe(7);
  });

  it("returns an empty zero-total operation after removing the last reading", () => {
    const remaining = removeScanEntry(
      [{ id: "only", isError: false }],
      ["ABCDEFGHIJK;9"],
      "only",
    );
    const total = remaining.rawLines.length
      ? processInput(remaining.rawLines.join("\n")).total
      : 0;

    expect(remaining.items).toEqual([]);
    expect(remaining.rawLines).toEqual([]);
    expect(total).toBe(0);
  });

  it("does not allow parser-error entries to be removed as valid counts", () => {
    const items = [{ id: "error", isError: true }];
    const rawLines = ["CNIWNCE429"];

    const remaining = removeScanEntry(items, rawLines, "error");

    expect(remaining.items).toBe(items);
    expect(remaining.rawLines).toBe(rawLines);
  });
});