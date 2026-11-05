import { describe, expect, it } from "vitest";
import { parseNut } from "../../src/backend/backends/nut";
import {
  conditionsOf,
  diff,
  messageFor,
  type Condition,
} from "../../src/backend/conditions";
import { statusOf } from "../../src/backend/operations";
import { UPSC_ON_BATTERY, UPSC_ONLINE } from "./fixtures";

const limits = { lowCharge: 30, lowRuntimeMin: 5 };

describe("conditions", () => {
  it("has none on a healthy UPS", () => {
    expect([...conditionsOf(parseNut(UPSC_ONLINE), limits)]).toEqual([]);
  });

  it("finds everything wrong on a dying battery", () => {
    const on = conditionsOf(parseNut(UPSC_ON_BATTERY), limits);
    expect([...on].sort()).toEqual(
      [
        "on-battery",
        "low-battery",
        "replace-battery",
        "low-charge",
        "low-runtime",
      ].sort(),
    );
  });

  it("ignores low charge while on mains", () => {
    const r = parseNut(UPSC_ONLINE);
    r.chargePct = 10;
    expect(conditionsOf(r, limits).has("low-charge")).toBe(false);
  });

  it("turns the runtime limit off with 0", () => {
    const r = parseNut(UPSC_ON_BATTERY);
    expect(
      conditionsOf(r, { lowCharge: 30, lowRuntimeMin: 0 }).has("low-runtime"),
    ).toBe(false);
  });

  it("flags a failed self test", () => {
    const r = parseNut(UPSC_ONLINE);
    r.lastTest = "Error, battery failed";
    expect(conditionsOf(r, limits).has("test-failed")).toBe(true);
  });

  it("reports only what changed", () => {
    const before = new Set<Condition>(["on-battery", "low-charge"]);
    const after = new Set<Condition>(["low-charge", "overload"]);
    expect(diff(before, after)).toEqual([
      { condition: "on-battery", on: false },
      { condition: "overload", on: true },
    ]);
  });

  it("words alerts plainly", () => {
    const r = parseNut(UPSC_ON_BATTERY);
    const on = messageFor({ condition: "on-battery", on: true }, r, "Rack");
    expect(on.title).toBe("Rack is running on battery");
    expect(on.severity).toBe("critical");
    expect(on.body).toContain("27%");
    expect(on.body).toContain("5 min");
    const off = messageFor({ condition: "on-battery", on: false }, r, "Rack");
    expect(off.severity).toBe("info");
    expect(`${on.title}${on.body}${off.title}`).not.toContain(" - ");
  });

  it("rates a reading for the status tile", () => {
    expect(statusOf(parseNut(UPSC_ONLINE), "").status).toBe("ok");
    expect(statusOf(parseNut(UPSC_ON_BATTERY), "").status).toBe("fail");
    expect(statusOf(null, "boom").status).toBe("unknown");
    const warn = parseNut(UPSC_ONLINE);
    warn.state = "battery";
    expect(statusOf(warn, "").status).toBe("warn");
  });
});
