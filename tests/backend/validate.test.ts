import { describe, expect, it } from "vitest";
import { parseSource } from "../../src/backend/validate";

const base = { backend: "nut", label: "Rack", target: "ups" };

describe("source input", () => {
  it("accepts the three kinds", () => {
    expect(parseSource(base).target).toBe("ups");
    expect(parseSource({ ...base, target: "ups@10.0.0.5:3493" }).target).toBe(
      "ups@10.0.0.5:3493",
    );
    expect(
      parseSource({ backend: "apcupsd", label: "A", target: "" }).target,
    ).toBe("");
    expect(
      parseSource({ backend: "snmp", label: "S", target: "192.168.1.20:161" })
        .snmpVersion,
    ).toBe("2c");
  });

  it("rejects bad targets before they reach a shell", () => {
    for (const target of [
      "",
      "ups;rm -rf /",
      "$(id)",
      "a b",
      "ups@host:99999x",
    ]) {
      expect(() => parseSource({ ...base, target })).toThrow();
    }
    expect(() =>
      parseSource({ backend: "snmp", label: "S", target: "1.2.3.4;id" }),
    ).toThrow();
    expect(() =>
      parseSource({ backend: "apcupsd", label: "S", target: "a;b" }),
    ).toThrow();
  });

  it("checks names, thresholds and versions", () => {
    expect(() => parseSource({ ...base, label: "" })).toThrow();
    expect(() => parseSource({ ...base, label: "x".repeat(81) })).toThrow();
    expect(() => parseSource({ ...base, backend: "ssh" })).toThrow();
    expect(() => parseSource({ ...base, lowCharge: 0 })).toThrow();
    expect(() => parseSource({ ...base, lowRuntimeMin: 9999 })).toThrow();
    expect(() => parseSource({ ...base, snmpVersion: "4" })).toThrow();
  });

  it("collects only the secrets it knows", () => {
    const s = parseSource({
      ...base,
      secrets: { nutUser: "admin", nutPassword: "pw", evil: "x" },
    });
    expect(s.secrets).toEqual({ nutUser: "admin", nutPassword: "pw" });
    expect(() =>
      parseSource({ ...base, secrets: { nutUser: "a b;c" } }),
    ).toThrow();
  });
});
