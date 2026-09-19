# Working on scrcpy-jev

- Keep the repository self-contained. It must not import from `mobile-jev` or any cloud device SDK.
- Never commit `.env` files, API keys, traces, screenshots or device serials. `artifacts/` and
  `src/device/helper/*.jar` are ignored.
- Jev selects operations and targets. Code owns candidate discovery, validation, coordinate
  resolution and execution. Never insert task-specific tap scripts into the policy or the executor.
- Both the model prompt shape and the device adapter are swappable. Keep `TypeSafePolicy.decide` and
  the device surface (`assertReady`/`observe`/`listApps`/`act`/`screenshot`) stable.
- Read the current TypeSafe API docs before changing the inference contract:
  https://docs.typesafe.ai/llms.txt
- Keep navigation actions sequential. Retry only stale decisions rejected _before_ input; never
  replay an uncertain mutation. Prefer reporting `input_unverified` over retyping.
- The on-device helper is the reason observations are fast. Keep its wire format tiny and versioned
  by build hash; do not add a dependency that needs a second process.
- Report model-declared completion separately from independently verified outcomes. Traces must keep
  unsuccessful attempts.
- Run `npm test` (offline) and `npm run check` before publishing changes. A live run needs an
  attached phone and a TypeSafe key; CI must not need either.
