import cds, { Service } from "@sap/cds";
const { SELECT, INSERT, UPDATE } = cds.ql;
import { randomUUID } from "crypto";
import * as config from "./config";
import * as blockfrost from "./blockfrost";
import * as koios from "./koios";
import {
  parseAssetFilter,
  matchesAssetFilter,
} from "./blockfrost";
import {
  BlockchainEvent,
  WatchedAddresses,
  WatchedCredentials,
  WatchedPolicies,
  WatcherCursors,
} from "../@cds-models/CardanoWatcherAdminService";

const logger = cds.log("ODATANO-WATCH");

// ============================================================================
// Backfill orchestration (Phase 2)
// ============================================================================
//
// When the watcher runs in `backend: 'ogmios'` mode, chainSync delivers blocks
// from the persisted cursor onward — it never replays history. Newly-added
// watches would silently miss everything that happened before the cursor.
//
// Backfill closes that gap by running the existing Blockfrost-based fetch path
// once per new watch, capped at the chainSync cursor's block height. Rows
// produced by backfill are tagged `backend: 'blockfrost'` so the rollback
// rewinder (Batch 2B) leaves them alone — they're pre-cursor and outside the
// rollback window.

const CHAINSYNC_CURSOR_ID = "chainsync";

async function loadChainSyncCursorBlockHeight(): Promise<number | null> {
  // The WatcherCursor row stores a slot, not a block height. ChainSync's
  // canonical reference is slot. For Blockfrost backfill we want a block
  // height cap. Translate via Blockfrost: fetch the block at that slot.
  // For v0, we approximate: fetch latest tip from Blockfrost and use that
  // as an upper bound. This means backfill can race chainSync by a few
  // blocks at the boundary; consumers see at most a handful of duplicate
  // rows. Documented limitation; real fix needs a slot→block lookup.
  const cursor = await cds.db.run(
    SELECT.one.from(WatcherCursors).where({ id: CHAINSYNC_CURSOR_ID })
  );
  if (!cursor || cursor.slot == null) return null;
  // Best-effort: ask Blockfrost for the latest block; treat that as the cap.
  // ChainSync may have delivered a block since the cursor save, but bounding
  // backfill at "current blockchain tip" is a sane heuristic — it puts
  // backfill no further forward than what's canonical right now.
  const tip = await blockfrost.getLatestBlock();
  return tip?.height ?? null;
}

async function emit(event: string, payload: unknown): Promise<void> {
  try {
    await (cds as typeof cds & {
      emit: (event: string, data: unknown) => Promise<void>;
    }).emit(event, payload);
  } catch (err) {
    logger.warn(`Failed to emit ${event} during backfill:`, err);
  }
}

// ----------------------------------------------------------------------------
// Address backfill
// ----------------------------------------------------------------------------

export async function backfillAddress(address: string): Promise<void> {
  const cfg = config.get();
  const cap = await loadChainSyncCursorBlockHeight();
  if (cap == null) {
    logger.debug(`Address backfill skipped for ${address}: no chainSync cursor yet`);
    return;
  }

  logger.info(`Starting address backfill for ${address} up to block ${cap}`);
  const startedAt = Date.now();
  let totalProcessed = 0;
  let safetyIterations = 0;
  const SAFETY_CAP = 1000; // 1000 × 100-tx pages = 100k txs

  while (safetyIterations++ < SAFETY_CAP) {
    const watch = await cds.db.run(SELECT.one.from(WatchedAddresses).where({ address }));
    if (!watch) {
      logger.warn(`Address backfill aborted: ${address} no longer watched`);
      return;
    }
    const fromBlock: number | null = watch.lastCheckedBlock ?? null;
    if (fromBlock != null && fromBlock >= cap) break;

    const txs = await blockfrost.fetchAddressTransactions(address, fromBlock, cap);
    if (!txs || txs.length === 0) break;

    const filter = parseAssetFilter(watch.includesAssetsJson);
    const matching = filter === null
      ? txs
      : txs.filter(t => matchesAssetFilter(t.utxosCreated, filter));

    const maxBlock = Math.max(...txs.map(t => t.blockHeight));

    await cds.db.tx(async (tx: Service) => {
      for (const t of matching) {
        await tx.run(INSERT.into(BlockchainEvent).entries({
          id: randomUUID(),
          type: "TRANSACTION",
          blockHeight: t.blockHeight,
          blockHash: t.blockHash,
          backend: "blockfrost",
          txHash: t.txHash,
          address_address: address,
          payload: JSON.stringify(t),
          network: cfg.network,
          processed: false,
        } as BlockchainEvent));
      }
      await tx.run(UPDATE.entity(WatchedAddresses)
        .set({ lastCheckedBlock: maxBlock })
        .where({ address }));
    });

    if (matching.length > 0) {
      await emit("cardano.newTransactions", {
        address,
        tag: watch.tag ?? undefined,
        count: matching.length,
        transactions: matching.map(t => t.txHash),
        utxosCreated: matching.flatMap(t => t.utxosCreated),
        utxosSpent: matching.flatMap(t => t.utxosSpent),
      });
    }
    totalProcessed += matching.length;
  }

  logger.info(
    `Address backfill complete for ${address}: ${totalProcessed} matching txs in ${Date.now() - startedAt}ms`
  );
}

// ----------------------------------------------------------------------------
// Credential backfill
// ----------------------------------------------------------------------------

export async function backfillCredential(paymentCredHex: string): Promise<void> {
  const cfg = config.get();
  if (!koios.isAvailable()) {
    logger.warn(`Credential backfill skipped for ${paymentCredHex}: Koios not initialized`);
    return;
  }
  const cap = await loadChainSyncCursorBlockHeight();
  if (cap == null) {
    logger.debug(`Credential backfill skipped for ${paymentCredHex}: no chainSync cursor yet`);
    return;
  }

  logger.info(`Starting credential backfill for ${paymentCredHex} up to block ${cap}`);
  const startedAt = Date.now();

  const watch = await cds.db.run(SELECT.one.from(WatchedCredentials).where({ paymentCredHex }));
  if (!watch) return;

  const addresses = await koios.getAddressesByCredential(paymentCredHex);
  if (addresses.length === 0) {
    logger.debug(`No addresses resolved for credential ${paymentCredHex}; backfill ends`);
    return;
  }
  const addressSet = new Set(addresses);

  // Koios paginates and returns all rows since `_after_block_height`. Filter
  // client-side at the cap.
  const credTxs = await koios.getCredentialTxsSince(paymentCredHex, watch.lastCheckedBlock ?? null);
  const newTxs = credTxs
    .filter(t => watch.lastCheckedBlock == null || t.blockHeight > watch.lastCheckedBlock)
    .filter(t => t.blockHeight <= cap);

  if (newTxs.length === 0) {
    logger.info(`Credential backfill complete for ${paymentCredHex}: nothing new`);
    return;
  }

  const filter = parseAssetFilter(watch.includesAssetsJson);
  const aggregatedCreated: ReturnType<typeof parseAssetFilter> extends infer _ ? import('./blockfrost').WatchedUtxo[] : never = [];
  const aggregatedSpent: import('./blockfrost').SpentUtxoRef[] = [];
  const matchedTxs: typeof newTxs = [];
  let maxBlock = watch.lastCheckedBlock ?? 0;

  for (const t of newTxs) {
    const deltas = await blockfrost.fetchTxUtxos(t.txHash, addressSet);
    if (!deltas) continue;
    if (!matchesAssetFilter(deltas.utxosCreated, filter)) {
      if (t.blockHeight > maxBlock) maxBlock = t.blockHeight;
      continue;
    }
    aggregatedCreated.push(...deltas.utxosCreated);
    aggregatedSpent.push(...deltas.utxosSpent);
    matchedTxs.push(t);
    if (t.blockHeight > maxBlock) maxBlock = t.blockHeight;
  }

  await cds.db.tx(async (tx: Service) => {
    for (const t of matchedTxs) {
      await tx.run(INSERT.into(BlockchainEvent).entries({
        id: randomUUID(),
        type: "CREDENTIAL_TRANSACTION",
        blockHeight: t.blockHeight,
        backend: "blockfrost",
        txHash: t.txHash,
        credential_paymentCredHex: paymentCredHex,
        payload: JSON.stringify(t),
        network: cfg.network,
        processed: false,
      } as BlockchainEvent));
    }
    await tx.run(UPDATE.entity(WatchedCredentials)
      .set({ lastCheckedBlock: maxBlock })
      .where({ paymentCredHex }));
  });

  if (matchedTxs.length > 0) {
    await emit("cardano.credential.newTransactions", {
      paymentCredHex,
      tag: watch.tag ?? undefined,
      count: matchedTxs.length,
      transactions: matchedTxs.map(t => t.txHash),
      utxosCreated: aggregatedCreated,
      utxosSpent: aggregatedSpent,
      blockHeight: maxBlock,
    });
  }

  logger.info(
    `Credential backfill complete for ${paymentCredHex}: ${matchedTxs.length} matching txs in ${Date.now() - startedAt}ms`
  );
}

// ----------------------------------------------------------------------------
// Policy backfill
// ----------------------------------------------------------------------------

export async function backfillPolicy(policyId: string): Promise<void> {
  const cfg = config.get();
  const cap = await loadChainSyncCursorBlockHeight();
  if (cap == null) {
    logger.debug(`Policy backfill skipped for ${policyId}: no chainSync cursor yet`);
    return;
  }

  logger.info(`Starting policy backfill for ${policyId} up to block ${cap}`);
  const startedAt = Date.now();

  const watch = await cds.db.run(SELECT.one.from(WatchedPolicies).where({ policyId }));
  if (!watch) return;

  const events = await blockfrost.fetchPolicyAssetEvents(
    policyId,
    watch.lastCheckedBlock ?? null,
    cfg.policyAssetCap ?? 100,
    cap,
  );
  if (events === null) return; // cap exceeded
  if (events.length === 0) {
    logger.info(`Policy backfill complete for ${policyId}: nothing new`);
    return;
  }

  const maxBlock = events.reduce((m, e) => (e.blockHeight > m ? e.blockHeight : m), watch.lastCheckedBlock ?? 0);

  await cds.db.tx(async (tx: Service) => {
    for (const ev of events) {
      await tx.run(INSERT.into(BlockchainEvent).entries({
        id: randomUUID(),
        type: ev.action === "minted" ? "ASSET_MINTED" : "ASSET_BURNED",
        blockHeight: ev.blockHeight,
        backend: "blockfrost",
        txHash: ev.txHash,
        policy_policyId: policyId,
        payload: JSON.stringify(ev),
        network: cfg.network,
        processed: false,
      } as BlockchainEvent));
    }
    await tx.run(UPDATE.entity(WatchedPolicies)
      .set({ lastCheckedBlock: maxBlock })
      .where({ policyId }));
  });

  for (const ev of events) {
    await emit(
      ev.action === "minted" ? "cardano.policy.assetMinted" : "cardano.policy.assetBurned",
      {
        policyId: ev.policyId,
        tag: watch.tag ?? undefined,
        assetNameHex: ev.assetNameHex,
        quantity: ev.quantity,
        txHash: ev.txHash,
        blockHeight: ev.blockHeight,
      },
    );
  }

  logger.info(
    `Policy backfill complete for ${policyId}: ${events.length} events in ${Date.now() - startedAt}ms`
  );
}
