# Contributing to UPS Manager

## Development

```bash
npm run build      # build into dist/
npm run test       # run this plugin's tests
npm run typecheck  # type-check this plugin
npm run validate   # check manifest.json
npm run pack       # pack dist/ into a .tmxplug
npm run format     # format the code with Prettier
```

The backend tests include a populated 1.0.0-to-current SQLite migration and
fresh-install checks, permission isolation, energy persistence failures and
outage recovery. They do not require a physical UPS or run power commands.
MySQL/PostgreSQL live-runtime behavior needs separate validation; generated
migrations alone are not evidence of runtime compatibility.

Keep [authz.json](authz.json) in sync with HTTP routes for the upstream
authorization harness. Local route tests exercise the plugin's gates with mocked
core access decisions; they do not replace the full Termix authorization harness.

## Docs

The docs for this plugin are in [docs/](docs/), and `docs` in `manifest.json` links to them. Settings, permissions, services, environment variables and the API reference are made from `manifest.json` and the `@openapi` comments in the code, so keep those up to date instead of writing them by hand. See [writing docs](https://docs.termix.site/develop/docs).
