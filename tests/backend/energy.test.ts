import { describe, expect, it } from "vitest";
import {
  hourlyEnergy,
  integratePower,
  type PowerSample,
} from "../../src/backend/energy";

const sample = (
  at: number,
  watts = 100,
  epoch = "source-1:reported",
): PowerSample => ({ at, monotonic: at, watts, epoch });

describe("observed energy arithmetic", () => {
  it("integrates 100 W across one continuously covered hour into 100 Wh", () => {
    let wh = 0;
    let covered = 0;
    for (let t = 30; t <= 3600; t += 30) {
      const interval = integratePower(sample(t - 30), sample(t))!;
      wh += interval.wh;
      covered += interval.coveredSec;
    }
    expect(wh).toBeCloseTo(100, 6);
    expect(covered).toBe(3600);
  });

  it("integrates a linear 30-second ramp before any averaging", () => {
    const interval = integratePower(sample(0, 0), sample(30, 100))!;
    expect(interval.wh).toBeCloseTo(0.4166666667, 6);
  });

  it("accepts exactly 60 seconds, but not a longer gap", () => {
    expect(integratePower(sample(0), sample(60))).not.toBeNull();
    expect(integratePower(sample(0), sample(60.001))).toBeNull();
  });

  it("starts a new baseline after a failure or restart", () => {
    expect(integratePower(null, sample(30))).toBeNull();
  });

  it("breaks continuity on source or method changes", () => {
    expect(
      integratePower(sample(0), sample(30, 100, "source-1:dc")),
    ).toBeNull();
    expect(
      integratePower(sample(0), sample(30, 100, "source-2:reported")),
    ).toBeNull();
  });

  it("rejects duplicated, reversed, discontinuous or invalid samples", () => {
    for (const current of [
      sample(0),
      sample(-30),
      sample(30, NaN),
      sample(30, Infinity),
      sample(30, -1),
      { ...sample(30), monotonic: 15 },
    ]) {
      expect(integratePower(sample(0), current)).toBeNull();
    }
  });

  it("counts valid zero W as covered time, not missing data", () => {
    expect(integratePower(sample(0, 0), sample(30, 0))).toMatchObject({
      wh: 0,
      coveredSec: 30,
    });
  });

  it("splits energy and covered time at hourly boundaries", () => {
    const interval = integratePower(sample(3585, 0), sample(3615, 100))!;
    const buckets = hourlyEnergy(interval);
    expect(buckets).toHaveLength(2);
    expect(buckets.map((b) => b.hour)).toEqual([0, 3600]);
    expect(buckets[0].coveredSec).toBe(15);
    expect(buckets[0].wh).toBeCloseTo((25 * 15) / 3600, 8);
    expect(buckets.reduce((sum, b) => sum + b.wh, 0)).toBeCloseTo(
      interval.wh,
      8,
    );
  });
});
