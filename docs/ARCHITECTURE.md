# Architecture

Technical internals of the ODATANO-WATCH plugin.

## Overview

CAP plugin that monitors the Cardano blockchain via polling-based backends. Four independent polling paths (address, credential, policy, transaction submission). Events are emitted via the CAP event bus *and* persisted as `BlockchainEvent` rows for replay. Two backends are wired today: **Blockfrost** (always required) and **Koios** (required for credential watching). An **Ogmios** chainSync backend with native rollback semantics is planned for Phase 2.

## Component Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                       Your CAP Services                          │
│  cds.on("cardano.newTransactions")                               │
│  cds.on("cardano.credential.newTransactions")                    │
│  cds.on("cardano.policy.assetMinted" | "...assetBurned")         │
│  test.send("getEventsSince", { scope, key, fromBlock })          │
└─────────────┬─────────────────────────────────────────┬──────────┘
              │ Bus                                     │ Replay (OData)
       ╔══════╧═══════╗                          ┌──────┴───────────┐
       ║ CAP Event Bus║                          │ Admin Service    │
       ╚══════╤═══════╝                          │ (admin-service)  │
              │                                  └──────┬───────────┘
┌─────────────┴────────────────────────────────────────┴───────────┐
│                     ODATANO-WATCH Plugin                          │
│                                                                   │
│  Watcher (src/watcher.ts)                                         │
│  ├─ pollWatchedAddresses()    [interval: addressPolling]          │
│  ├─ pollWatchedCredentials()  [interval: credentialPolling]       │
│  ├─ pollWatchedPolicies()     [interval: policyPolling]           │
│  ├─ pollTransactionSubmissions() [interval: transactionPolling]   │
│  └─ Coalesce buffers (per-address, per-credential)                │
│                                                                   │
│  Backends                                                         │
│  ├─ src/blockfrost.ts  (txs, txsUtxos, assets/policy/*, ...)     │
│  └─ src/koios.ts       (credential_address, credential_txs)       │
│                                                                   │
│  Config (src/config.ts)                                           │
└────────────────┬──────────────────────────────────────────────────┘
                 │ persists events, advances cursors
          ┌──────┴──────┐
          │  Database   │  WatchedAddress / Credential / Policy
          │             │  TransactionSubmission, BlockchainEvent
          └─────────────┘
```

## Core Modules

### cds-plugin.js / src/plugin.ts

Entry point. Auto-loaded by CAP because the package contains `cds-plugin.js`.

Registers the `cardano-watcher` kind with CDS model paths and sets `model` directly on the requires entry (CAP's `_link_required_services()` runs before plugins load and won't merge kind properties into existing requires entries).

On `cds.on('served')`, initializes the watcher. On `cds.on('shutdown')`, calls `stop()` — which flushes any pending coalesce buffers before clearing intervals.

### src/index.ts

Public surface — `initialize`, lifecycle exports, `getStatus`, type re-exports.

```typescript
export default {
  initialize, start, stop,
  startAddressPolling,    stopAddressPolling,
  startTransactionPolling, stopTransactionPolling,
  startCredentialPolling, stopCredentialPolling,
  startPolicyPolling,     stopPolicyPolling,
  getStatus, config: getConfig,
};

// Public type surface
export type {
  CardanoWatcherConfig,
  TransactionInfo, AddressInfo,
  WatchedUtxo, WatchedAsset, SpentUtxoRef,
  PolicyAssetEvent, AssetFilterEntry,
  NewTransactionsEvent,
  CredentialNewTransactionsEvent,
  PolicyAssetMintedEvent, PolicyAssetBurnedEvent,
  TxConfirmedEvent,
};
```

### src/watcher.ts

Hosts the four polling lifecycles plus the per-watch coalesce buffers.

Each polling path follows the same shape:
1. `SELECT` active rows of the relevant `Watched*` entity.
2. For each row, fetch new state via the appropriate backend.
3. Filter (P8 asset filter) and aggregate.
4. Persist `BlockchainEvent` rows + advance `lastCheckedBlock` in one DB transaction.
5. Either emit immediately, or push into the coalesce buffer (P9) keyed by the watch identity.

Coalesce buffers are tumbling windows: the first event in a window starts a `setTimeout(coalesceMs)`; later events accumulate without resetting the timer. `stop*Polling` flushes pending buffers before returning.

### src/blockfrost.ts

Blockfrost API integration plus the public delta-projection helpers.

```typescript
export function initializeClient(config): BlockFrostAPI
export function isAvailable(): boolean

// Polling fetchers
export async function fetchAddressTransactions(address, fromBlock): Promise<TransactionInfo[] | null>
export async function fetchTxUtxos(txHash, addresses): Promise<{ utxosCreated, utxosSpent } | null>
export async function fetchPolicyAssetEvents(policyId, fromBlock, assetCap): Promise<PolicyAssetEvent[] | null>
export async function getTransaction(hash): Promise<TransactionInfo | null>

// Delta + filter helpers
export function extractUtxoDeltas(txUtxos, txHash, watchedAddresses: Set<string>): { utxosCreated, utxosSpent }
export function parseAssetFilter(json: string | null): AssetFilterEntry[] | null
export function matchesAssetFilter(utxosCreated, filter): boolean
```

`fetchPolicyAssetEvents` walks `assetsPolicyByIdAll` then `assetsHistoryAll` per asset, with a per-tx block-height cache so a tx mentioned by N assets resolves to one `txs(hash)` call. Returns `null` (not throws) when the asset count exceeds `policyAssetCap` — the watcher logs a warning and skips that policy.

### src/koios.ts

Single-purpose Koios client used only for credential resolution.

```typescript
export function initializeClient(config): void
export function isAvailable(): boolean
export async function getAddressesByCredential(credHex): Promise<string[]>
export async function getCredentialTxsSince(credHex, afterBlockHeight): Promise<KoiosCredTx[]>
```

Network-aware base URL (`mainnet.koios.rest` / `preview` / `preprod`). Optional bearer auth. `getCredentialTxsSince` paginates via PostgREST `Range` header in 1000-row pages, hard cap 100k rows per poll.

### src/config.ts

Loads from `cds.env.requires.watch` with environment-variable fallback (`BLOCKFROST_KEY`, `KOIOS_KEY`). Validates network and surfaces the merged config via `get()`.

## Data Flow

### Address Polling (P1 baseline + P2/P3 deltas + P8 filter + P9 coalesce)

```
Timer → pollWatchedAddresses()
  → SELECT WatchedAddress WHERE active = true
  → for each watch:
      fetchAddressTransactions(address, lastCheckedBlock)
      → for each tx: txs(hash) + txsUtxos(hash) → extractUtxoDeltas(tx, {address})
      ↓ parseAssetFilter(includesAssetsJson)
      filter txs by matchesAssetFilter(utxosCreated, filter)
      ↓
      INSERT BlockchainEvent (matching txs only)
      UPDATE lastCheckedBlock = max(blockHeight)  // even for filtered-out txs
      ↓
      if coalesceMs > 0: bufferAddressEmit(...)
      else:              cds.emit("cardano.newTransactions", payload)
```

### Credential Polling (P1)

```
Timer → pollWatchedCredentials()
  → SELECT WatchedCredential WHERE active = true
  → for each cred:
      koios.getAddressesByCredential(credHex)        // resolve cred → bech32 set
      koios.getCredentialTxsSince(credHex, lastCheckedBlock)
      → for each tx: blockfrost.fetchTxUtxos(tx.hash, addressSet)
      ↓ same filter + coalesce path as address layer
      cds.emit("cardano.credential.newTransactions", payload)
```

The credential path needs Koios because Blockfrost has no `credential_*` query. The Blockfrost `txsUtxos` call is reused for delta projection so the WatchedUtxo / SpentUtxoRef shape is identical to the address layer.

### Policy Polling (P4)

```
Timer → pollWatchedPolicies()
  → SELECT WatchedPolicy WHERE active = true
  → for each policy:
      blockfrost.fetchPolicyAssetEvents(policyId, lastCheckedBlock, policyAssetCap)
      → assetsPolicyByIdAll(policyId)
      → for each asset under policy:
          assetsHistoryAll(asset)
          → for each mint/burn row: txs(hash) (cached) → block_height
      ↓
      INSERT BlockchainEvent per event (type = ASSET_MINTED | ASSET_BURNED)
      UPDATE lastCheckedBlock = max(blockHeight)
      ↓
      cds.emit("cardano.policy.assetMinted" | "...assetBurned", per event)
      // Per-event semantics, not batched. No coalesce on policy watching.
```

### Transaction Submission Polling (legacy)

```
Timer → pollTransactionSubmissions()
  → SELECT TransactionSubmission WHERE active = true
  → for each submission:
      blockfrost.getTransaction(txHash)
      → if found: INSERT BlockchainEvent + UPDATE active = false
```

Note: the `cardano.transactionConfirmed` emit path is not yet wired; the type exists in the public surface but the emit is gated on Phase 2.

### Replay (out-of-band)

```
admin.send("getEventsSince", { scope, key, fromBlock, limit })
  → SELECT BlockchainEvent
       WHERE <fk-for-scope> = key
       AND   blockHeight > fromBlock
       ORDER BY blockHeight asc
       LIMIT min(limit, 10000)
  → return rows
```

The replay reads the persisted source-of-truth, including for coalesce-buffered events that haven't yet emitted on the bus.

## Database Entities

See [`db/schema.cds`](../db/schema.cds) for the canonical definitions. Summary:

```cds
entity WatchedAddress {
  key address: Bech32;
  description: String(500);
  tag: String(100);
  includesAssetsJson: LargeString;
  coalesceMs: Integer64;
  active: Boolean;
  lastCheckedBlock: Integer64;
  network: String(20);
  events: Composition of many BlockchainEvent;
}

entity WatchedCredential {
  key paymentCredHex: PaymentCredHex;        // 56-char hex
  description: String(500);
  tag: String(100);
  includesAssetsJson: LargeString;
  coalesceMs: Integer64;
  active: Boolean;
  lastCheckedBlock: Integer64;
  network: String(20);
  events: Composition of many BlockchainEvent;
}

entity WatchedPolicy {
  key policyId: PolicyId;                    // 56-char hex
  description: String(500);
  tag: String(100);
  active: Boolean;
  lastCheckedBlock: Integer64;
  network: String(20);
  events: Composition of many BlockchainEvent;
}

entity TransactionSubmission {
  key txHash: Blake2b256;
  description: String(500);
  active: Boolean;
  currentStatus: String(20);
  confirmations: Integer;
  network: String(20);
  events: Composition of many BlockchainEvent;
}

entity BlockchainEvent {
  key id: UUID;
  type: String(50);                          // TRANSACTION | CREDENTIAL_TRANSACTION
                                             // | ASSET_MINTED | ASSET_BURNED
                                             // | TRANSACTION_SUBMISSION
  blockHeight: Integer64;
  blockHash: Blake2b256;
  txHash: Blake2b256;
  address: Association to WatchedAddress;
  credential: Association to WatchedCredential;
  policy: Association to WatchedPolicy;
  submission: Association to TransactionSubmission;
  payload: LargeString;                      // JSON: per-event detail
  processed: Boolean;
  network: String(20);
  createdAt: Timestamp;
}

entity WatcherConfig { key configKey: String(100); value: LargeString; ... }
```

## Event Payloads

### `cardano.newTransactions`

```typescript
{
  address: string;
  tag?: string;
  count: number;
  transactions: string[];      // ascending by blockHeight
  utxosCreated: WatchedUtxo[]; // outputs at the watched address
  utxosSpent: SpentUtxoRef[];  // inputs from the watched address being spent
}
```

### `cardano.credential.newTransactions`

```typescript
{
  paymentCredHex: string;
  tag?: string;
  count: number;
  transactions: string[];
  utxosCreated: WatchedUtxo[];
  utxosSpent: SpentUtxoRef[];
  blockHeight: number;
}
```

### `cardano.policy.assetMinted` / `cardano.policy.assetBurned`

```typescript
{
  policyId: string;
  tag?: string;
  assetNameHex: string;
  quantity: string;             // magnitude; direction is in the event name
  txHash: string;
  blockHeight: number;
}
```

`WatchedUtxo`, `SpentUtxoRef`, `AssetFilterEntry` are exported from `@odatano/watch` for consumer use.

## Event Delivery Contract

The plugin emits via `cds.emit` on the standard CAP event bus. Read this before building stateful consumers.

### What we guarantee

- **One emit per poll batch, per watch.** A poll surfacing 5 new transactions produces one `cardano.newTransactions` event with `count: 5` and aggregated deltas — never one event per tx.
- **`transactions[]` ordered ascending by block height** within an emit.
- **`BlockchainEvent` rows persisted before the bus emit** — durable record. Reach via `getEventsSince` for replay.
- **Cursor advances atomically with persistence.** No half-state where a tx is emitted but the cursor didn't move.

### What we don't guarantee

- **No cross-handler ordering.** Multiple `cds.on` listeners run concurrently — race-prone for shared mutable state.
- **No retry on handler failure.** Throwing handlers are logged and forgotten; recover via replay.
- **No backpressure.** Slow handlers don't slow the watcher; long-running handlers see overlapping invocations.
- **No deduplication across processes.** Two CAP processes sharing the database both emit.
- **No rollback signal under the Blockfrost backend.** Orphans are invisible to Blockfrost. Phase 2 / Ogmios fixes this.

### Consumer guidance

For state-machine consumers:

1. **Make handlers idempotent.** Dedup on `txHash` (or `txHash + outputIndex` for UTxO ops).
2. **Sort by `blockHeight` if combining streams.**
3. **Persist your own cursor.** On restart, call `getEventsSince` before subscribing.
4. **Don't block the bus.** Push events onto an internal queue if your work is slow.
5. **Use `coalesceMs` for "latest state only" consumers** — pool oracles, peg trackers, etc.

### Replay

```typescript
const result = await admin.send('getEventsSince', {
  scope: 'address',           // 'address' | 'credential' | 'policy'
  key: 'addr_test1...',
  fromBlock: lastProcessedBlock,
  limit: 1000,                // default 1000, hard cap 10_000
});

for (const event of result.value) await replayHandler(event);
await persistCursor(scope, key, result.value.at(-1).blockHeight);
```

Replay returns **per-tx granularity** — one row per persisted `BlockchainEvent`. Aggregate yourself if you need the bus-shaped payload.

### Coalesce + replay interaction

When `coalesceMs` is set, `BlockchainEvent` rows persist **immediately** at poll time; only the bus emit is delayed until window flush. A consumer waking mid-window and calling `getEventsSince` will see events that haven't yet emitted on the bus. Persistence is source of truth.

### Phase 2 (preview)

Under the Ogmios backend:
- `cardano.rollback` becomes a real signal; persisted rows for orphaned txs are removed.
- Latency drops from poll-interval to block-interval (~20 s on mainnet).
- Cursor granularity becomes per-slot.
- Coalesce buffers are **dropped** (not flushed) on rollback — orphan deltas should not be emitted as confirmed.

## Admin Service

OData service at `/odata/v4/cardano-watcher-admin/`. Actions:

- Lifecycle: `startWatcher`, `stopWatcher`, `getWatcherStatus`
- Address: `addWatchedAddress`, `removeWatchedAddress`
- Credential: `addWatchedCredential`, `removeWatchedCredential`
- Policy: `addWatchedPolicy`, `removeWatchedPolicy`
- Transaction submission: `addWatchedTransaction`, `removeWatchedTransaction`
- Replay: `getEventsSince`

Entities (read-only projections): `WatchedAddresses`, `WatchedCredentials`, `WatchedPolicies`, `TransactionSubmissions`, `BlockchainEvents`, `WatcherConfigs`.

## Performance Notes

- Per-asset history walks make policy watching **O(assets × history)**. The `policyAssetCap` (default 100) refuses to poll high-asset NFT policies. Tx-block lookups are cached across assets within one poll.
- Credential resolution runs **once per poll** via Koios; large credentials with thousands of bech32 derivatives only pay the resolution cost once per cycle.
- Coalesce buffers are bounded only by the window size — a sufficiently busy address with `coalesceMs: 60_000` and 1000 txs/min will accumulate 1000-event payloads. Consumers should prefer shorter windows or no coalesce when batches matter.

**Recommended indexes** (the CDS layer creates the key indexes; add these for replay-heavy workloads):

```sql
CREATE INDEX idx_event_addr_block  ON BlockchainEvent (address_address, blockHeight);
CREATE INDEX idx_event_cred_block  ON BlockchainEvent (credential_paymentCredHex, blockHeight);
CREATE INDEX idx_event_policy_block ON BlockchainEvent (policy_policyId, blockHeight);
```

## Phase 2 Direction (preview)

The current architecture is purely Blockfrost/Koios polling. Phase 2 adds an Ogmios chainSync backend:

- **Single chain-sync stream**, single cursor — replaces the per-watch polling cursors with one process-wide point.
- **Native rollback** via the chainSync `RollBackward` message — emit `cardano.rollback`, rewind persisted `BlockchainEvent` rows past the rollback point, drop pending coalesce buffers.
- **Sub-block latency** (~20s on mainnet) instead of poll interval.
- **Slot-granularity cursors** (`BlockchainEvent.slot` column added).

Backends are intended to be primary-alternative — pick one per process; no auto-failover. See [IMPROVEMENTS.md](../IMPROVEMENTS.md) P6 + P7 for the full roadmap.
