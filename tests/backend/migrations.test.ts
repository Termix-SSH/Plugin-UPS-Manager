import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createTestDb } from "@termix-ssh/plugin-sdk/testing";

const root = fileURLToPath(new URL("../..", import.meta.url));

describe("SQLite installation and upgrade", () => {
  it("installs all tables on an empty database and does not reapply migrations", async () => {
    const db = await createTestDb(root);
    try {
      expect(db.applied).toEqual(["0001_update", "0002_update", "0003_update"]);
      expect(
        db.sqlite.prepare("SELECT * FROM p_ups_manager_energy_states").all(),
      ).toEqual([]);
      expect(await db.migrate()).toEqual([]);
      expect(db.sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("upgrades populated 1.0.0 tables without changing sources, secrets or events", async () => {
    const db = await createTestDb(root, { skipMigrations: true });
    try {
      db.sqlite.exec(
        await readFile(
          new URL("../../migrations/sqlite/0001_update.sql", import.meta.url),
          "utf8",
        ),
      );
      db.applied.push("0001_update");
      db.sqlite.exec(`
        INSERT INTO users (id) VALUES ('fixture-user');
        INSERT INTO ssh_data (id) VALUES (7);
        INSERT INTO p_ups_manager_sources
          (id, host_id, user_id, backend, label, target, secrets)
          VALUES (42, 7, 'fixture-user', 'nut', 'Existing UPS', 'ups', 'sealed:fixture');
        INSERT INTO p_ups_manager_events (source_id, at, type, text)
          VALUES (42, 1800000000000, 'on-battery', 'Existing event');
      `);
      const before = db.sqlite
        .prepare("SELECT * FROM p_ups_manager_sources")
        .all();
      const events = db.sqlite
        .prepare("SELECT * FROM p_ups_manager_events")
        .all();
      expect(await db.migrate()).toEqual(["0002_update", "0003_update"]);
      expect(
        db.sqlite.prepare("SELECT * FROM p_ups_manager_sources").all(),
      ).toEqual(
        before.map((row) => ({
          ...(row as Record<string, unknown>),
          input_dc: 0,
          output_dc: 0,
        })),
      );
      expect(
        db.sqlite.prepare("SELECT * FROM p_ups_manager_events").all(),
      ).toEqual(events);
      expect(
        db.sqlite.prepare("SELECT * FROM p_ups_manager_energy_states").all(),
      ).toEqual([]);
      expect(await db.migrate()).toEqual([]);
      expect(db.sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      db.close();
    }
  });
});
