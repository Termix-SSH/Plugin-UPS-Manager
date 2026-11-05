import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import {
  renderWithApp,
  type RenderedPluginApp,
} from "@termix-ssh/plugin-sdk/testing";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import * as plugin from "../../src/frontend/index";
import { enabled, formatRuntime } from "../../src/frontend/format";
import manifestJson from "../../manifest.json";
import locales from "../../locales/en.json";

const manifest = manifestJson as unknown as PluginManifest;

let rendered: RenderedPluginApp | null = null;

afterEach(async () => {
  await rendered?.deactivate();
  rendered = null;
});

const reading = {
  state: "online",
  flags: [],
  chargePct: 94,
  runtimeSec: 2460,
  loadPct: 18,
  inputV: 231,
  outputV: 230,
  batteryV: 27.3,
  tempC: 31.5,
  nominalW: 900,
  manufacturer: "APC",
  model: "Back-UPS XS 1500M",
  serial: "3B1234",
  lastTest: "Done and passed",
  rawStatus: "OL",
};

const source = {
  id: 5,
  hostId: 1,
  backend: "nut",
  label: "Rack UPS",
  target: "ups",
  snmpVersion: "2c",
  lowCharge: 30,
  lowRuntimeMin: 5,
  alerts: true,
  enabled: true,
  hasSecrets: false,
  reading,
  error: "",
  readAt: Date.now(),
};

function api(list: { canEdit: boolean; sources: unknown[] }, extra = {}) {
  return {
    get: vi.fn(async (url: string) => {
      const path = url.split("?")[0];
      for (const [key, value] of Object.entries(extra)) {
        if (path.endsWith(key)) return { data: value };
      }
      if (path.endsWith("/sources")) return { data: list };
      if (path.endsWith("/status")) return { data: list.sources[0] };
      if (path.endsWith("/detect"))
        return {
          data: {
            upsc: true,
            upscmd: true,
            apcaccess: false,
            snmpwalk: false,
            nutUps: ["ups"],
            services: [],
          },
        };
      return { data: [] };
    }),
    post: vi.fn(async () => ({ data: source })),
    put: vi.fn(async () => ({ data: source })),
    delete: vi.fn(async () => ({ data: { ok: true } })),
  } as never;
}

const host = {
  id: 1,
  name: "rack",
  ip: "10.0.0.1",
  enableSsh: true,
  pluginSettings: { "ups-manager": { enableUps: true } },
};

describe(`${manifest.id} frontend`, () => {
  it("registers the tab and the dashboard card", async () => {
    rendered = await renderWithApp(plugin, { manifest, locales });
    expect(rendered.registered.tabs()).toEqual(["ups-manager"]);
    expect(rendered.registered.dashboardCards()).toEqual(["ups-hosts"]);
  });

  it("only offers the tab on hosts that turned it on", () => {
    expect(enabled(host)).toBe(true);
    expect(enabled({ pluginSettings: {} })).toBe(false);
    expect(enabled(null)).toBe(false);
  });

  it("shows the live numbers", async () => {
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: api({ canEdit: true, sources: [source] }),
    });
    rendered.renderTab("ups-manager", { isVisible: true, host });
    expect(await screen.findByText(locales.state.online)).toBeTruthy();
    expect(screen.getByText("94")).toBeTruthy();
    expect(screen.getByText("41m")).toBeTruthy();
    expect(
      screen.getByText("Back-UPS XS 1500M", { exact: false }),
    ).toBeTruthy();
  });

  it("marks a low battery", async () => {
    const low = {
      ...source,
      reading: {
        ...reading,
        state: "battery",
        flags: ["low-battery"],
        chargePct: 12,
      },
    };
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: api({ canEdit: true, sources: [low] }),
    });
    rendered.renderTab("ups-manager", { isVisible: true, host });
    expect(await screen.findByText(locales.state.battery)).toBeTruthy();
    expect(screen.getByText(locales.flag["low-battery"])).toBeTruthy();
  });

  it("asks to add a UPS when the host has none", async () => {
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: api({ canEdit: true, sources: [] }),
    });
    rendered.renderTab("ups-manager", { isVisible: true, host });
    expect(await screen.findByText(locales.sources.empty)).toBeTruthy();
    fireEvent.click(screen.getByText(locales.sources.add));
    expect(await screen.findByText(locales.editor.addTitle)).toBeTruthy();
  });

  it("hides adding without edit access", async () => {
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: api({ canEdit: false, sources: [] }),
    });
    rendered.renderTab("ups-manager", { isVisible: true, host });
    await screen.findByText(locales.sources.empty);
    expect(screen.queryByText(locales.sources.add)).toBeNull();
  });

  it("shows the unreadable error", async () => {
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: api({
        canEdit: true,
        sources: [{ ...source, reading: null, error: "Data stale" }],
      }),
    });
    rendered.renderTab("ups-manager", { isVisible: true, host });
    expect(await screen.findByText("Data stale")).toBeTruthy();
  });
});

describe("formatting", () => {
  it("writes runtimes", () => {
    expect(formatRuntime(null)).toBe("-");
    expect(formatRuntime(45)).toBe("45s");
    expect(formatRuntime(600)).toBe("10m");
    expect(formatRuntime(4800)).toBe("1h 20m");
    expect(formatRuntime(7200)).toBe("2h");
  });
});
