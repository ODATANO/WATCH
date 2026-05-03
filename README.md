# ODATANO-WATCH

[![npm version](https://badge.fury.io/js/@odatano%2Fwatch.svg)](https://www.npmjs.com/package/@odatano/watch)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![CAP](https://img.shields.io/badge/SAP%20CAP-9.0%2B-orange)](https://cap.cloud.sap/)
[![Tests](https://github.com/ODATANO/ODATANO-WATCH/actions/workflows/test.yml/badge.svg)](https://github.com/ODATANO/ODATANO-WATCH/actions/workflows/test.yml)

CAP plugin for monitoring the Cardano blockchain. Watches addresses, payment credentials, and minting policies; emits events with rich UTxO payloads (assets, inline datums, reference scripts) and persists them for replay.

📚 **Docs**: [Quick Start](docs/QUICKSTART.md) · [Setup](docs/SETUP.md) · [Architecture](docs/ARCHITECTURE.md)

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

Full action list and entity surface in [Quick Start](docs/QUICKSTART.md) and [Architecture](docs/ARCHITECTURE.md).

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

Apache-2.0
