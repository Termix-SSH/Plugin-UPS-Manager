import { describe, expect, it, vi } from "vitest";
import { EnergyLedger, decodeEnergy } from "../../src/backend/energy-ledger";
import { parseNut } from "../../src/backend/backends/nut";
import type { SourceRow } from "../../src/backend/store";

const NOW = 1_800_000_000;
const row: SourceRow = {
  id: 1,
  hostId: 1,
  userId: "user-1",
  backend: "nut",
  label: "UPS",
  target: "ups",
  snmpVersion: "2c",
  secrets: null,
  lowCharge: 30,
  lowRuntimeMin: 5,
  alerts: false,
  enabled: true,
};
const reading = (watts = 100) =>
  parseNut(`ups.status: OL\nups.realpower: ${watts}\n`);

function setup(initial: string | null = null) {
  let saved = initial;
  const store = {
    readEnergy: vi.fn(async () => saved),
    writeEnergy: vi.fn(async (_id: number, payload: string) => {
      saved = payload;
    }),
  };
  const log = { warn: vi.fn() };
  return {
    ledger: new EnergyLedger(store, log),
    store,
    log,
    saved: () => saved,
  };
}

describe("durable observed energy", () => {
  it("commits 100 W for a covered hour as 100 Wh, including rollups", async () => {
    const { ledger, saved } = setup();
    for (let second = 0; second <= 3600; second += 30)
      await ledger.sample(row, reading(), NOW + second, second);
    expect(ledger.report(1).current).toMatchObject({ coveredSec: 3600 });
    expect(ledger.report(1).current!.observedWh).toBeCloseTo(100, 6);
    for (const range of ["24h", "7d", "30d"] as const) {
      const report = ledger.history(1, range, NOW + 3600);
      expect(report.observedWh).toBeCloseTo(100, 6);
      expect(report.coveragePct).toBeCloseTo(100, 6);
      expect(report.averageW).toBeCloseTo(100, 6);
      expect(report.sampledPeakW).toBe(100);
      expect(report.incomplete).toBe(false);
    }
    expect(decodeEnergy(saved()!).epochs[0].observedWh).toBeCloseTo(100, 6);
  });

  it("restores committed totals but never bridges restart downtime", async () => {
    const { ledger, store, log } = setup();
    await ledger.sample(row, reading(), NOW, 0);
    await ledger.sample(row, reading(), NOW + 30, 30);
    const before = ledger.report(1).current!.observedWh;
    const restarted = new EnergyLedger(store, log);
    await restarted.sample(row, reading(), NOW + 45, 0);
    expect(restarted.report(1).current!.observedWh).toBe(before);
    await restarted.sample(row, reading(), NOW + 75, 30);
    expect(restarted.report(1).current!.observedWh).toBeCloseTo(2 * before, 8);
    expect(restarted.history(1, "24h", NOW + 75).coveragePct).toBe(80);
  });

  it("breaks on known failures, invalid power and clock discontinuities", async () => {
    const { ledger } = setup();
    await ledger.sample(row, reading(), NOW, 0);
    ledger.break(1);
    await ledger.sample(row, reading(), NOW + 30, 30);
    await ledger.sample(row, parseNut("ups.status: OL\n"), NOW + 45, 45);
    await ledger.sample(row, reading(), NOW + 60, 60);
    await ledger.sample(row, reading(), NOW + 120.01, 120.01);
    await ledger.sample(row, reading(), NOW + 150, 130);
    expect(ledger.report(1).current!.observedWh).toBe(0);
    expect(ledger.history(1, "24h", NOW + 150).incomplete).toBe(true);
  });

  it("accepts exactly 60 seconds and zero W, rejecting duplicate observations", async () => {
    const { ledger } = setup();
    await ledger.sample(row, reading(0), NOW, 0);
    await ledger.sample(row, reading(0), NOW + 60, 60);
    await ledger.sample(row, reading(0), NOW + 60, 60);
    expect(ledger.report(1).current).toMatchObject({
      observedWh: 0,
      coveredSec: 60,
    });
    expect(ledger.history(1, "24h", NOW + 60).averageW).toBe(0);
  });

  it("separates changed sources and power methods, but not names", async () => {
    const { ledger } = setup();
    await ledger.sample(row, reading(), NOW, 0);
    await ledger.sample({ ...row, label: "Renamed" }, reading(), NOW + 30, 30);
    const changed = { ...row, target: "other" };
    await ledger.sample(changed, reading(), NOW + 60, 60);
    const calculated = reading();
    calculated.electrical!.outputPowerOrigin = "calculated-dc";
    await ledger.sample(changed, calculated, NOW + 90, 90);
    expect(ledger.report(1).epochs).toHaveLength(3);
    expect(ledger.report(1).epochs.map((e) => e.coveredSec)).toEqual([
      30, 0, 0,
    ]);
    expect(ledger.report(1).current!.origin).toBe("calculated-dc");
  });

  it("splits UTC hours without losing Wh or covered time", async () => {
    const { ledger } = setup();
    const boundary = Math.ceil(NOW / 3600) * 3600;
    await ledger.sample(row, reading(0), boundary - 15, 0);
    await ledger.sample(row, reading(100), boundary + 15, 30);
    const report = ledger.history(1, "7d", boundary + 15);
    expect(report.points).toHaveLength(2);
    expect(report.points[0].wh).toBeCloseTo((25 * 15) / 3600, 8);
    expect(report.observedWh).toBeCloseTo(0.4166666667, 8);
    expect(report.coveredSec).toBe(30);
    expect(report.points.map((p) => [p.minW, p.maxW])).toEqual([
      [0, 50],
      [50, 100],
    ]);
  });

  it("retains input power and currents even when output watts are unavailable", async () => {
    const { ledger } = setup();
    const first = parseNut(
      "ups.status: OL\ninput.realpower: 50\noutput.current: 1\n",
    );
    const second = parseNut(
      "ups.status: OL\ninput.realpower: 100\noutput.current: 2\n",
    );
    await ledger.sample(row, first, NOW, 0);
    await ledger.sample(row, second, NOW + 30, 30);
    const report = ledger.history(1, "24h", NOW + 30);
    expect(report.current).toBeNull();
    expect(report.sampledPeakW).toBeNull();
    expect(report.coveredSec).toBe(0);
    expect(report.points[0]).toMatchObject({
      outputW: null,
      inputW: 75,
      outputA: 1.5,
      observedSec: 30,
      coveredSec: 0,
    });
  });

  it("weights unequal intervals and preserves null channels without inferring zeros", async () => {
    const { ledger } = setup();
    const a = reading(0);
    a.electrical!.inputPowerW = 0;
    a.electrical!.inputPowerOrigin = "reported";
    const b = reading(100);
    b.electrical!.inputPowerW = 100;
    b.electrical!.inputPowerOrigin = "reported";
    await ledger.sample(row, a, NOW, 0);
    await ledger.sample(row, b, NOW + 30, 30);
    await ledger.sample(row, b, NOW + 90, 90);
    const report = ledger.history(1, "7d", NOW + 90);
    expect(report.averageW).toBeCloseTo((50 * 30 + 100 * 60) / 90, 8);
    expect(report.points[0].inputW).toBeCloseTo((50 * 30 + 100 * 60) / 90, 8);
    expect(report.points[0].batteryA).toBeNull();
  });

  it("retries an identical atomic document after persistence failure without double counting", async () => {
    const { ledger, store, log } = setup();
    await ledger.sample(row, reading(), NOW, 0);
    const save = store.writeEnergy.getMockImplementation()!;
    store.writeEnergy.mockImplementationOnce(async (id, payload) => {
      await save(id, payload);
      throw new Error("encrypted database save failed");
    });
    await expect(ledger.sample(row, reading(), NOW + 30, 30)).rejects.toThrow(
      "save failed",
    );
    expect(ledger.report(1).persistenceError).toContain("incomplete");
    expect(log.warn).toHaveBeenCalled();
    await ledger.sample(row, reading(), NOW + 60, 60);
    expect(ledger.report(1).current!.observedWh).toBeCloseTo(
      (100 * 30) / 3600,
      8,
    );
    expect(ledger.report(1).persistenceError).toBe("");
    await ledger.sample(row, reading(), NOW + 90, 90);
    expect(ledger.report(1).current!.observedWh).toBeCloseTo(
      (100 * 60) / 3600,
      8,
    );
  });

  it("does not overwrite damaged totals or treat load failures as zero energy", async () => {
    const { ledger, store, log, saved } = setup(
      '{"version":1,"epochs":"broken"}',
    );
    await expect(ledger.sample(row, reading(), NOW, 0)).rejects.toThrow(
      "Invalid energy state",
    );
    expect(store.writeEnergy).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalled();
    expect(saved()).toBe('{"version":1,"epochs":"broken"}');
  });

  it("rejects physically invalid persisted power while retaining signed battery current", async () => {
    const { ledger, saved } = setup();
    const r = reading();
    r.electrical!.batteryCurrentA = -0.1;
    await ledger.sample(row, r, NOW, 0);
    await ledger.sample(row, r, NOW + 30, 30);
    const valid = decodeEnergy(saved()!);
    expect(valid.raw[0].batteryA).toBe(-0.1);
    valid.raw[0].outputW = -1;
    expect(() => decodeEnergy(JSON.stringify(valid))).toThrow(
      "Invalid energy state",
    );
  });

  it("retains lifetime totals after all rolling history expires", async () => {
    const { ledger, saved } = setup();
    await ledger.sample(row, reading(), NOW, 0);
    await ledger.sample(row, reading(), NOW + 30, 30);
    const wh = ledger.report(1).current!.observedWh;
    const later = NOW + 31 * 86400;
    await ledger.sample(row, reading(), later, later - NOW);
    expect(ledger.report(1).current!.observedWh).toBe(wh);
    expect(decodeEnergy(saved()!).hours).toEqual([]);
    expect(ledger.history(1, "30d", later).points).toEqual([]);
    expect(ledger.history(1, "30d", later).coveragePct).toBe(0);
  });

  it("shares one initial load across live reads and canonical sampling", async () => {
    const { ledger, store } = setup();
    await Promise.all([ledger.load(1), ledger.load(1)]);
    expect(store.readEnergy).toHaveBeenCalledTimes(1);
  });
});
