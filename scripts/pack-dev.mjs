import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--out")) {
  throw new Error("Usage: npm run pack:dev -- [--out directory]");
}
const out = path.resolve(root, args[1] ?? ".");
const staging = fs.mkdtempSync(path.join(os.tmpdir(), "ups-dev-manager-"));

function namespace(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) namespace(file);
    else if (/\.(ts|tsx|json|sql|md)$/.test(entry.name)) {
      const text = fs.readFileSync(file, "utf8");
      fs.writeFileSync(
        file,
        text
          .replaceAll("ups-manager", "ups-dev-manager")
          .replaceAll("ups_manager", "ups_dev_manager")
          .replaceAll("UPS Manager", "UPS Manager dev"),
      );
    }
  }
}

function run(script, ...extra) {
  const result = spawnSync("npm", ["run", script, "--", ...extra], {
    cwd: staging,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${script} failed (${result.signal ?? result.status})`);
  }
}

try {
  for (const name of [
    "src",
    "tests",
    "locales",
    "migrations",
    "docs",
    "manifest.json",
    "authz.json",
    "package.json",
    "tsconfig.json",
    "vitest.config.ts",
    "README.md",
    "CHANGELOG.md",
    "LICENSE",
  ]) {
    fs.cpSync(path.join(root, name), path.join(staging, name), {
      recursive: true,
    });
  }
  namespace(staging);
  const manifestPath = path.join(staging, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.repository =
    "https://github.com/frankieslab-homelab/Plugin-UPS-Manager";
  manifest.author = { name: "frankieslab-homelab (development build)" };
  manifest.docs =
    "https://github.com/frankieslab-homelab/Plugin-UPS-Manager/blob/HL-20-electrical-metrics/docs/index.md";
  delete manifest.video;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  const localePath = path.join(staging, "locales/en.json");
  const locale = JSON.parse(fs.readFileSync(localePath, "utf8"));
  for (const key of ["tab", "card", "manager"]) {
    locale[key].title = "UPS Manager dev";
  }
  fs.writeFileSync(localePath, JSON.stringify(locale, null, 2) + "\n");
  fs.symlinkSync(
    path.join(root, "node_modules"),
    path.join(staging, "node_modules"),
    "junction",
  );

  run("test");
  run("typecheck");
  run("build");
  run("validate");
  run("pack", "--out", out);
} finally {
  fs.rmSync(staging, { recursive: true, force: true });
}
