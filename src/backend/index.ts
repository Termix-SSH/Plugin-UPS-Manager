import type { Router } from "express";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { Engine } from "./engine.js";
import { History } from "./history.js";
import { registerOperations } from "./operations.js";
import { createRemote } from "./remote.js";
import { registerRoutes } from "./routes.js";
import { createService } from "./service.js";
import { createStore } from "./store.js";
import { events, sources } from "./tables.js";

export async function activate(ctx: PluginContext) {
  const remote = createRemote(ctx);
  const store = createStore(
    ctx,
    await ctx.db.define(sources),
    await ctx.db.define(events),
  );
  const history = new History(await ctx.files.dataDir());
  await history.load();
  const engine = new Engine(ctx, store, remote, history);
  engine.start();
  ctx.disposables.add(() => engine.dispose());

  const service = createService(store, engine, remote);
  registerOperations(ctx, store, engine, service);
  registerRoutes(ctx.http.router<Router>(), ctx, {
    store,
    engine,
    history,
    remote,
    service,
  });
  ctx.log.info("UPS Manager routes mounted at /plugin-api/ups-manager");
}

export async function deactivate() {
  // Everything above was registered through ctx and is disposed by core.
}
