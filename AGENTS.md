# Metapi Engineering Rules

These rules apply to the whole repository unless a deeper `AGENTS.md` overrides
them. They are intentionally opinionated and mechanical so humans and agents can
make small, consistent changes without re-learning the codebase each time.

## Golden Principles

- Prefer one source of truth. If a helper, contract, or workflow already owns
  an invariant, extend it instead of creating a parallel implementation.
- Fix the family, not just the symptom. When a bug comes from a repeated
  pattern, sweep adjacent paths in the same subsystem before calling the work
  done.
- Keep changes narrow and reviewable. Land one coherent slice at a time and
  avoid bundling unrelated cleanup into the same patch.

## Server Layers

- `src/server/routes/**` are adapters, not owners. Route files may register
  Fastify endpoints, parse request context, and delegate. They must not own
  protocol conversion, retry policy, stream lifecycle, billing, or
  persistence.
- If a helper is imported by anything outside one route file, it does not
  belong under `src/server/routes/proxy/`.
- `src/server/proxy-core/**` owns proxy orchestration. Endpoint fallback should
  flow through `executeEndpointFlow()`. Channel/session bookkeeping should flow
  through `sharedSurface.ts`.
- `src/server/transformers/**` are protocol-pure. Do not import from
  `src/server/routes/**`, Fastify, OAuth services, token router, or runtime
  dispatch modules. If a transformer needs a shared contract, move it to a
  neutral module first.
- Whole-body upstream reads in proxy orchestration should use
  `readRuntimeResponseText()` instead of direct `.text()` reads.

## Platform And Routing Rules

- Platform behavior must be explicit. Detection, endpoint preference, discovery
  transport, and management capability should come from one declared capability
  story, not scattered `if platform === ...` branches.
- Thin adapters must stay honest. Do not let a platform look feature-complete
  through inherited defaults if the underlying upstream does not support the
  feature.
- Retry classification and routing health classification should share the same
  failure vocabulary whenever possible.

## Database Rules

- One schema change requires three synchronized outputs: update the Drizzle
  schema, update SQLite migration history, and regenerate checked-in schema
  artifacts together.
- Cross-dialect bootstrap and upgrade SQL must be generated from the schema
  contract. Do not hand-write new MySQL/Postgres schema patches in feature
  code.
- Legacy schema compatibility is temporary and spec-owned. Additive startup
  shims should stay narrow and trace back to a feature compatibility spec.

## Web Rules

- Pages are orchestration surfaces, not shared utility libraries. Do not import
  one top-level page from another top-level page.
- Mobile behavior should reuse existing shared primitives first:
  `ResponsiveFilterPanel`, `ResponsiveBatchActionBar`, `MobileCard`,
  `useIsMobile`, and `mobileLayout.ts`.
- When a page grows a second complex modal, drawer, or panel family, extract it
  into a domain subfolder before adding more inline state and rendering logic.

## Guardrails

- Run `npm run repo:drift-check` before finishing changes that touch shared
  architecture boundaries.
- If you add a new boundary-heavy module, add or extend an architecture test in
  the same area so the rule becomes executable.
- Keep local planning files under `docs/plans/`. They are intentionally ignored
  by git and should not be treated as published documentation.


## Frok2 / Production Boundary

- The single source directory is `/home/div/1_Project_dir/Project/metapi`.
- `main` is unmodified upstream history. `Frok2` contains the preserved main-based repairs and maintenance tooling. Never merge the archived `Metapi-fork` into it.
- Before any deployment, check `git status`, the current commit, and `/home/div/.local/bin/metapictl status`. Git checkout changes source files, not the running image.
- The preserved running-source baseline is tag `frok2-baseline-20260917` (`f463dc7`). Keep release tags immutable and build only verified, committed sources.
- Build via `scripts/deploy/build-main-repairs.sh`. It exports the committed tree to a disposable directory, verifies provenance, and leaves local dist and production data alone.
- Operate production only through `/home/div/.local/bin/metapictl`. Runtime configuration is `/home/div/.config/metapi`, outside the Git worktree; use its immutable image record rather than a floating tag or a compose file from another branch.
- Production remains container `metapi-main`, Compose project `metapi-main-deploy`, port `4010`, data `/home/div/1_Project_dir/Project/metapi-main-deploy-data`. The data directory name is historical, not a second source checkout.
- Preserve Session, provider Cookie, user ID, API keys and encryption secrets. Never restore an old database over live data as part of a code rollback.
- No Chromium/Profile/noVNC or legacy Fork modules enter production. A changed database-code/schema fingerprint requires a separate migration plan.
- Run targeted tests, the full suite with `DOTENV_CONFIG_PATH=/dev/null`, typecheck, drift-check, docs build, image guard and live read-only verification before declaring a release complete. Updating docs is part of completion.
- Commit/push only on explicit user request. Cleanup is project-scoped; never run global Docker prune or stop unrelated services.
- Operational instructions: `docs/frok2-maintenance.md`. Historical restoration notes are evidence, not current deployment instructions.
