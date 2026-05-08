# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.8] - 2026-05-08

Bugfix release. Two issues prevented consumers from running the plugin against the README-documented config: the plugin patched the wrong requires-key, and env-var fallback names did not match the README naming.

### Fixed

- **Plugin requires-key mismatch — entities not deployed** (Blocker). README documented `cds.requires.watch` but `src/plugin.ts` registered the kind as `cardano-watcher` and patched `cds.env.requires['cardano-watcher']`. The `if (reqEntry)` guard never fired for consumers using the README config, so the plugin's `model` array was never set on the requires entry. Result: `cds deploy` never generated DDL for `WatcherCursor` / `WatchedCredential` / `WatchedAddress` / `WatchedPolicy` / `BlockchainEvent` / `TransactionSubmission` / `WatcherConfig`, and the polling loop crashed with `no such table: CardanoWatcherAdminService_WatchedCredentials`. Plugin now registers the kind as `watch` and patches `cds.env.requires['watch']`, matching the README.

### Changed

- **Env-var fallback names aligned with README naming.** `BLOCKFROST_KEY` → `BLOCKFROST_API_KEY`, `KOIOS_KEY` → `KOIOS_API_KEY`. `BLOCKFROST_CUSTOM_BACKEND`, `OGMIOS_URL`, `WATCHER_BACKEND` unchanged. Consumers can now leave the field out of `package.json` and export the env var instead — the plugin reads it directly when `cds.env.requires.watch.<field>` is unset. Documented in `README.md` and `docs/SETUP.md`.
- **Docs: removed broken `${VAR}` substitution pattern.** Previous `docs/SETUP.md` suggested `"blockfrostApiKey": "${BLOCKFROST_KEY}"` — CAP's env loader does **not** substitute `${...}` placeholders inside `cds.requires.*`, so this pattern always produced a literal `"${BLOCKFROST_KEY}"` string at runtime. Replaced with the env-var fallback path described above.

### Breaking (semantic)

- Consumers who were using `cds.requires.cardano-watcher` as the requires key (i.e. matching the pre-0.1.8 plugin code rather than the README) must rename to `cds.requires.watch`. Anyone following the documented config is unaffected.
- Consumers using `BLOCKFROST_KEY` / `KOIOS_KEY` env vars must rename to `BLOCKFROST_API_KEY` / `KOIOS_API_KEY`. No alias is kept.

## [0.1.7] - 2026-05-06

Adds support for routing the Blockfrost SDK at a self-hosted Blockfrost-compatible endpoint (e.g. [Dolos](https://github.com/txpipe/dolos)'s MiniBF) instead of the public Blockfrost service. Polling-heavy deployments would otherwise burn through the public free-tier daily quota; pointing at a local MiniBF removes the ceiling entirely.

### Added

- **`blockfrostCustomBackend` config field** (`src/config.ts`, `src/blockfrost.ts`). When set, the Blockfrost SDK is constructed with `customBackend` instead of the public-network preset, and `blockfrostApiKey` becomes optional. Env fallback: `BLOCKFROST_CUSTOM_BACKEND`. Default for Dolos's MiniBF is `http://localhost:3100/api/v0`.
- README and `docs/SETUP.md` / `docs/QUICKSTART.md` updated with the self-hosted Blockfrost setup.
- Unit tests in `test/unit/blockfrost.test.ts`, `test/unit/config.test.ts`, `test/unit/watcher.test.ts` covering the custom-backend code path (constructor wiring, config resolution, API-key-optional case).

## [0.1.6] - 2026-05-03

Hotfix release. 0.1.5 shipped with a stale path in the CAP plugin entry — the package boot-crashes on `npm install` for any consumer.

### Fixed

- **`cds-plugin.js` references the pre-0.1.5 layout** (Blocker). The 0.1.5 packaging migration updated `package.json.main` from `dist/src/index.js` to `src/index.js`, but `cds-plugin.js` (a separate CAP plugin entry, not generated from TS) was missed and still required `./dist/src/plugin` — a path that no longer exists after the in-place build. Result: `MODULE_NOT_FOUND` on every CAP startup. One-line fix to `require('./src/plugin')`.

### Maintenance

- `.gitignore`: ignore the in-place build artifacts (`src/**/*.js`, `src/**/*.d.ts`, `srv/**/*.js`, `srv/**/*.d.ts`) so they're shipped in the npm tarball but not tracked in git.

## [0.1.5] - 2026-05-03

Bugfix release covering four blocker/major issues that prevented a clean out-of-the-box experience after the 0.1.4 feature wave. No new features.

### Fixed

- **Packaging — `srv/admin-service` not loadable from a fresh install** (Blocker). Previous tarball shipped `srv/admin-service.ts` only; CAP's `@impl: '@odatano/watch/srv/admin-service'` couldn't resolve a `.js` file. Switched to in-place compilation via new `tsconfig.build.json` (`outDir: "."`). Now `srv/admin-service.js` ships alongside the source.
- **Packaging — `#cds-models/...` runtime require failed for consumers** (Blocker). Replaced `require('#cds-models/CardanoWatcherAdminService')` with literal relative path `require('../@cds-models/CardanoWatcherAdminService/index.js')`. `@cds-models/` directory now ships in the tarball. Consumers no longer need to mirror an `imports` field in their own `package.json`.
- **Koios endpoint `/credential_address` does not exist** (Blocker). `getAddressesByCredential` now hits `/credential_utxos` (the only Koios endpoint that returns addresses for a credential), dedups by `row.address`, and paginates via `Range` header. Caveat: returns only currently-unspent addresses — sufficient for credential watching's filter-set use case.
- **Hot script credentials triggered genesis-backfill stampede** (Major). `addWatchedAddress` / `addWatchedCredential` / `addWatchedPolicy` now default `lastCheckedBlock` to the current Blockfrost tip (was `null`, which made the first poll fetch from genesis). Hits Koios's pagination cap on creds with millions of historical txs (Minswap V2, etc.) are no longer the OOTB experience. Under Ogmios mode the cursor stays `null` so the chainSync-cap'd backfill can still run.
- **`backfill.ts` ESLint failure** — overengineered `infer _` conditional type replaced with direct type imports.

### Changed

- **Build pipeline**: `tsc` → `tsc -p tsconfig.build.json`. New `build:typecheck` script runs the original (no-emit) tsc for IDE-style verification.
- **`package.json`**:
  - `main`: `dist/src/index.js` → `src/index.js`
  - `types`: `dist/src/index.d.ts` → `src/index.d.ts`
  - `files` array: explicit globs (`*.js`, `*.d.ts`, `*.cds`) instead of directory entries — strips `.ts` source from the published tarball (65 → 45 files).
- **TypeScript module resolution**: `moduleResolution: "node"` (deprecated alias) → `"node16"`. `module` aligned to `"node16"`. Two dynamic `import('./index')` calls in `src/plugin.ts` updated to `import('./index.js')`. Jest gains a `moduleNameMapper` to strip `.js` suffixes back to TS source for compile-on-the-fly tests.

### Breaking (semantic)

- **Watch-add no longer backfills history by default.** A freshly-added watch sees only forward activity (from the current Blockfrost tip onward). This is the corrected behavior — previous "default to genesis" caused the OOTB stampede. Consumers needing history can call `backfill.backfillAddress()` / `backfillCredential()` / `backfillPolicy()` programmatically, or PATCH the watch entity to set an earlier `lastCheckedBlock`.

## [0.1.4] - 2026-05-03

### Added

**Watch scopes**
- `WatchedCredential` entity (P1) — watch a payment credential across every bech32 derivative that shares it. Required for shared-script watching (Indigo CDP-manager, Minswap V2 pools, etc.). Backed by Koios for credential→addresses resolution.
- `WatchedPolicy` entity (P4) — watch a minting policy for mint/burn events. Suited to stablecoin/utility-token policies; high-asset NFT policies refused via `policyAssetCap` (default 100).

**Event payloads (P2 / P3 / P5)**
- `cardano.newTransactions` payload extended **in-place** with `tag`, `utxosCreated[]`, `utxosSpent[]`. UTxO entries carry `lovelace`, `assets[]`, and (when present) `inlineDatumHex` and `referenceScriptHash`.
- New event `cardano.credential.newTransactions` — same UTxO-rich shape, scoped to a payment credential.
- New events `cardano.policy.assetMinted` and `cardano.policy.assetBurned` — per-event semantics, payload `{ policyId, tag?, assetNameHex, quantity, txHash, blockHeight }`.
- All events carry an optional consumer-supplied `tag` for dispatch routing.

**Asset filter (P8)**
- `includesAssetsJson` column on `WatchedAddress` and `WatchedCredential`. JSON array of `{policyId, assetNameHex}`. Non-matching txs are skipped (cursor still advances). `addWatchedAddress` / `addWatchedCredential` accept the filter.
- Public helpers `parseAssetFilter`, `matchesAssetFilter`, type `AssetFilterEntry`.

**Coalesce window (P9)**
- `coalesceMs` column on `WatchedAddress` and `WatchedCredential` (1 – 300_000 ms). Bus events fire at most once per window with cumulative deltas; `BlockchainEvent` rows persist immediately. Tumbling-window semantics. `stopWatcher` flushes pending buffers.

**Replay API**
- New action `getEventsSince(scope, key, fromBlock?, limit?)`. `scope`: `'address' | 'credential' | 'policy'`. Returns persisted `BlockchainEvent` rows ordered by `blockHeight` ascending. Cursor pagination via `fromBlock` (exclusive); default limit 1000, hard cap 10_000.

**Phase 2 — Ogmios chainSync backend (`backend: 'ogmios'`)**
- `src/ogmios.ts` — chainSync wrapper with reconnect / exponential backoff, intersection negotiation.
- `src/ogmios-watcher.ts` — per-block filter pass: in-memory watch index (refreshed every 10 s), derives `WatchedUtxo` / mint / burn shapes from `Schema.Block`, persists `BlockchainEvent` rows tagged `backend: 'ogmios'` with `slot`, advances `WatcherCursor`.
- `src/backfill.ts` — Blockfrost-based one-shot history fetch on watch-add under Ogmios mode. Capped at the chainSync cursor's tip. Backfill rows tagged `backend: 'blockfrost'` so rollback never touches them.
- `RollBackward` handler: deletes `backend: 'ogmios'` rows past the rollback slot, recomputes per-watch `lastCheckedBlock`, drops pending coalesce buffers, emits `cardano.rollback { fromSlot, toSlot, affectedTxHashes }`.
- New entity `WatcherCursor` (single-row, id `'chainsync'`) persists chainSync state across restarts.

**Schema**
- `BlockchainEvent.slot` (Integer64, nullable) — populated by Ogmios backend.
- `BlockchainEvent.backend` (String) — `'blockfrost'` or `'ogmios'`. Scopes rollback to Ogmios rows only.
- `BlockchainEvent.address`, `.credential`, `.policy` associations for replay scope dispatch.
- `WatcherActionResult`, `WatcherBackend`, `PaymentCredHex`, `PolicyId`, `AssetNameHex` types.

**Configuration**
- `backend: 'blockfrost' | 'ogmios'` (default `'blockfrost'`).
- `ogmiosUrl: string` (default `'ws://localhost:1337'`); env fallback `OGMIOS_URL`.
- `koiosApiKey: string` (optional; env fallback `KOIOS_KEY`). Required only for credential watching.
- `credentialPolling`, `policyPolling` polling configs (off by default).
- `policyAssetCap: number` (default 100).

**Validators**
- `isPaymentCredHex`, `isPolicyId`, `isAssetNameHex`, `isAssetFilterJson`, `isCoalesceMs`, `isWatchScope`.

**Public types**
- `WatchedUtxo`, `SpentUtxoRef`, `WatchedAsset`, `PolicyAssetEvent`, `AssetFilterEntry`, `CredentialNewTransactionsEvent`, `PolicyAssetMintedEvent`, `PolicyAssetBurnedEvent`, `RollbackEvent`.

**Documentation**
- New **Event Delivery Contract** section in `ARCHITECTURE.md` — guarantees, non-guarantees, consumer guidance for state-machine handlers, replay patterns, coalesce+replay interaction.
- README rewritten ~600 → ~100 lines; full reference content lives in `docs/`.
- `QUICKSTART.md`, `ARCHITECTURE.md`, `SETUP.md` refreshed for the current entity / event / action surface.

### Changed

- **Pagination correctness**: `getCredentialTxsSince` now paginates Koios via PostgREST `Range` headers (1000-row pages, 100k-row safety cap per poll). Previously silently dropped rows past the first page on busy credentials.
- **Pagination correctness**: `fetchPolicyAssetEvents` switched from `assetsHistory` (100-row default) to `assetsHistoryAll`. Previously truncated mint/burn history on high-velocity policies.
- `extractUtxoDeltas` signature: takes `Set<string>` of watched addresses (was a single string) so the credential watcher can pass every bech32 derivative at once. Address watchers wrap their single address.
- Polling section now describes four independent paths (address, transaction, credential, policy) instead of two.

### Fixed

- **Genesis cursor bug**: `processAddress` no longer treats `lastCheckedBlock = 0` or `null` as "no cursor". Fresh-added watches now actually fire on first poll; block 0 is honored as a real cursor.
- `fetchAddressTransactions` falsy-check fix: `if (fromBlock != null ...)` instead of `if (fromBlock ...)` to allow block 0.

### Known limitations

- **Ogmios backend has no `utxosSpent` detection:** Ogmios's `inputs` are outpoints, not (address + value). The polling backend continues to detect spends; switching to Ogmios is currently output-only.
- **`referenceScriptHash` not populated under Ogmios:** Ogmios delivers full script body; consumer can hash if needed.
- **Coalesce buffers not threaded through Ogmios chainSync emits** in this release — `coalesceMs` works under Blockfrost mode only.
- **`cardano.transactionConfirmed` event** declared in the public type surface but still not emitted; planned alongside Phase 2 follow-up work.
- **Backfill cap uses `getLatestBlock`** rather than slot→block translation. Rare overlap window with chainSync at the boundary; documented.

## [0.1.3] - 2026-02-07

### Fixed
- **CDS Model Auto-Discovery**: Plugin's CDS models (schema, admin service) were not loaded by consumer apps. CAP's `_link_required_services()` runs during env construction before `cds-plugin.js` loads, so the `model` array set on `cds.env.requires.kinds` was never merged into the requires entry. Fixed by setting `model` directly on `cds.env.requires['cardano-watcher']` in addition to the kind registration.
- **@impl Path Resolution**: `CardanoWatcherAdminService` used a relative `@impl` path (`srv/admin-service`) which CAP resolved against the consumer app root instead of the plugin package root, causing `Cannot find module` errors. Fixed by using the package-qualified path `@odatano/watch/srv/admin-service`.

## [0.1.2] - 2026-01-22

### Added
- GitHub Actions CI workflow for automated testing on Node.js 20.x and 22.x
- Test coverage reporting with Codecov integration
- `test:coverage` npm script for generating coverage reports
- `cds:types` npm script for CDS type generation
- Test and coverage badges in README

### Changed
- Renamed `eslint.config.js` to `eslint.config.mjs` to eliminate Node.js module type warning
- Updated `prepare` script to include CDS type generation before build
- Enhanced README with test workflow and coverage badges

### Fixed
- **Type Safety**: Replaced all `any` types with proper TypeScript types across the codebase
  - Added `BlockfrostAmount` interface for Blockfrost API responses
  - Changed `Function` type to proper function signatures in tests
  - Used `unknown` type for error handling with proper type guards
  - Used `Service` type from `@sap/cds` for database operations
  - Fixed optional parameter handling in `initializeClient`
- Fixed ESLint warnings about unsafe function types
- Fixed TypeScript strict mode compliance in error handling
- Added CDS type generation step to CI workflow

### Infrastructure
- GitHub Actions workflow with matrix testing (Node 20.x, 22.x)
- Automated type checking, linting, and testing in CI
- Coverage reporting pipeline

## [0.1.1] - 2026-01-19

### Changed
- Migrated to native CDS logger (`cds.log()`) instead of custom logger implementation
- Simplified API key configuration: `blockfrostApiKey` in config, `BLOCKFROST_KEY` env variable as fallback for development
- Updated all documentation (README, QUICKSTART, SETUP, ARCHITECTURE) to reflect new configuration approach

### Removed
- Custom `logger.ts` utility (replaced by CDS logger)
- Unused configuration options: `blockfrostProjectId`, `batchSize`, `enableWebhooks`, `webhookEndpoint`

### Fixed
- **BREAKING**: Config key inconsistency - now consistently uses `cds.env.requires.watch` (previously mixed usage)
- Important: Configuration priority - CDS config always takes precedence over environment variables
- Consistent logger naming: unified to `ODATANO-WATCH`

## [0.1.0] - 2026-01-17

### Added
- Initial release of @odatano/watch CAP plugin
- Cardano blockchain monitoring via Blockfrost API
- Address monitoring with configurable polling intervals
- Transaction tracking and confirmation detection
- Independent polling paths for addresses (30s) and transactions (60s)
- Event-based architecture with CAP event bus integration
- OData Admin Service for management and monitoring
- Multi-network support (mainnet, preview, preprod)
- TypeScript-first implementation with full type definitions
- Comprehensive error handling and logging
- Complete documentation (README, QUICKSTART, SETUP, ARCHITECTURE)
- Unit and integration tests
- CAP plugin auto-registration
- Environment variable configuration support

### Features
- **Events**: `cardano.newTransactions` and `cardano.transactionConfirmed`
- **Admin Actions**: Start/stop watcher, add addresses, track transactions
- **Data Models**: WatchedAddress, TransactionSubmission, BlockchainEvent, Transaction
- **API Integration**: Blockfrost API client with retry logic
- **Configuration**: Flexible configuration via package.json or environment variables

[0.1.0]: https://github.com/ODATANO/ODATANO-WATCH/releases/tag/v0.1.0
