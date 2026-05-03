# Quickstart — ODATANO-WATCH

Up and running in five minutes.

## Install

```bash
npm add @odatano/watch
```

> Use `npm add` (not `npm install`) for CAP plugins so the entry lands in `cds.requires`.

## Configure

Add to `package.json`. Address watching only:

```json
{
  "cds": {
    "requires": {
      "watch": {
        "network": "preview",
        "blockfrostApiKey": "preview_your_api_key_here",
        "autoStart": true
      }
    }
  }
}
```

Get a free Blockfrost key at [blockfrost.io](https://blockfrost.io/).

To enable credential or policy watching, opt in:

```json
{
  "cds": {
    "requires": {
      "watch": {
        "network": "preview",
        "blockfrostApiKey": "preview_...",
        "koiosApiKey": "",
        "autoStart": true,

        "credentialPolling": { "enabled": true, "interval": 60 },
        "policyPolling":     { "enabled": true, "interval": 60 }
      }
    }
  }
}
```

`koiosApiKey` is optional — Koios's free tier works without one. It's only needed for credential watching.

## Subscribe to Events

Create `srv/my-service.ts`:

```typescript
import cds from "@sap/cds";
import type {
  NewTransactionsEvent,
  CredentialNewTransactionsEvent,
  PolicyAssetMintedEvent,
  PolicyAssetBurnedEvent,
} from "@odatano/watch";

export default cds.service.impl(async function () {
  cds.on("cardano.newTransactions", async (e: NewTransactionsEvent) => {
    console.log(`${e.count} txs at ${e.address} (tag=${e.tag ?? "—"})`);
    for (const utxo of e.utxosCreated) {
      if (utxo.inlineDatumHex) await handleDatum(utxo.inlineDatumHex);
    }
  });

  cds.on("cardano.credential.newTransactions", async (e: CredentialNewTransactionsEvent) => {
    console.log(`${e.count} txs at credential ${e.paymentCredHex}`);
  });

  cds.on("cardano.policy.assetMinted", async (e: PolicyAssetMintedEvent) => {
    console.log(`+${e.quantity} of ${e.policyId}.${e.assetNameHex}`);
  });

  cds.on("cardano.policy.assetBurned", async (e: PolicyAssetBurnedEvent) => {
    console.log(`-${e.quantity} of ${e.policyId}.${e.assetNameHex}`);
  });
});
```

Read [README → Event Delivery Semantics](../README.md#event-delivery-semantics) before building anything stateful on top of these — there are guarantees you don't get (no cross-handler ordering, no retry, no backpressure) and a checklist of patterns to follow.

## Start

```bash
cds watch
```

You should see something like:

```
[ODATANO-WATCH] - Cardano Watcher initialized successfully
[ODATANO-WATCH] - Starting Cardano Watcher on preview network
[ODATANO-WATCH] - Starting address polling (interval: 30s)
```

## Add a Watch

```http
POST http://localhost:4004/odata/v4/cardano-watcher-admin/addWatchedAddress
Content-Type: application/json

{
  "address": "addr_test1qz...",
  "tag": "my-wallet"
}
```

Or watch a payment credential across every bech32 derivative:

```http
POST http://localhost:4004/odata/v4/cardano-watcher-admin/addWatchedCredential
Content-Type: application/json

{
  "paymentCredHex": "0805d8541db33f4841585fed4c3a7e87e2ff7018243038f06ceb660c",
  "tag": "indigo-cdp",
  "includesAssetsJson": "[{\"policyId\":\"...\",\"assetNameHex\":\"\"}]",
  "coalesceMs": 2000
}
```

Or track mint/burn for a minting policy:

```http
POST http://localhost:4004/odata/v4/cardano-watcher-admin/addWatchedPolicy
Content-Type: application/json

{
  "policyId": "8d18d786e92776c824607fd8e193ec535c79dc61ea2405ddf3b09fe3",
  "tag": "djed"
}
```

## Catch Up After Downtime

If your handler crashed or your service was offline, replay missed events:

```http
POST http://localhost:4004/odata/v4/cardano-watcher-admin/getEventsSince
Content-Type: application/json

{
  "scope": "address",
  "key": "addr_test1qz...",
  "fromBlock": 12345
}
```

Returns persisted `BlockchainEvent` rows ordered by `blockHeight`. Pass the last returned `blockHeight` as the next `fromBlock` for cursor pagination.

## Next Steps

- [README](../README.md) — full surface, event delivery semantics, configuration options.
- [Setup Guide](./SETUP.md) — production deployment, secrets, CI.
- [Architecture](./ARCHITECTURE.md) — technical internals.
