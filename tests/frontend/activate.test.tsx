import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import {
  renderWithApp,
  type RenderedPluginApp,
} from "@termix-ssh/plugin-sdk/testing";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import * as plugin from "../../src/frontend/index";
import { enabled, formatRuntime } from "../../src/frontend/format";
import manifestJson from "../../manifest.json";
import locales from "../../locales/en.json";
import { parseNut } from "../../src/backend/backends/nut";
import { applyDcPower } from "../../src/backend/power";
import type { EnergyHistory } from "../../src/shared/types";

const manifest = manifestJson as unknown as PluginManifest;

let rendered: RenderedPluginApp | null = null;

afterEach(async () => {
  await rendered?.deactivate();
  rendered = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
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

function api(
  list: { canEdit: boolean; sources: unknown[] },
  extra = {},
  status: () => Promise<unknown> = async () => list.sources[0],
) {
  return {
    get: vi.fn(async (url: string) => {
      const path = url.split("?")[0];
      for (const [key, value] of Object.entries(extra)) {
        if (path.endsWith(key)) {
          if (value instanceof Error) throw value;
          return { data: value };
        }
      }
      if (path.endsWith("/sources")) return { data: list };
      if (path.endsWith("/status")) return { data: await status() };
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

const energy: EnergyHistory = {
  range: "24h",
  start: 1_800_000_000,
  end: 1_800_000_060,
  epochs: [
    {
      id: "epoch-1",
      identity: "anonymous",
      origin: "reported",
      startedAt: 1_800_000_000,
      lastAt: 1_800_000_060,
      observedWh: 5 / 3,
      coveredSec: 60,
    },
  ],
  current: null,
  persistenceError: "",
  correlationStatus: "timestamped-service-required",
  points: [
    {
      t: 1_800_000_000,
      end: 1_800_000_030,
      epoch: "epoch-1",
      wh: 5 / 6,
      coveredSec: 30,
      observedSec: 30,
      outputW: 100,
      minW: 80,
      maxW: 120,
      inputW: 110,
      inputA: 0.5,
      outputA: 1,
      batteryA: -0.1,
    },
    {
      t: 1_800_000_030,
      end: 1_800_000_060,
      epoch: "epoch-1",
      wh: 5 / 6,
      coveredSec: 30,
      observedSec: 30,
      outputW: 100,
      minW: 90,
      maxW: 110,
      inputW: 110,
      inputA: 0.5,
      outputA: 1,
      batteryA: -0.1,
    },
  ],
  observedWh: 5 / 3,
  coveredSec: 60,
  eligibleSec: 60,
  coveragePct: 100,
  averageW: 100,
  sampledPeakW: 120,
  incomplete: false,
  resolutionSec: 300,
};

describe(`${manifest.id} frontend`, () => {
  it.each(["estimated", "reported"])(
    "labels %s dashboard load consistently",
    async (origin) => {
      rendered = await renderWithApp(plugin, {
        manifest,
        locales,
        hosts: [host],
        isAdmin: true,
        api: api(
          { canEdit: false, sources: [] },
          {
            "/summary": [
              {
                hostId: 1,
                sourceId: 5,
                label: "Rack UPS",
                backend: "nut",
                state: "online",
                flags: [],
                chargePct: 100,
                runtimeSec: 60,
                loadPct: 6.44,
                loadOrigin: origin,
                error: "",
              },
            ],
          },
        ),
      });
      rendered.renderDashboardCard("ups-hosts");
      expect(
        await screen.findByText(
          origin === "estimated" ? "6% estimated UPS load" : "6% load",
        ),
      ).toBeTruthy();
    },
  );

  it.each([9.6538, 300])(
    "labels estimated load from %s W and preserves overload values",
    async (watts) => {
      const r = applyDcPower(
        parseNut(
          `ups.status: OL\nups.realpower: ${watts}\nups.realpower.nominal: 150\n`,
        ),
        {},
      );
      rendered = await renderWithApp(plugin, {
        manifest,
        locales,
        api: api({ canEdit: false, sources: [{ ...source, reading: r }] }),
      });
      rendered.renderTab("ups-manager", { isVisible: true, host });
      expect(
        await screen.findByText(locales.overview.estimatedLoad),
      ).toBeTruthy();
      expect(screen.getByText(((watts / 150) * 100).toFixed(2))).toBeTruthy();
      expect(screen.getByText(/Output watts \/ 150 W rated/)).toBeTruthy();
    },
  );

  it("shows energy summaries, separate charts, epochs and accessible cumulative samples", async () => {
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: api(
        { canEdit: false, sources: [source] },
        {
          "/energy": energy,
          "/history": { points: [] },
        },
      ),
    });
    rendered.renderTab("ups-manager", { isVisible: true, host });
    await screen.findByText(locales.state.online);
    fireEvent.click(
      screen.getByRole("button", { name: locales.tab.viewHistory }),
    );
    await screen.findByText(locales.energy.period);
    expect(
      screen.getByRole("img", {
        name: `${locales.electrical.outputPower} (W)`,
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole("img", {
        name: `${locales.energy.cumulativeChart} (Wh)`,
      }),
    ).toBeTruthy();
    expect(screen.getByText(locales.energy.correlationBlocked)).toBeTruthy();
    fireEvent.click(screen.getByText(locales.energy.samples));
    expect(screen.getByRole("table")).toBeTruthy();
    expect(screen.getAllByText("1.66667")).toHaveLength(1);
    expect(screen.getByText("1.667")).toBeTruthy();
    expect(screen.getAllByText("-0.100")).toHaveLength(2);
    expect(
      screen.getByRole("img", {
        name: `${locales.electrical.batteryCurrent} (A)`,
      }).textContent,
    ).toContain("-0.05");
    expect(
      screen
        .getByRole("img", { name: `${locales.electrical.outputPower} (W)` })
        .querySelectorAll('line[stroke-width="1.5"]'),
    ).toHaveLength(1);
  });

  it.each(["gap", "epoch"])(
    "does not connect electrical lines across a %s",
    async (reason) => {
      const points = energy.points.map((point, index) =>
        index === 0
          ? point
          : reason === "gap"
            ? { ...point, t: point.t + 10, end: point.end + 10 }
            : { ...point, epoch: "different-epoch" },
      );
      rendered = await renderWithApp(plugin, {
        manifest,
        locales,
        api: api(
          { canEdit: false, sources: [source] },
          {
            "/energy": { ...energy, points },
            "/history": { points: [] },
          },
        ),
      });
      rendered.renderTab("ups-manager", { isVisible: true, host });
      await screen.findByText(locales.state.online);
      fireEvent.click(
        screen.getByRole("button", { name: locales.tab.viewHistory }),
      );
      await screen.findByText(locales.energy.period);
      expect(
        screen
          .getByRole("img", { name: `${locales.electrical.outputPower} (W)` })
          .querySelectorAll('line[stroke-width="1.5"]'),
      ).toHaveLength(0);
    },
  );

  it("surfaces energy service failure instead of displaying a zero total", async () => {
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: api(
        { canEdit: false, sources: [source] },
        {
          "/energy": new Error("storage failed"),
          "/history": { points: [] },
        },
      ),
    });
    rendered.renderTab("ups-manager", { isVisible: true, host });
    await screen.findByText(locales.state.online);
    fireEvent.click(
      screen.getByRole("button", { name: locales.tab.viewHistory }),
    );
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByText(locales.energy.period)).toBeNull();
  });

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

  it("refreshes each second and pauses outside Overview and on hidden pages", async () => {
    vi.useFakeTimers();
    const status = vi.fn(async () => source);
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: api({ canEdit: false, sources: [source] }, {}, status),
    });
    await act(async () => {
      rendered!.renderTab("ups-manager", { isVisible: true, host });
    });
    expect(status).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(status).toHaveBeenCalledTimes(4);
    fireEvent.click(
      screen.getByText(locales.tab.viewSources, { exact: false }),
    );
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(status).toHaveBeenCalledTimes(4);
    fireEvent.click(screen.getByText(locales.tab.viewOverview));
    await act(async () => {});
    expect(status).toHaveBeenCalledTimes(5);
    const visibility = vi.spyOn(document, "visibilityState", "get");
    visibility.mockReturnValue("hidden");
    fireEvent(document, new Event("visibilitychange"));
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(status).toHaveBeenCalledTimes(5);
    visibility.mockReturnValue("visible");
    fireEvent(document, new Event("visibilitychange"));
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(status).toHaveBeenCalledTimes(7);
  });

  it("skips ticks during a slow request and surfaces failures before retrying", async () => {
    vi.useFakeTimers();
    let finish: (value: unknown) => void = () => {
      throw new Error("No pending request");
    };
    const status = vi
      .fn<() => Promise<unknown>>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(source);
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: api({ canEdit: false, sources: [source] }, {}, status),
    });
    await act(async () => {
      rendered!.renderTab("ups-manager", { isVisible: true, host });
    });
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(status).toHaveBeenCalledTimes(1);
    await act(async () => finish(source));
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(screen.getByRole("alert").textContent).toBe(locales.tab.error);
    expect(screen.getByText("94")).toBeTruthy();
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(status).toHaveBeenCalledTimes(3);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("changes the live refresh interval", async () => {
    vi.useFakeTimers();
    const status = vi.fn(async () => source);
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: api({ canEdit: false, sources: [source] }, {}, status),
    });
    await act(async () => {
      rendered!.renderTab("ups-manager", { isVisible: true, host });
    });
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    try {
      fireEvent.click(screen.getByRole("combobox"));
      fireEvent.click(screen.getByRole("option", { name: "5 seconds" }));
      await act(async () => {});
    } finally {
      Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
    }
    const count = status.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(4999));
    expect(status).toHaveBeenCalledTimes(count);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(status).toHaveBeenCalledTimes(count + 1);
  });

  it("shows calculated DC metrics, metadata and searchable escaped diagnostics", async () => {
    const dc = {
      ...source,
      outputDc: true,
      reading: applyDcPower(
        parseNut(
          "ups.status: OL\noutput.voltage: 20.54\noutput.current: 0.470\nbattery.type: LiFePO4\ndriver.description: <script>example</script>\n",
        ),
        { outputDc: true },
      ),
    };
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: api({ canEdit: true, sources: [dc] }),
    });
    rendered.renderTab("ups-manager", { isVisible: true, host });
    expect(
      await screen.findByText(locales.electrical.outputPower),
    ).toBeTruthy();
    expect(screen.getByText("9.65")).toBeTruthy();
    expect(screen.getAllByText("0.470")).toHaveLength(2);
    expect(screen.getAllByText("LiFePO4")).toHaveLength(2);
    expect(screen.getByText(locales.electrical.calculated)).toBeTruthy();
    fireEvent.click(screen.getByText(locales.electrical.raw));
    const search = screen.getByLabelText(locales.electrical.search);
    fireEvent.change(search, { target: { value: "driver.description" } });
    expect(screen.getByText("<script>example</script>")).toBeTruthy();
    expect(document.querySelector("script")).toBeNull();
    fireEvent.change(search, { target: { value: "no-such-variable" } });
    expect(screen.getByText(locales.electrical.noVariables)).toBeTruthy();
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

describe("homepage widget", () => {
  it("adds a homepage widget and declares the extension point", async () => {
    rendered = await renderWithApp(plugin, { manifest, locales });
    expect(rendered.registered.extensions("homepage.widgets")).toEqual([
      "ups_manager_widget",
    ]);
    expect(manifest.contributes.uses).toContain("homepage.widgets");
  });
});
