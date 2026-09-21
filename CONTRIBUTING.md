# Contributing

Hass Sync (formerly zepp-hass-sync) is a small, independent replacement for the zepp2hass Zepp Store
app. Contributions are welcome, especially around sensor coverage, payload
compatibility with zepp2hass, and testing on devices other than the GTR 4.

## Before you start

- For anything beyond a small fix, open an issue first to discuss the approach.

## Development

This is a Zepp OS app built with the standard Zepp OS app structure
(`app.js`, `app-side/`, `app-service/`, `page/`, `setting/`, `shared/`). Use the
[Zepp OS CLI](https://docs.zepp.com/docs/reference/cli/) or Zeus (Zepp OS
simulator/dev tools) to build, run, and debug on a simulator or a paired device.

```bash
npm install
```

There is no automated test suite yet; changes are verified by running the app
on a simulator or a real Amazfit GTR 4.

## Making changes

- Keep the payload shape sent to zepp2hass compatible — see
  [app-side/format.js](app-side/format.js) and the target schema in
  [zepp2hass](https://github.com/davidepalleschi/zepp2hass)'s
  `custom_components/zepp2hass/sensors/*.py`.
- Match the existing code style (no build step/linter is enforced yet).
- Test on-device or in the simulator before opening a PR; note what you tested
  in the PR description.
- Keep PRs focused — one change per PR is easier to review and revert.

## Reporting issues

Please include your watch model, Zepp OS version, and relevant logs (via
`hmLog`/the Zepp OS debugger) when reporting a bug.
