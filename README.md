# ODATANO-WATCH

[![Tests](https://github.com/ODATANO/ODATANO-WATCH/actions/workflows/test.yml/badge.svg)](https://github.com/ODATANO/ODATANO-WATCH/actions/workflows/test.yml)
[![Coverage](https://codecov.io/gh/ODATANO/WATCH/branch/main/graph/badge.svg)](https://codecov.io/gh/ODATANO/WATCH)
[![npm](https://img.shields.io/npm/v/@odatano/watch?color=blue&logo=npm)](https://www.npmjs.com/package/@odatano/watch)
[![npm downloads](https://img.shields.io/npm/dt/@odatano/watch?logo=npm&label=downloads&color=blue)](https://www.npmjs.com/package/@odatano/watch)
[![License](https://img.shields.io/badge/license-Apache%202.0-yellow)](LICENSE)


CAP plugin for monitoring the Cardano blockchain. Watches addresses, payment credentials, and minting policies; emits events with rich UTxO payloads (assets, inline datums, reference scripts) and persists them for replay.

## Install

```bash
npm add @odatano/watch
```

## Configure

`package.json`:

```json
{
  "cds": {
    "requires": {
      "watch": {
        "network": "preview",
        "blockfrostApiKey": "preview_YOUR_KEY",
        "autoStart": true
      }
    }
  }
}
```

Credential and policy watching are off by default — opt in via `credentialPolling` / `policyPolling`. Credential watching also needs a (free-tier-OK) Koios endpoint. See [Quick Start](docs/QUICKSTART.md) for the full config.

### Secrets via environment variables

To keep the API key out of `package.json`, leave the field unset and export the env var instead — the plugin picks it up as a fallback:

```json
{ "cds": { "requires": { "watch": { "network": "preview" } } } }
```
```bash
export BLOCKFROST_API_KEY=preview_YOUR_KEY
```

Other recognized env vars: `BLOCKFROST_CUSTOM_BACKEND`, `KOIOS_API_KEY`, `OGMIOS_URL`, `WATCHER_BACKEND`. `cds.env.requires.watch.<field>` always wins when set.

### Self-hosted Blockfrost (Dolos / cardano-node)

Polling burns through the Blockfrost free-tier daily quota quickly. To route the SDK at a self-hosted Blockfrost-compatible endpoint instead, set `blockfrostCustomBackend` (and drop `blockfrostApiKey`):

```json
{
  "cds": {
    "requires": {
      "watch": {
        "network": "mainnet",
        "blockfrostCustomBackend": "http://localhost:3100/api/v0",
        "credentialPolling": { "enabled": true, "interval": 30 }
      }
    }
  }
}
```

`http://localhost:3100/api/v0` is the default for [Dolos](https://github.com/txpipe/dolos)'s MiniBF. Equivalent env var: `BLOCKFROST_CUSTOM_BACKEND`. Public Blockfrost stays the default when this field is unset.

## Subscribe to events

```typescript
import type {
  NewTransactionsEvent,
  CredentialNewTransactionsEvent,
  PolicyAssetMintedEvent,
} from "@odatano/watch";

cds.on("cardano.newTransactions", async (e: NewTransactionsEvent) => {
  // e.address, e.tag?, e.transactions[], e.utxosCreated[], e.utxosSpent[]
  for (const utxo of e.utxosCreated) {
    if (utxo.inlineDatumHex) await applyDatum(utxo.inlineDatumHex);
  }
});

cds.on("cardano.credential.newTransactions", async (e: CredentialNewTransactionsEvent) => { /* ... */ });
cds.on("cardano.policy.assetMinted", async (e: PolicyAssetMintedEvent) => { /* ... */ });
```

Other emitted events: `cardano.policy.assetBurned`, and (Phase 2 / Ogmios only) `cardano.rollback`.

> Read [Event Delivery Semantics](docs/ARCHITECTURE.md#event-delivery-contract) before building stateful consumers — there are guarantees we **don't** make (no cross-handler ordering, no retry, no backpressure) and a checklist of patterns to follow.

## Add a watch

```http
POST /odata/v4/cardano-watcher-admin/addWatchedAddress
Content-Type: application/json

{
  "address": "addr_test1...",
  "tag": "my-pool",
  "includesAssetsJson": "[{\"policyId\":\"...\",\"assetNameHex\":\"\"}]",
  "coalesceMs": 2000
}
```

Plus `addWatchedCredential`, `addWatchedPolicy`, `removeWatched*`. Optional fields:
- `tag` — echoed back on each emit for dispatch routing.
- `includesAssetsJson` — asset allowlist; non-matching txs are skipped.
- `coalesceMs` — batch bus emits into one event per window with cumulative deltas (1 – 300_000).


## Docs 
- [Quick Start](docs/QUICKSTART.md)
- [Setup](docs/SETUP.md)
- [Architecture](docs/ARCHITECTURE.md)


## Replay missed events

```http
POST /odata/v4/cardano-watcher-admin/getEventsSince
Content-Type: application/json

{ "scope": "address", "key": "addr_test1...", "fromBlock": 12345 }
```

Returns persisted `BlockchainEvent` rows ordered by `blockHeight` asc. Use the last returned `blockHeight` as the next call's `fromBlock` for cursor pagination.

## Phase 2 — Ogmios chainSync

Set `backend: 'ogmios'` and `ogmiosUrl: 'ws://localhost:1337'` to switch from polling to a chainSync stream with native rollback signal. Backfill from Blockfrost runs once per new watch. See [Architecture → Phase 2](docs/ARCHITECTURE.md#phase-2-direction-preview) for caveats.

## License

[Apache-2.0](LICENSE)
