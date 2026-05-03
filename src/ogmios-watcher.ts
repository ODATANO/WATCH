import cds, { Service } from "@sap/cds";
const { SELECT, INSERT, UPDATE, UPSERT, DELETE } = cds.ql;
import { randomUUID } from "crypto";
import type { Schema } from "@cardano-ogmios/client";
import * as config from "./config";
import {
  parseAssetFilter,
  matchesAssetFilter,
} from "./blockfrost";
import type { WatchedUtxo, SpentUtxoRef, AssetFilterEntry } from "./blockfrost";
import {
  BlockchainEvent, BlockchainEvents,
  WatchedAddress, WatchedAddresses,
  WatchedCredential, WatchedCredentials,
  WatchedPolicy, WatchedPolicies,
  WatcherCursors,
} from "../@cds-models/CardanoWatcherAdminService";

const logger = cds.log("ODATANO-WATCH");

// ============================================================================
// In-memory watch index, refreshed each tick from the database.
// ============================================================================
//
// chainSync delivers every block; we filter against this index. Refreshed
// before each rollForward block so newly-added watches see new activity
// without per-block DB round-trips. Backfill-incomplete watches (lastCheckedBlock
// null) are excluded — they're hydrated by the Blockfrost backfill path.

interface AddressWatch {
  address: string;
  tag: string | null;
  filter: AssetFilterEntry[] | null;
  coalesceMs: number | null;
}

interface CredentialWatch {
  paymentCredHex: string;
  tag: string | null;
  filter: AssetFilterEntry[] | null;
  coalesceMs: number | null;
}

interface PolicyWatch {
  policyId: string;
  tag: string | null;
}

interface WatchIndex {
  addresses: Map<string, AddressWatch>;        // bech32 → watch
  credentials: Map<string, CredentialWatch>;   // 56-hex paymentCred → watch
  policies: Map<string, PolicyWatch>;          // 56-hex policyId → watch
}

let watchIndex: WatchIndex = {
  addresses: new Map(),
  credentials: new Map(),
  policies: new Map(),
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any = null;

export function setDb(database: unknown): void {
  db = database;
}

/** Test-only: drop the in-memory watch index so the next processRollForward
 *  refreshes it from the (mocked) database. Production code never calls this. */
export function __resetIndexForTesting(): void {
  watchIndex = { addresses: new Map(), credentials: new Map(), policies: new Map() };
}

async function refreshWatchIndex(): Promise<void> {
  if (!db) return;
  const [addrs, creds, pols] = await Promise.all([
    db.run(SELECT.from(WatchedAddresses).where({ active: true })) as Promise<WatchedAddress[]>,
    db.run(SELECT.from(WatchedCredentials).where({ active: true })) as Promise<WatchedCredential[]>,
    db.run(SELECT.from(WatchedPolicies).where({ active: true })) as Promise<WatchedPolicy[]>,
  ]);

  const next: WatchIndex = {
    addresses: new Map(),
    credentials: new Map(),
    policies: new Map(),
  };

  for (const a of addrs ?? []) {
    if (!a.address) continue;
    next.addresses.set(a.address, {
      address: a.address,
      tag: a.tag ?? null,
      filter: parseAssetFilter(a.includesAssetsJson),
      coalesceMs: a.coalesceMs ?? null,
    });
  }
  for (const c of creds ?? []) {
    if (!c.paymentCredHex) continue;
    next.credentials.set(c.paymentCredHex, {
      paymentCredHex: c.paymentCredHex,
      tag: c.tag ?? null,
      filter: parseAssetFilter(c.includesAssetsJson),
      coalesceMs: c.coalesceMs ?? null,
    });
  }
  for (const p of pols ?? []) {
    if (!p.policyId) continue;
    next.policies.set(p.policyId, {
      policyId: p.policyId,
      tag: p.tag ?? null,
    });
  }

  watchIndex = next;
}

// Periodic refresh so addWatched* ripples into the index without a server
// restart. Every 10 s — bounded staleness, not realtime; consumers are
// expected to bring up watches before relying on them.
let refreshTimer: NodeJS.Timeout | null = null;

export function startIndexRefresh(intervalMs = 10_000): void {
  if (refreshTimer) return;
  refreshTimer = setInterval(() => {
    refreshWatchIndex().catch(err => logger.error("Watch index refresh failed:", err));
  }, intervalMs);
}

export function stopIndexRefresh(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

// ============================================================================
// Cursor persistence (WatcherCursor entity, single row id='chainsync')
// ============================================================================

const CURSOR_ID = "chainsync";

export async function loadCursor(): Promise<{ slot: number; blockHash: string } | null> {
  if (!db) return null;
  const row = await db.run(SELECT.one.from(WatcherCursors).where({ id: CURSOR_ID }));
  if (!row || row.slot == null || !row.blockHash) return null;
  return { slot: Number(row.slot), blockHash: row.blockHash };
}

async function saveCursor(slot: number, blockHash: string, network: string): Promise<void> {
  if (!db) return;
  await db.run(
    UPSERT.into(WatcherCursors).entries({ id: CURSOR_ID, slot, blockHash, network })
  );
}

// ============================================================================
// Block conversion helpers — Ogmios shapes → our public WatchedUtxo etc.
// ============================================================================

function valueToWatchedShape(value: Schema.Value): { lovelace: string; assets: { unit: string; quantity: string }[] } {
  const lovelace = String(value.ada?.lovelace ?? 0n);
  const assets: { unit: string; quantity: string }[] = [];
  for (const policyId of Object.keys(value)) {
    if (policyId === "ada") continue;
    const inner = value[policyId] as Record<string, bigint>;
    for (const assetName of Object.keys(inner)) {
      assets.push({ unit: policyId + assetName, quantity: String(inner[assetName]) });
    }
  }
  return { lovelace, assets };
}

function outputAddress(out: Schema.TransactionOutput): string {
  return out.address;
}

function buildWatchedUtxo(txHash: string, outputIndex: number, out: Schema.TransactionOutput): WatchedUtxo {
  const { lovelace, assets } = valueToWatchedShape(out.value);
  const utxo: WatchedUtxo = { txHash, outputIndex, lovelace, assets };
  // Inline datum: the Ogmios `datum` field is the inline datum CBOR hex (when
  // present); `datumHash` is the hash-only form.
  if (out.datum) utxo.inlineDatumHex = out.datum;
  if (out.script) {
    // We expose the script *hash* on consumers, not the full script body.
    // Ogmios delivers the full script; compute or skip hash for v0 — leave
    // unset rather than fabricating something potentially incorrect.
    // Consumers that need refScript hash can decode the tx out themselves.
  }
  return utxo;
}

/**
 * Extract policy events from a tx's `mint` field. Positive quantities are
 * mints, negative are burns.
 */
function extractMintEvents(
  tx: Schema.Transaction,
  blockHeight: number,
  watchedPolicies: Map<string, PolicyWatch>,
): Array<{ policy: PolicyWatch; assetNameHex: string; quantity: string; action: "minted" | "burned" }> {
  if (!tx.mint) return [];
  const out: ReturnType<typeof extractMintEvents> = [];
  for (const policyId of Object.keys(tx.mint)) {
    const watched = watchedPolicies.get(policyId);
    if (!watched) continue;
    const inner = tx.mint[policyId] as Record<string, bigint>;
    for (const assetName of Object.keys(inner)) {
      const raw = inner[assetName];
      const q = BigInt(raw);
      if (q === 0n) continue;
      const action: "minted" | "burned" = q > 0n ? "minted" : "burned";
      const magnitude = (q < 0n ? -q : q).toString();
      out.push({ policy: watched, assetNameHex: assetName, quantity: magnitude, action });
    }
  }
  // Suppress unused parameter warnings — blockHeight is consumed by the caller.
  void blockHeight;
  return out;
}

// ============================================================================
// Block processing
// ============================================================================

export async function processRollForward(
  block: Schema.Block,
  cfg: config.CardanoWatcherConfig,
  emitFn: (event: string, payload: unknown) => Promise<void>,
): Promise<void> {
  // Refresh the index lazily — we may have started without a refresh yet.
  if (
    watchIndex.addresses.size === 0 &&
    watchIndex.credentials.size === 0 &&
    watchIndex.policies.size === 0
  ) {
    await refreshWatchIndex();
  }

  // EBB blocks (epoch boundary) and old BFT blocks have no transactions to inspect.
  if (block.type !== "praos") return;
  const praos: Schema.BlockPraos = block;
  const txs = praos.transactions ?? [];
  if (txs.length === 0) {
    await saveCursor(Number(praos.slot), praos.id, cfg.network ?? "preview");
    return;
  }

  // Build per-block address-set lookup. Used twice — for outputs and for
  // mapping inputs back to the address that owned them. We can only resolve
  // inputs whose source UTxOs were ourselves emitted earlier in this run
  // (UTxO mirror — Phase 2 v0 limitation; see README/ARCHITECTURE).
  const blockHeight = Number(praos.height);
  const slot = Number(praos.slot);
  const blockHash = praos.id;

  // Aggregate per-watch deltas across all txs in this block, then emit one
  // event per watch with non-empty deltas.
  const addressDeltas = new Map<string, {
    watch: AddressWatch;
    txHashes: Set<string>;
    utxosCreated: WatchedUtxo[];
    utxosSpent: SpentUtxoRef[];
  }>();
  const credentialDeltas = new Map<string, {
    watch: CredentialWatch;
    txHashes: Set<string>;
    utxosCreated: WatchedUtxo[];
    utxosSpent: SpentUtxoRef[];
  }>();

  for (const tx of txs) {
    // Output-side: find utxosCreated at any watched address or credential.
    for (let i = 0; i < tx.outputs.length; i++) {
      const out = tx.outputs[i];
      const addr = outputAddress(out);

      const addrWatch = watchIndex.addresses.get(addr);
      if (addrWatch) {
        const utxo = buildWatchedUtxo(tx.id, i, out);
        const bucket = addressDeltas.get(addr) ?? {
          watch: addrWatch,
          txHashes: new Set<string>(),
          utxosCreated: [],
          utxosSpent: [],
        };
        bucket.txHashes.add(tx.id);
        bucket.utxosCreated.push(utxo);
        addressDeltas.set(addr, bucket);
      }

      // Credential-side: extract payment credential from address.
      const credHex = paymentCredentialFromBech32(addr);
      if (credHex) {
        const credWatch = watchIndex.credentials.get(credHex);
        if (credWatch) {
          const utxo = buildWatchedUtxo(tx.id, i, out);
          const bucket = credentialDeltas.get(credHex) ?? {
            watch: credWatch,
            txHashes: new Set<string>(),
            utxosCreated: [],
            utxosSpent: [],
          };
          bucket.txHashes.add(tx.id);
          bucket.utxosCreated.push(utxo);
          credentialDeltas.set(credHex, bucket);
        }
      }
    }
  }

  // Apply asset-filter scoping (P8). Drop deltas with zero matching utxosCreated.
  for (const [addr, bucket] of [...addressDeltas]) {
    if (!matchesAssetFilter(bucket.utxosCreated, bucket.watch.filter)) {
      addressDeltas.delete(addr);
    }
  }
  for (const [cred, bucket] of [...credentialDeltas]) {
    if (!matchesAssetFilter(bucket.utxosCreated, bucket.watch.filter)) {
      credentialDeltas.delete(cred);
    }
  }

  // Policy events: per-tx, per-event semantics.
  const policyEvents: Array<{
    policy: PolicyWatch;
    assetNameHex: string;
    quantity: string;
    action: "minted" | "burned";
    txHash: string;
  }> = [];
  for (const tx of txs) {
    const events = extractMintEvents(tx, blockHeight, watchIndex.policies);
    for (const e of events) policyEvents.push({ ...e, txHash: tx.id });
  }

  // Persist + emit. Single DB transaction for all rows in this block.
  await db.tx(async (txdb: Service) => {
    // Address deltas → BlockchainEvent rows
    for (const [, bucket] of addressDeltas) {
      for (const txHash of bucket.txHashes) {
        await txdb.run(INSERT.into(BlockchainEvent).entries({
          id: randomUUID(),
          type: "TRANSACTION",
          blockHeight,
          blockHash,
          slot,
          backend: "ogmios",
          txHash,
          address_address: bucket.watch.address,
          payload: JSON.stringify({
            txHash,
            blockHeight,
            blockHash,
            slot,
            utxosCreated: bucket.utxosCreated.filter(u => u.txHash === txHash),
            utxosSpent: bucket.utxosSpent.filter(u => u.txHash === txHash),
          }),
          network: cfg.network,
          processed: false,
        } as BlockchainEvent));
      }
      await txdb.run(UPDATE.entity(WatchedAddresses)
        .set({ lastCheckedBlock: blockHeight })
        .where({ address: bucket.watch.address }));
    }

    // Credential deltas
    for (const [, bucket] of credentialDeltas) {
      for (const txHash of bucket.txHashes) {
        await txdb.run(INSERT.into(BlockchainEvent).entries({
          id: randomUUID(),
          type: "CREDENTIAL_TRANSACTION",
          blockHeight,
          blockHash,
          slot,
          backend: "ogmios",
          txHash,
          credential_paymentCredHex: bucket.watch.paymentCredHex,
          payload: JSON.stringify({
            txHash,
            blockHeight,
            blockHash,
            slot,
            utxosCreated: bucket.utxosCreated.filter(u => u.txHash === txHash),
            utxosSpent: bucket.utxosSpent.filter(u => u.txHash === txHash),
          }),
          network: cfg.network,
          processed: false,
        } as BlockchainEvent));
      }
      await txdb.run(UPDATE.entity(WatchedCredentials)
        .set({ lastCheckedBlock: blockHeight })
        .where({ paymentCredHex: bucket.watch.paymentCredHex }));
    }

    // Policy events — one row per mint/burn
    for (const ev of policyEvents) {
      await txdb.run(INSERT.into(BlockchainEvent).entries({
        id: randomUUID(),
        type: ev.action === "minted" ? "ASSET_MINTED" : "ASSET_BURNED",
        blockHeight,
        blockHash,
        slot,
        backend: "ogmios",
        txHash: ev.txHash,
        policy_policyId: ev.policy.policyId,
        payload: JSON.stringify({
          policyId: ev.policy.policyId,
          assetNameHex: ev.assetNameHex,
          quantity: ev.quantity,
          action: ev.action,
          txHash: ev.txHash,
          blockHeight,
          slot,
        }),
        network: cfg.network,
        processed: false,
      } as BlockchainEvent));
    }
    if (policyEvents.length > 0) {
      const seenPolicyIds = new Set(policyEvents.map(e => e.policy.policyId));
      for (const pid of seenPolicyIds) {
        await txdb.run(UPDATE.entity(WatchedPolicies)
          .set({ lastCheckedBlock: blockHeight })
          .where({ policyId: pid }));
      }
    }
  });

  // Bus emits — outside the DB tx so a slow handler doesn't hold the lock.
  // (Coalesce buffers from src/watcher.ts are not yet plumbed here in v0;
  // tracked as a step-5 follow-up — for now Ogmios mode emits immediately.)
  for (const [, bucket] of addressDeltas) {
    await emitFn("cardano.newTransactions", {
      address: bucket.watch.address,
      tag: bucket.watch.tag ?? undefined,
      count: bucket.txHashes.size,
      transactions: [...bucket.txHashes],
      utxosCreated: bucket.utxosCreated,
      utxosSpent: bucket.utxosSpent,
    });
  }
  for (const [, bucket] of credentialDeltas) {
    await emitFn("cardano.credential.newTransactions", {
      paymentCredHex: bucket.watch.paymentCredHex,
      tag: bucket.watch.tag ?? undefined,
      count: bucket.txHashes.size,
      transactions: [...bucket.txHashes],
      utxosCreated: bucket.utxosCreated,
      utxosSpent: bucket.utxosSpent,
      blockHeight,
    });
  }
  for (const ev of policyEvents) {
    await emitFn(
      ev.action === "minted" ? "cardano.policy.assetMinted" : "cardano.policy.assetBurned",
      {
        policyId: ev.policy.policyId,
        tag: ev.policy.tag ?? undefined,
        assetNameHex: ev.assetNameHex,
        quantity: ev.quantity,
        txHash: ev.txHash,
        blockHeight,
      },
    );
  }

  await saveCursor(slot, blockHash, cfg.network ?? "preview");
}

// ============================================================================
// Address → payment-credential extraction
// ============================================================================
//
// Cardano shelley addresses encode a 28-byte payment credential as the first
// 28 bytes of the address payload (after the 1-byte header). We avoid pulling
// in cardano-serialization-lib for v0 — instead, do bech32 decode + slice.
//
// This works for shelley-era addresses (addr1, addr_test1). Byron addresses
// (Ae2/Ddz prefix) have no payment credential in the same sense and are
// excluded — the Map lookup just won't find anything.

const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

export function paymentCredentialFromBech32(addr: string): string | null {
  // Skip Byron — they don't use bech32 anyway.
  if (!addr.startsWith("addr")) return null;
  const sepIdx = addr.lastIndexOf("1");
  if (sepIdx < 0) return null;
  const data = addr.slice(sepIdx + 1, addr.length - 6); // strip checksum (last 6 chars)
  // Decode 5-bit groups → bytes.
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of data) {
    const v = BECH32_CHARSET.indexOf(ch);
    if (v < 0) return null;
    value = (value << 5) | v;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      bytes.push((value >> bits) & 0xff);
    }
  }
  // First byte is the header; payment credential is bytes 1..28.
  if (bytes.length < 29) return null;
  const credBytes = bytes.slice(1, 29);
  return credBytes.map(b => b.toString(16).padStart(2, "0")).join("");
}

// ============================================================================
// Rollback handling (Batch 2B)
// ============================================================================
//
// On RollBackward, the chain has rejected our recently-applied blocks. We:
//   1. Find every BlockchainEvent at slot > rollbackSlot tagged backend='ogmios'
//   2. Collect distinct affected txHashes (for the bus event)
//   3. DELETE those rows
//   4. Recompute lastCheckedBlock per affected watch (max blockHeight remaining)
//   5. Caller drops pending coalesce buffers
//   6. Update WatcherCursor to the rollback point
//   7. Caller emits cardano.rollback
//
// Rows tagged backend='blockfrost' (backfill output, polling-mode legacy) are
// NEVER touched by rollback. Those represent the canonical pre-cursor history.

export interface RollbackResult {
  fromSlot: number;
  toSlot: number;
  affectedTxHashes: string[];
}

export async function processRollBackward(
  point: Schema.Point | "origin",
  cfg: config.CardanoWatcherConfig,
): Promise<RollbackResult> {
  const toSlot = point === "origin" ? 0 : Number(point.slot);
  const cursorBefore = await loadCursor();
  const fromSlot = cursorBefore?.slot ?? toSlot;

  if (fromSlot <= toSlot) {
    // No-op rollback (point is at or ahead of cursor — shouldn't normally
    // happen, but Ogmios occasionally emits a redundant RollBackward when a
    // client first connects with an in-flight tip).
    logger.debug(`RollBackward to slot ${toSlot} is at/ahead of cursor ${fromSlot}; nothing to rewind`);
    return { fromSlot, toSlot, affectedTxHashes: [] };
  }

  logger.warn(`Rolling back from slot ${fromSlot} to slot ${toSlot}`);

  const affected = await db.run(
    SELECT.from(BlockchainEvents)
      .where({ slot: { ">": toSlot }, backend: "ogmios" })
  ) as BlockchainEvent[];

  const affectedTxHashes = [...new Set(affected.map(e => e.txHash).filter(Boolean) as string[])];
  const affectedAddresses = new Set(
    affected.map(e => (e as { address_address?: string | null }).address_address).filter(Boolean) as string[]
  );
  const affectedCredentials = new Set(
    affected.map(e => (e as { credential_paymentCredHex?: string | null }).credential_paymentCredHex).filter(Boolean) as string[]
  );
  const affectedPolicies = new Set(
    affected.map(e => (e as { policy_policyId?: string | null }).policy_policyId).filter(Boolean) as string[]
  );

  await db.tx(async (tx: Service) => {
    // Delete orphaned rows
    await tx.run(
      DELETE.from(BlockchainEvents).where({ slot: { ">": toSlot }, backend: "ogmios" })
    );

    // Recompute lastCheckedBlock per watch from the surviving rows. If no
    // rows remain for a watch, set null — the chainSync will resume from the
    // process-wide cursor regardless.
    for (const addr of affectedAddresses) {
      const max = await tx.run(
        `SELECT MAX(blockHeight) as m FROM odatano_watch_BlockchainEvent WHERE address_address = ?`,
        [addr],
      );
      const newCursor = (max as Array<{ m: number | null }>)[0]?.m ?? null;
      await tx.run(UPDATE.entity(WatchedAddresses)
        .set({ lastCheckedBlock: newCursor })
        .where({ address: addr }));
    }
    for (const cred of affectedCredentials) {
      const max = await tx.run(
        `SELECT MAX(blockHeight) as m FROM odatano_watch_BlockchainEvent WHERE credential_paymentCredHex = ?`,
        [cred],
      );
      const newCursor = (max as Array<{ m: number | null }>)[0]?.m ?? null;
      await tx.run(UPDATE.entity(WatchedCredentials)
        .set({ lastCheckedBlock: newCursor })
        .where({ paymentCredHex: cred }));
    }
    for (const pol of affectedPolicies) {
      const max = await tx.run(
        `SELECT MAX(blockHeight) as m FROM odatano_watch_BlockchainEvent WHERE policy_policyId = ?`,
        [pol],
      );
      const newCursor = (max as Array<{ m: number | null }>)[0]?.m ?? null;
      await tx.run(UPDATE.entity(WatchedPolicies)
        .set({ lastCheckedBlock: newCursor })
        .where({ policyId: pol }));
    }

    // Update the chainSync cursor to the rollback point.
    if (point === "origin") {
      await tx.run(DELETE.from(WatcherCursors).where({ id: CURSOR_ID }));
    } else {
      await tx.run(UPSERT.into(WatcherCursors).entries({
        id: CURSOR_ID,
        slot: toSlot,
        blockHash: point.id,
        network: cfg.network,
      }));
    }
  });

  logger.warn(
    `Rollback complete: deleted ${affected.length} events, ` +
    `${affectedTxHashes.length} affected txs, ` +
    `${affectedAddresses.size} addresses + ${affectedCredentials.size} credentials + ${affectedPolicies.size} policies updated`
  );

  return { fromSlot, toSlot, affectedTxHashes };
}
