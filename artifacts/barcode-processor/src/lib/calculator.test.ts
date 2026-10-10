import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { processInput } from "./barcodeProcessor";
import {
  confirmCalculatorResult,
  evaluateExpression,
  findCalculatorTarget,
  type CalculatorEntry,
} from "./calculator";
import { removeScanEntry } from "./scanEntryRemoval";

const timestamp = new Date("2026-10-08T12:00:00.000Z");
const homeSource = readFileSync(new URL("../pages/home.tsx", import.meta.url), "utf8");

function entry(id: string, code: string | null, quantity: number | null, isError = false): CalculatorEntry {
  return { id, code, quantity, isError, raw: "", timestamp, log: "" };
}

describe("calculator expression evaluation", () => {
  it.each([
    ["5000-925", 4075],
    ["12+3*4", 24],
    ["20/4", 5],
    ["-2+7", 5],
  ])("evaluates %s", (expression, expected) => {
    expect(evaluateExpression(expression)).toBe(expected);
  });

  it.each(["", "2/0", "2+", "2x3"])("rejects invalid expression %s", expression => {
    expect(evaluateExpression(expression)).toBeNull();
  });

  it("evaluates decimal expressions for display", () => {
    expect(evaluateExpression("1.5+1")).toBe(2.5);
  });
});

describe("calculator operation integration", () => {
  it("does not render a manual destination selector", () => {
    expect(homeSource).not.toContain("calculatorTargetId");
    expect(homeSource).not.toContain("Usar na calculadora");
    expect(homeSource).not.toContain("scan-item-target");
  });

  it("closes the calculator without applying or mutating the operation", () => {
    const closeButton = homeSource.match(/<button type="button" className="calculator-close"[\s\S]*?<\/button>/)?.[0];
    expect(closeButton).toContain("setCalculatorOpen(false)");
    expect(closeButton).not.toContain("confirmCalculatorResult");

    const items = [entry("scan", "0RJ6767C433", 5000)];
    const rawLines = ["0RJ6767C433;5000"];
    evaluateExpression("5000-925");
    expect(items[0].quantity).toBe(5000);
    expect(rawLines).toEqual(["0RJ6767C433;5000"]);
  });

  it("uses the latest visible valid entry for the active code without a manual target", () => {
    const items = [entry("latest", "0RJ6767C433", 5000), entry("older", "0RJ6767C433", 10)];

    expect(findCalculatorTarget(items, "0RJ6767C433")?.id).toBe("latest");
    expect(findCalculatorTarget(items, "OTHER-CODE")).toBeNull();
  });

  it("adds the result to existing quantity and keeps the finalizable raw input in sync", () => {
    const items = [entry("scan", "0RJ6767C433", 5000)];
    const rawLines = ["0RJ6767C433;5000"];
    const updated = confirmCalculatorResult(items, rawLines, "5000-925", {
      id: "calculated",
      timestamp,
    });

    expect(updated?.appliedQuantity).toBe(4075);
    expect(updated?.expression).toBe("");
    expect(updated?.items.map(item => item.id)).toEqual(["calculated", "scan"]);
    expect(updated?.rawLines).toEqual(["0RJ6767C433;5000", "4075"]);
    expect(updated?.items[0].quantity).toBe(4075);
    expect(processInput(updated!.rawLines.join("\n"))).toMatchObject({ activeCode: "0RJ6767C433", total: 9075 });

    expect(confirmCalculatorResult(updated!.items, updated!.rawLines, updated!.expression, {
      id: "duplicate",
      timestamp,
    })).toBeNull();
  });

  it("keeps the result removable as one local reading", () => {
    const updated = confirmCalculatorResult(
      [entry("scan", "0RJ6767C433", 5000)],
      ["0RJ6767C433;5000"],
      "4075",
      { id: "calculated", timestamp },
    )!;

    const removed = removeScanEntry(updated.items, updated.rawLines, "calculated");
    expect(processInput(removed.rawLines.join("\n")).total).toBe(5000);
  });

  it("rejects application when there is no valid active-code target", () => {
    expect(confirmCalculatorResult(
      [entry("bad", "CNIWNCE429", null, true)],
      ["CNIWNCE429"],
      "7",
      { id: "calculated", timestamp },
    )).toBeNull();
    expect(findCalculatorTarget([entry("bad", null, null, true)], null)).toBeNull();
  });

  it("rejects zero, fractional, out-of-range, or overflowing quantities", () => {
    const items = [entry("scan", "0RJ6767C433", 2_147_483_640)];
    const rawLines = ["0RJ6767C433;2147483640"];
    const newEntry = { id: "calculated", timestamp };

    expect(confirmCalculatorResult(items, rawLines, "0", newEntry)).toBeNull();
    expect(confirmCalculatorResult(items, rawLines, "1.5", newEntry)).toBeNull();
    expect(confirmCalculatorResult(items, rawLines, "2147483648", newEntry)).toBeNull();
    expect(confirmCalculatorResult(items, rawLines, "10", newEntry)).toBeNull();
  });
});