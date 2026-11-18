import { describe, expect, it } from "vitest";
import { parseNut } from "../../src/backend/backends/nut";
import { applyDcPower, electricalNumber } from "../../src/backend/power";

const DC = `ups.status: OL
device.mfr: WalleCube
device.model: Smart UPS W150
input.voltage: 20.77
input.current: 0.024
output.voltage: 20.54
output.current: 0.470
battery.current: -0.012
battery.type: LiFePO4
battery.mfr.date: OPEN
battery.capacity: 100
battery.charge.low: 10
driver.name: usbhid-ups
driver.version.data: openUPS HID 0.5
`;

describe("electrical telemetry", () => {
  it.each([150, 180])(
    "estimates DC load using the supplied %s W rating",
    (rating) => {
      const r = applyDcPower(
        parseNut(`${DC}ups.realpower.nominal: ${rating}\n`),
        { outputDc: true },
      );
      expect(r.loadPct).toBeCloseTo((9.6538 / rating) * 100, 8);
      expect(r.loadOrigin).toBe("estimated");
    },
  );

  it.each([0, 23, 140])(
    "prefers reported load %s, including zero and overload",
    (load) => {
      const r = applyDcPower(
        parseNut(`${DC}ups.realpower.nominal: 150\nups.load: ${load}\n`),
        { outputDc: true },
      );
      expect(r.loadPct).toBe(load);
      expect(r.loadOrigin).toBe("reported");
    },
  );

  it.each(["", "0", "-1", "NaN", "Infinity", "150W", "150 invalid"])(
    "does not estimate with invalid capacity %s",
    (capacity) => {
      const r = applyDcPower(
        parseNut(
          `${DC}ups.realpower.nominal: ${capacity}\nups.power.nominal: 150\n`,
        ),
        { outputDc: true },
      );
      expect(r.loadPct).toBeNull();
      expect(r.loadOrigin).toBe("unavailable");
    },
  );

  it("does not use VA-only ratings or unconfirmed DC watts", () => {
    expect(
      applyDcPower(parseNut(`${DC}ups.power.nominal: 150\n`), {
        outputDc: true,
      }).loadPct,
    ).toBeNull();
    expect(
      applyDcPower(parseNut(`${DC}ups.realpower.nominal: 150\n`), {}).loadPct,
    ).toBeNull();
  });

  it.each([0, 300])(
    "estimates from reported %s W without DC opt-in",
    (watts) => {
      const r = applyDcPower(
        parseNut(
          `ups.status: OL\nups.realpower: ${watts}\nups.realpower.nominal: 150\n`,
        ),
        {},
      );
      expect(r.loadPct).toBe((watts / 150) * 100);
      expect(r.loadOrigin).toBe("estimated");
      expect(r.electrical?.outputPowerOrigin).toBe("reported");
    },
  );

  it.each(["-1", "bad", "15percent"])(
    "treats invalid reported load %s as unavailable for fallback",
    (load) => {
      const r = applyDcPower(
        parseNut(
          `ups.status: OL\nups.load: ${load}\nups.realpower: 15\nups.realpower.nominal: 150\n`,
        ),
        {},
      );
      expect(r.loadPct).toBe(10);
      expect(r.loadOrigin).toBe("estimated");
    },
  );

  it("rejects overflowing estimated percentages", () => {
    const r = parseNut("ups.status: OL\n");
    r.nominalW = Number.MIN_VALUE;
    r.electrical!.outputPowerW = Number.MAX_VALUE;
    expect(applyDcPower(r, {}).loadPct).toBeNull();
  });

  it("uses A and preserves signed battery current without inferring DC", () => {
    const r = applyDcPower(parseNut(DC), {});
    expect(r.electrical?.outputCurrentA).toBe(0.47);
    expect(r.electrical?.batteryCurrentA).toBe(-0.012);
    expect(r.electrical?.outputPowerW).toBeNull();
    expect(r.electrical?.outputPowerOrigin).toBe("unavailable");
    expect(r.nut?.batteryManufactured).toBe("");
    expect(r.nut?.batteryType).toBe("LiFePO4");
    expect(r.nut?.variables["battery.capacity"]).toBe("100");
  });

  it("derives only explicitly confirmed DC domains", () => {
    const r = applyDcPower(parseNut(DC), { outputDc: true });
    expect(r.electrical?.outputPowerW).toBeCloseTo(9.6538, 8);
    expect(r.electrical?.outputPowerOrigin).toBe("calculated-dc");
    expect(r.electrical?.inputPowerW).toBeNull();
    const both = applyDcPower(parseNut(DC), { inputDc: true, outputDc: true });
    expect(both.electrical?.inputPowerW).toBeCloseTo(0.49848, 8);
  });

  it("prefers reported real watts, including zero, over calculations and VA", () => {
    const r = applyDcPower(
      parseNut(`${DC}output.realpower: 0\nups.realpower: 12\nups.power: 200\n`),
      { outputDc: true },
    );
    expect(r.electrical?.outputPowerW).toBe(0);
    expect(r.electrical?.outputPowerOrigin).toBe("reported");
    expect(
      parseNut(`${DC}ups.power: 200\n`).electrical?.outputPowerW,
    ).toBeNull();
    expect(parseNut(`${DC}ups.realpower: 15\n`).electrical?.outputPowerW).toBe(
      15,
    );
  });

  it.each(["NaN", "Infinity", "1e309", "bad 1.2", "1.2A", "", "-0.1"])(
    "rejects malformed or negative consumption: %s",
    (value) => {
      expect(electricalNumber(value)).toBeNull();
      const r = applyDcPower(parseNut(`${DC}output.current: ${value}\n`), {
        outputDc: true,
      });
      expect(r.electrical?.outputPowerW).toBeNull();
    },
  );

  it("does not multiply partially parsed voltage", () => {
    const r = applyDcPower(parseNut(`${DC}output.voltage: invalid 20\n`), {
      outputDc: true,
    });
    expect(r.outputV).toBeNull();
    expect(r.electrical?.outputPowerW).toBeNull();
  });

  it("preserves zero output current as valid zero watts", () => {
    const r = applyDcPower(parseNut(`${DC}output.current: 0\n`), {
      outputDc: true,
    });
    expect(r.electrical?.outputPowerW).toBe(0);
  });

  it("bounds diagnostics and excludes secret-like variables", () => {
    const r = parseNut(
      `${DC}driver.password: hidden\nups.token: hidden\ndriver.description: ${"x".repeat(900)}\n`,
    );
    expect(r.nut?.variables["driver.password"]).toBeUndefined();
    expect(r.nut?.variables["ups.token"]).toBeUndefined();
    expect(r.nut?.variables["driver.description"]).toHaveLength(512);
  });

  it("only exposes meaningful manufacturing dates", () => {
    expect(
      parseNut(`${DC}battery.mfr.date: 2026-02-31\n`).nut?.batteryManufactured,
    ).toBe("");
    expect(
      parseNut(`${DC}battery.mfr.date: 2026-02-28\n`).nut?.batteryManufactured,
    ).toBe("2026-02-28");
  });
});
