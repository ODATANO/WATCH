import cds, { Service } from "@sap/cds";
const { SELECT, INSERT, UPDATE } = cds.ql;
import { randomUUID } from "crypto";
import * as config from "./config";
import * as blockfrost from "./blockfrost";
import * as koios from "./koios";
import * as ogmios from "./ogmios";
import * as ogmiosWatcher from "./ogmios-watcher";
import type { TransactionInfo, WatchedUtxo, SpentUtxoRef } from "./blockfrost";
import { BlockchainEvent, TransactionSubmission ,TransactionSubmissions, WatchedAddress, WatchedAddresses, WatchedCredential, WatchedCredentials, WatchedPolicy, WatchedPolicies } from "../@cds-models/CardanoWatcherAdminService";

const logger = cds.log(`ODATANO-WATCH`);
let addressInterval: NodeJS.Timeout | null = null;
let transactionInterval: NodeJS.Timeout | null = null;
let credentialInterval: NodeJS.Timeout | null = null;
let policyInterval: NodeJS.Timeout | null = null;

let isRunning = false;
let addressPollingActive = false;
let transactionPollingActive = false;
let credentialPollingActive = false;
let policyPollingActive = false;
let ogmiosChainSyncActive = false;
let signalHandlersRegistered = false;

// ============================================================================
// Coalesce buffers (P9)
// ============================================================================
//
// Tumbling-window buffers — first event in a window starts a `setTimeout` for
// coalesceMs; subsequent events in that window accumulate without resetting
// the timer. Persisted BlockchainEvent rows and cursor advance happen at poll
// time as usual; only the bus emit is delayed.

interface AddressCoalesceBuffer {
  address: string;
  tag: string | null;
  txHashes: string[];
  utxosCreated: WatchedUtxo[];
  utxosSpent: SpentUtxoRef[];
  timer: NodeJS.Timeout;
}

interface CredentialCoalesceBuffer {
  paymentCredHex: string;
  tag: string | null;
  txHashes: string[];
  utxosCreated: WatchedUtxo[];
  utxosSpent: SpentUtxoRef[];
  blockHeight: number;
  timer: NodeJS.Timeout;
}

const addressCoalesceBuffers = new Map<string, AddressCoalesceBuffer>();
const credentialCoalesceBuffers = new Map<string, CredentialCoalesceBuffer>();

function bufferAddressEmit(
  address: string,
  tag: string | null,
  txHashes: string[],
  utxosCreated: WatchedUtxo[],
  utxosSpent: SpentUtxoRef[],
  coalesceMs: number,
): void {
  const existing = addressCoalesceBuffers.get(address);
  if (existing) {
    existing.txHashes.push(...txHashes);
    existing.utxosCreated.push(...utxosCreated);
    existing.utxosSpent.push(...utxosSpent);
    return;
  }
  const buffer: AddressCoalesceBuffer = {
    address,
    tag,
    txHashes: [...txHashes],
    utxosCreated: [...utxosCreated],
    utxosSpent: [...utxosSpent],
    timer: setTimeout(() => { void flushAddressBuffer(address); }, coalesceMs),
  };
  addressCoalesceBuffers.set(address, buffer);
}

async function flushAddressBuffer(address: string): Promise<void> {
  const buffer = addressCoalesceBuffers.get(address);
  if (!buffer) return;
  clearTimeout(buffer.timer);
  addressCoalesceBuffers.delete(address);
  try {
    await (cds as typeof cds & { emit: (event: string, data: unknown) => Promise<void> }).emit(
      "cardano.newTransactions",
      {
        address: buffer.address,
        tag: buffer.tag ?? undefined,
        count: buffer.txHashes.length,
        transactions: buffer.txHashes,
        utxosCreated: buffer.utxosCreated,
        utxosSpent: buffer.utxosSpent,
      },
    );
  } catch (emitErr) {
    logger.warn("Failed to emit coalesced newTransactions event:", emitErr);
  }
}

function bufferCredentialEmit(
  paymentCredHex: string,
  tag: string | null,
  txHashes: string[],
  utxosCreated: WatchedUtxo[],
  utxosSpent: SpentUtxoRef[],
  blockHeight: number,
  coalesceMs: number,
): void {
  const existing = credentialCoalesceBuffers.get(paymentCredHex);
  if (existing) {
    existing.txHashes.push(...txHashes);
    existing.utxosCreated.push(...utxosCreated);
    existing.utxosSpent.push(...utxosSpent);
    if (blockHeight > existing.blockHeight) existing.blockHeight = blockHeight;
    return;
  }
  const buffer: CredentialCoalesceBuffer = {
    paymentCredHex,
    tag,
    txHashes: [...txHashes],
    utxosCreated: [...utxosCreated],
    utxosSpent: [...utxosSpent],
    blockHeight,
    timer: setTimeout(() => { void flushCredentialBuffer(paymentCredHex); }, coalesceMs),
  };
  credentialCoalesceBuffers.set(paymentCredHex, buffer);
}

async function flushCredentialBuffer(paymentCredHex: string): Promise<void> {
  const buffer = credentialCoalesceBuffers.get(paymentCredHex);
  if (!buffer) return;
  clearTimeout(buffer.timer);
  credentialCoalesceBuffers.delete(paymentCredHex);
  try {
    await (cds as typeof cds & { emit: (event: string, data: unknown) => Promise<void> }).emit(
      "cardano.credential.newTransactions",
      {
        paymentCredHex: buffer.paymentCredHex,
        tag: buffer.tag ?? undefined,
        count: buffer.txHashes.length,
        transactions: buffer.txHashes,
        utxosCreated: buffer.utxosCreated,
        utxosSpent: buffer.utxosSpent,
        blockHeight: buffer.blockHeight,
      },
    );
  } catch (emitErr) {
    logger.warn("Failed to emit coalesced credential.newTransactions event:", emitErr);
  }
}

async function flushAllAddressBuffers(): Promise<void> {
  // Snapshot keys — flush mutates the map.
  const keys = [...addressCoalesceBuffers.keys()];
  await Promise.all(keys.map(k => flushAddressBuffer(k)));
}

async function flushAllCredentialBuffers(): Promise<void> {
  const keys = [...credentialCoalesceBuffers.keys()];
  await Promise.all(keys.map(k => flushCredentialBuffer(k)));
}

/**
 * Clear all pending coalesce buffers WITHOUT emitting. Used by the rollback
 * handler — pending events refer to txs that are now orphaned, so emitting
 * them as confirmed would be incorrect (Q6 in the Phase 2 plan).
 */
export function dropAllCoalesceBuffers(): void {
  for (const buf of addressCoalesceBuffers.values()) clearTimeout(buf.timer);
  addressCoalesceBuffers.clear();
  for (const buf of credentialCoalesceBuffers.values()) clearTimeout(buf.timer);
  credentialCoalesceBuffers.clear();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any = null;

/**
 * Setup the watcher - should be called once during initialization
 * @returns true if setup succeeded, false if Blockfrost is not configured
 */
export async function setup(): Promise<boolean> {
  const cfg = config.get();
  
  logger.debug("Watcher setup - Config:", {
    hasApiKey: !!cfg.blockfrostApiKey,
    network: cfg.network,
    apiKeyPrefix: cfg.blockfrostApiKey?.substring(0, 10)
  });
  
  // Use the application's standard database
  logger.debug('Connecting to standard database service');
  db = cds.db;
  logger.debug("Database connection established");
  
  // Initialize Blockfrost if API key is available
  if (cfg.blockfrostApiKey) {
    logger.debug("Initializing Blockfrost client...");
    try {
      blockfrost.initializeClient(cfg);
      logger.debug("Blockfrost available:", blockfrost.isAvailable());
    } catch (err) {
      logger.error("Failed to initialize Blockfrost:", err);
      return false;
    }
  } else {
    logger.warn("No Blockfrost API key found in configuration");
    return false;
  }

  // Initialize Koios — credential watching depends on it. Address watching does not.
  try {
    koios.initializeClient(cfg);
  } catch (err) {
    logger.warn("Failed to initialize Koios client (credential watching disabled):", err);
  }

  // Phase 2: Ogmios chainSync. Only initialize the client when this backend
  // is selected — otherwise leave it unconfigured so isAvailable() returns false.
  if (cfg.backend === "ogmios") {
    try {
      ogmios.initializeClient({
        url: cfg.ogmiosUrl!,
        network: cfg.network!,
      });
      ogmiosWatcher.setDb(db);
    } catch (err) {
      logger.error("Failed to initialize Ogmios client:", err);
      return false;
    }
  }
  
  // Register shutdown handlers (only once to prevent memory leak)
  if (!signalHandlersRegistered) {
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
    signalHandlersRegistered = true;
  }

  if (cfg.autoStart) {
    logger.info("Auto-starting Cardano Watcher...");
    await start();
    return true;
  }
  return true;
}

/**
 * Start watching the blockchain
 */
export async function start(): Promise<void> {
  if (isRunning) {
    logger.warn("Watcher is already running");
    return;
  }

  const cfg = config.get();

  logger.info(`Starting Cardano Watcher on ${cfg.network} network`);
  
  isRunning = true;

  if (cfg.backend === "ogmios") {
    // Ogmios chainSync replaces the per-watch polling paths. The `tx
    // submission` polling stays — chainSync doesn't track that lifecycle
    // for us; consumers need explicit confirmation tracking either way.
    await startOgmiosChainSync();
    if (cfg.transactionPolling?.enabled) {
      await startTransactionPolling();
    }
    return;
  }

  // Default backend (Blockfrost): start individual polling paths.
  if (cfg.addressPolling?.enabled) {
    await startAddressPolling();
  }

  if (cfg.transactionPolling?.enabled) {
    await startTransactionPolling();
  }

  if (cfg.credentialPolling?.enabled) {
    await startCredentialPolling();
  }

  if (cfg.policyPolling?.enabled) {
    await startPolicyPolling();
  }

}

/**
 * Stop watching the blockchain (all polling paths)
 */
export async function stop(): Promise<void> {
  if (!isRunning) {
    return;
  }

  logger.debug("Stopping Cardano Watcher...");

  await stopAddressPolling();
  await stopTransactionPolling();
  await stopCredentialPolling();
  await stopPolicyPolling();
  await stopOgmiosChainSync();

  isRunning = false;
  logger.info("Cardano Watcher stopped");
}

// ============================================================================
// Address Polling Path
// ============================================================================

/**
 * Start address polling
 */
export async function startAddressPolling(): Promise<void> {

  if (addressPollingActive) {
    return;
  }

  const cfg = config.get();
  const interval = cfg.addressPolling?.interval || 30;

  logger.debug(`Starting address polling (interval: ${interval}s)`);
  addressPollingActive = true;

  // Start interval
  addressInterval = setInterval(async () => {
    try {
      await pollWatchedAddresses();
    } catch (err) {
      logger.error("Error in address polling:", err);
    }
  }, interval * 1000);

  // Run initial poll immediately
  try {
    await pollWatchedAddresses();
  } catch (err) {
    logger.error("Error in initial address poll:", err);
  }
}

/**
 * Stop address polling
 */
export async function stopAddressPolling(): Promise<void> {
  if (!addressPollingActive) {
    return;
  }

  logger.debug("Stopping address polling...");

  if (addressInterval) {
    clearInterval(addressInterval);
    addressInterval = null;
  }

  // Flush any pending coalesced events so we don't lose deltas on shutdown.
  await flushAllAddressBuffers();

  addressPollingActive = false;
}

// ============================================================================
// Transaction Polling Path
// ============================================================================

/**
 * Start transaction submission polling
 */
export async function startTransactionPolling(): Promise<void> {
  if (transactionPollingActive) {
    return;
  }

  const cfg = config.get();
  const interval = cfg.transactionPolling?.interval || 60;

  logger.debug(`Starting transaction polling (interval: ${interval}s)`);
  transactionPollingActive = true;

  // Start interval
  transactionInterval = setInterval(async () => {
    try {
      await pollTransactionSubmissions();
    } catch (err) {
      logger.error("Error in transaction polling:", err);
    }
  }, interval * 1000);

  // Run initial poll immediately
  try {
    await pollTransactionSubmissions();
  } catch (err) {
    logger.error("Error in initial transaction poll:", err);
  }
}

/**
 * Stop transaction submission polling
 */
export async function stopTransactionPolling(): Promise<void> {
  if (!transactionPollingActive) {
    return;
  }

  logger.debug("Stopping transaction polling...");

  if (transactionInterval) {
    clearInterval(transactionInterval);
    transactionInterval = null;
  }

  transactionPollingActive = false;
}


// ============================================================================
// Credential Polling Path
// ============================================================================

export async function startCredentialPolling(): Promise<void> {
  if (credentialPollingActive) {
    return;
  }

  if (!koios.isAvailable()) {
    logger.warn("Cannot start credential polling: Koios client is not initialized");
    return;
  }

  const cfg = config.get();
  const interval = cfg.credentialPolling?.interval || 60;

  logger.debug(`Starting credential polling (interval: ${interval}s)`);
  credentialPollingActive = true;

  credentialInterval = setInterval(async () => {
    try {
      await pollWatchedCredentials();
    } catch (err) {
      logger.error("Error in credential polling:", err);
    }
  }, interval * 1000);

  try {
    await pollWatchedCredentials();
  } catch (err) {
    logger.error("Error in initial credential poll:", err);
  }
}

export async function stopCredentialPolling(): Promise<void> {
  if (!credentialPollingActive) {
    return;
  }

  logger.debug("Stopping credential polling...");

  if (credentialInterval) {
    clearInterval(credentialInterval);
    credentialInterval = null;
  }

  // Flush any pending coalesced events so we don't lose deltas on shutdown.
  await flushAllCredentialBuffers();

  credentialPollingActive = false;
}

// ============================================================================
// Ogmios chainSync Path (Phase 2)
// ============================================================================

export async function startOgmiosChainSync(): Promise<void> {
  if (ogmiosChainSyncActive) {
    return;
  }
  if (!ogmios.isAvailable()) {
    logger.warn("Cannot start Ogmios chainSync: client is not initialized");
    return;
  }

  const cfg = config.get();
  logger.debug("Starting Ogmios chainSync");
  ogmiosChainSyncActive = true;

  // Periodically refresh the in-memory watch index from the database so
  // newly-added watches are picked up by the per-block filter.
  ogmiosWatcher.startIndexRefresh();

  const cursor = await ogmiosWatcher.loadCursor();
  if (cursor) {
    logger.info(`Ogmios chainSync resuming from slot ${cursor.slot} block ${cursor.blockHash}`);
  } else {
    logger.info("Ogmios chainSync starting from origin (no persisted cursor)");
  }

  const emitFn = (event: string, payload: unknown) =>
    (cds as typeof cds & { emit: (event: string, data: unknown) => Promise<void> }).emit(event, payload);

  try {
    await ogmios.start(cursor, {
      rollForward: async (block, _tip, next) => {
        try {
          await ogmiosWatcher.processRollForward(block, cfg, emitFn);
        } catch (err) {
          logger.error("Error processing rollForward block:", err);
        }
        next();
      },
      rollBackward: async (point, _tip, next) => {
        try {
          // Drop pending coalesce buffers BEFORE the DB rewind: their
          // queued events refer to txs we're about to orphan; emitting
          // them post-rollback would be incorrect (Q6 in the Phase 2 plan).
          dropAllCoalesceBuffers();

          const result = await ogmiosWatcher.processRollBackward(point, cfg);

          if (result.affectedTxHashes.length > 0 || result.fromSlot !== result.toSlot) {
            await emitFn("cardano.rollback", {
              fromSlot: result.fromSlot,
              toSlot: result.toSlot,
              affectedTxHashes: result.affectedTxHashes,
            });
          }
        } catch (err) {
          logger.error("Error processing rollBackward:", err);
        }
        next();
      },
    });
  } catch (err) {
    logger.error("Failed to start Ogmios chainSync:", err);
    ogmiosChainSyncActive = false;
    ogmiosWatcher.stopIndexRefresh();
    throw err;
  }
}

export async function stopOgmiosChainSync(): Promise<void> {
  if (!ogmiosChainSyncActive) {
    return;
  }
  logger.debug("Stopping Ogmios chainSync");
  ogmiosWatcher.stopIndexRefresh();
  await ogmios.shutdown();
  // Flush any pending coalesce buffers populated during chainSync (the
  // ogmios-watcher v0 doesn't currently push into them, but stop is the
  // right hook for when step-5 follow-up plumbs them in).
  await flushAllAddressBuffers();
  await flushAllCredentialBuffers();
  ogmiosChainSyncActive = false;
}

// ============================================================================
// Policy Polling Path
// ============================================================================

export async function startPolicyPolling(): Promise<void> {
  if (policyPollingActive) {
    return;
  }

  const cfg = config.get();
  const interval = cfg.policyPolling?.interval || 60;

  logger.debug(`Starting policy polling (interval: ${interval}s)`);
  policyPollingActive = true;

  policyInterval = setInterval(async () => {
    try {
      await pollWatchedPolicies();
    } catch (err) {
      logger.error("Error in policy polling:", err);
    }
  }, interval * 1000);

  try {
    await pollWatchedPolicies();
  } catch (err) {
    logger.error("Error in initial policy poll:", err);
  }
}

export async function stopPolicyPolling(): Promise<void> {
  if (!policyPollingActive) {
    return;
  }

  logger.debug("Stopping policy polling...");

  if (policyInterval) {
    clearInterval(policyInterval);
    policyInterval = null;
  }

  policyPollingActive = false;
}

// ============================================================================
// Individual Polling Functions
// ============================================================================

/**
 * Poll watched addresses for new transactions
 * @returns Number of events detected
 */
async function pollWatchedAddresses(): Promise<number> {
  let eventsDetected = 0;

  try {
    // Get all watched addresses
    const watchedAddresses = await db.tx(async (tx: Service) => {
      return tx.run(
        SELECT.from(WatchedAddresses)
          .where({ active: true })
      ) as Promise<WatchedAddress[]>;
    });

    if (!watchedAddresses || watchedAddresses.length === 0) {
      logger.debug("No active watched addresses found");
      return 0;
    }

    logger.debug(`Checking ${watchedAddresses.length} watched addresses`);

    // Process each watched address
    for (const watchedAddr of watchedAddresses) {
      const events = await processAddress(watchedAddr);
      eventsDetected += events;
    }

  } catch (err) {
    logger.error("Error in pollWatchedAddresses:", err);
    throw err;
  }
  
  return eventsDetected;
}

/**
 * Process a single watched address
 * @returns Number of events detected
 */
async function processAddress(watchedAddr: WatchedAddress): Promise<number> {
  const cfg = config.get();
  let eventsDetected = 0;

  try {
    if (!watchedAddr.address) {
      logger.warn("Watched address has no address field:", watchedAddr);
      return 0;
    }

    logger.debug(`Processing address: ${watchedAddr.address}`);

    // null cursor = first poll; pass through. Block 0 is also a legal cursor.
    const transactions = await fetchAddressTransactions(
      watchedAddr.address,
      watchedAddr.lastCheckedBlock ?? null,
    );

    if (transactions && transactions.length > 0) {
      const maxBlock = Math.max(...transactions.map(t => t.blockHeight));

      // Apply asset filter (P8). Null filter = pass all txs through.
      const filter = blockfrost.parseAssetFilter(watchedAddr.includesAssetsJson);
      const matching = filter === null
        ? transactions
        : transactions.filter(t => blockfrost.matchesAssetFilter(t.utxosCreated, filter));

      if (matching.length === 0) {
        // No relevant txs after filtering. Advance the cursor so we don't
        // re-fetch the same txs next poll, but don't persist or emit.
        logger.debug(
          `${transactions.length} new transactions for ${watchedAddr.address} ` +
          `but none match the asset filter; advancing cursor to ${maxBlock}`,
        );
        await db.tx(async (tx: Service) => {
          await tx.run(
            UPDATE.entity(WatchedAddresses)
              .set({ lastCheckedBlock: maxBlock })
              .where({ address: watchedAddr.address })
          );
        });
        return 0;
      }

      logger.info(
        filter === null
          ? `Found ${matching.length} new transactions for ${watchedAddr.address}`
          : `Found ${matching.length} of ${transactions.length} new transactions matching filter for ${watchedAddr.address}`
      );
      eventsDetected = matching.length;

      const utxosCreated = matching.flatMap(t => t.utxosCreated);
      const utxosSpent = matching.flatMap(t => t.utxosSpent);
      const eventPayload = {
        address: watchedAddr.address,
        tag: watchedAddr.tag ?? undefined,
        count: matching.length,
        transactions: matching.map(t => t.txHash),
        utxosCreated,
        utxosSpent,
      };

      await db.tx(async (tx: Service) => {
        // Persist only the matching subset.
        for (const tx_data of matching) {
          await tx.run(
            INSERT.into(BlockchainEvent).entries({
              id: randomUUID(),
              type: "TRANSACTION",
              blockHeight: tx_data.blockHeight,
              blockHash: tx_data.blockHash,
              txHash: tx_data.txHash,
              address_address: watchedAddr.address,
              payload: JSON.stringify(tx_data),
              network: cfg.network,
              processed: false,
            } as BlockchainEvent)
          );
        }

        // Cursor advances past every fetched tx — including filtered-out ones —
        // since they've been observed and shouldn't be re-fetched.
        await tx.run(
          UPDATE.entity(WatchedAddresses)
            .set({ lastCheckedBlock: maxBlock })
            .where({ address: watchedAddr.address })
        );
      });

      // Emit event for other parts of the application. When coalesceMs is set,
      // route through the buffer instead — flushed by setTimeout or stop().
      const coalesceMs = watchedAddr.coalesceMs ?? 0;
      if (coalesceMs > 0) {
        bufferAddressEmit(
          watchedAddr.address,
          watchedAddr.tag ?? null,
          eventPayload.transactions,
          eventPayload.utxosCreated,
          eventPayload.utxosSpent,
          coalesceMs,
        );
      } else {
        try {
          await (cds as typeof cds & { emit: (event: string, data: unknown) => Promise<void> }).emit(
            "cardano.newTransactions",
            eventPayload,
          );
        } catch (emitErr) {
          logger.warn("Failed to emit newTransactions event:", emitErr);
        }
      }
    }
  } catch (err) {
    logger.error(`Error processing address ${watchedAddr.address}:`, err);
  }
  
  return eventsDetected;
}

/**
 * Fetch transactions for an address from Cardano API
 */
async function fetchAddressTransactions(
  address: string,
  fromBlock: number | null
): Promise<TransactionInfo[] | null> {
  
  // Try Blockfrost first
  if (blockfrost.isAvailable()) {
    try {
      return await blockfrost.fetchAddressTransactions(address, fromBlock);
    } catch (err) {
      logger.error("Error fetching from Blockfrost:", err);
      throw err;
    }
  }
  return null;
}

/**
 * Poll submitted transactions to check if they are in the network
 * This checks if submitted transactions have been picked up by the blockchain,
 * not their confirmation status.
 * @returns Number of events detected
 */
async function pollTransactionSubmissions(): Promise<number> {
  let eventsDetected = 0;

  try {
    // Get active transaction submissions
    const submissions = await db.tx(async (tx: Service) => {
      return tx.run(
        SELECT.from(TransactionSubmissions)
          .where({ active: true })
      );
    });

    if (!submissions || submissions.length === 0) {
      logger.debug("No active transaction submissions found");
      return 0;
    }

    logger.debug(`Checking ${submissions.length} transaction submissions`);

    // Process each submission
    for (const submission of submissions) {
      const events = await processTransactionSubmission(submission);
      eventsDetected += events;
    }

  } catch (err) {
    logger.error("Error in pollTransactionSubmissions:", err);
    throw err;
  }
  
  return eventsDetected;
}

async function processTransactionSubmission(submission: TransactionSubmission): Promise<number> {
  const cfg = config.get();
  let eventsDetected = 0;
  try {
    if (!submission.txHash) {
      logger.warn("Transaction submission has no txHash:", submission);
      return 0;
    }
    logger.debug(`Processing transaction submission: ${submission.txHash}`);

    const txData = await blockfrost.getTransaction(submission.txHash);
    if (txData) {
      logger.info(`Transaction ${submission.txHash} found on chain in block ${txData.blockHeight}`);
      eventsDetected += 1;
      await db.tx(async (tx: Service) => {
        // Store blockchain event
        await tx.run(
          INSERT.into(BlockchainEvent).entries({
            id: randomUUID(),
            type: "TRANSACTION_SUBMISSION",
            blockHeight: txData.blockHeight,
            blockHash: txData.blockHash,
            txHash: txData.txHash,
            payload: JSON.stringify(txData),
            network: cfg.network,
            processed: false,
          } as BlockchainEvent)
        );  
        // Update submission status
        await tx.run(
          UPDATE.entity(TransactionSubmissions).set({ active: false }).where({ txHash: submission.txHash })
        );
      });
    }
  } catch (err) {
    logger.error(`Error processing transaction submission ${submission.txHash}:`, err);
  }
  return eventsDetected;
}

async function pollWatchedCredentials(): Promise<number> {
  let eventsDetected = 0;

  try {
    const watchedCreds = await db.tx(async (tx: Service) => {
      return tx.run(
        SELECT.from(WatchedCredentials).where({ active: true })
      ) as Promise<WatchedCredential[]>;
    });

    if (!watchedCreds || watchedCreds.length === 0) {
      logger.debug("No active watched credentials found");
      return 0;
    }

    logger.debug(`Checking ${watchedCreds.length} watched credentials`);

    for (const cred of watchedCreds) {
      eventsDetected += await processCredential(cred);
    }
  } catch (err) {
    logger.error("Error in pollWatchedCredentials:", err);
    throw err;
  }

  return eventsDetected;
}

async function processCredential(cred: WatchedCredential): Promise<number> {
  const cfg = config.get();
  let eventsDetected = 0;

  if (!cred.paymentCredHex) {
    logger.warn("Watched credential has no paymentCredHex:", cred);
    return 0;
  }

  try {
    logger.debug(`Processing credential: ${cred.paymentCredHex}`);

    // Resolve every bech32 address that shares this payment credential. Indigo
    // CDP-manager and Minswap V2 pools have hundreds-to-thousands of these.
    const addresses = await koios.getAddressesByCredential(cred.paymentCredHex);
    if (addresses.length === 0) {
      logger.debug(`No addresses resolved for credential ${cred.paymentCredHex}`);
      return 0;
    }
    const addressSet = new Set(addresses);

    const credTxs = await koios.getCredentialTxsSince(
      cred.paymentCredHex,
      cred.lastCheckedBlock ?? null,
    );

    // Belt-and-suspenders: filter again client-side, since Koios's
    // _after_block_height is exclusive but the field name varies across versions.
    const newTxs = (cred.lastCheckedBlock ?? null) === null
      ? credTxs
      : credTxs.filter(t => t.blockHeight > cred.lastCheckedBlock!);

    if (newTxs.length === 0) {
      logger.debug(`No new transactions for credential ${cred.paymentCredHex}`);
      return 0;
    }

    const filter = blockfrost.parseAssetFilter(cred.includesAssetsJson);

    const aggregatedCreated = [];
    const aggregatedSpent = [];
    const txHashes: string[] = [];
    const matchedTxs: typeof newTxs = [];
    let maxBlock = cred.lastCheckedBlock ?? 0;

    for (const t of newTxs) {
      const deltas = await blockfrost.fetchTxUtxos(t.txHash, addressSet);
      if (!deltas) continue;

      // Filter by asset allowlist (P8). Skipped txs still advance the cursor.
      if (!blockfrost.matchesAssetFilter(deltas.utxosCreated, filter)) {
        if (t.blockHeight > maxBlock) maxBlock = t.blockHeight;
        continue;
      }

      aggregatedCreated.push(...deltas.utxosCreated);
      aggregatedSpent.push(...deltas.utxosSpent);
      txHashes.push(t.txHash);
      matchedTxs.push(t);
      if (t.blockHeight > maxBlock) maxBlock = t.blockHeight;
    }

    if (matchedTxs.length === 0) {
      logger.debug(
        `${newTxs.length} new transactions for credential ${cred.paymentCredHex} ` +
        `but none match the asset filter; advancing cursor to ${maxBlock}`,
      );
      await db.tx(async (tx: Service) => {
        await tx.run(
          UPDATE.entity(WatchedCredentials)
            .set({ lastCheckedBlock: maxBlock })
            .where({ paymentCredHex: cred.paymentCredHex })
        );
      });
      return 0;
    }

    logger.info(
      filter === null
        ? `Found ${matchedTxs.length} new transactions for credential ${cred.paymentCredHex}`
        : `Found ${matchedTxs.length} of ${newTxs.length} new transactions matching filter for credential ${cred.paymentCredHex}`
    );
    eventsDetected = matchedTxs.length;

    await db.tx(async (tx: Service) => {
      for (const t of matchedTxs) {
        await tx.run(
          INSERT.into(BlockchainEvent).entries({
            id: randomUUID(),
            type: "CREDENTIAL_TRANSACTION",
            blockHeight: t.blockHeight,
            txHash: t.txHash,
            credential_paymentCredHex: cred.paymentCredHex,
            payload: JSON.stringify(t),
            network: cfg.network,
            processed: false,
          } as BlockchainEvent)
        );
      }

      await tx.run(
        UPDATE.entity(WatchedCredentials)
          .set({ lastCheckedBlock: maxBlock })
          .where({ paymentCredHex: cred.paymentCredHex })
      );
    });

    const coalesceMs = cred.coalesceMs ?? 0;
    if (coalesceMs > 0) {
      bufferCredentialEmit(
        cred.paymentCredHex,
        cred.tag ?? null,
        txHashes,
        aggregatedCreated,
        aggregatedSpent,
        maxBlock,
        coalesceMs,
      );
    } else {
      try {
        await (cds as typeof cds & { emit: (event: string, data: unknown) => Promise<void> }).emit(
          "cardano.credential.newTransactions",
          {
            paymentCredHex: cred.paymentCredHex,
            tag: cred.tag ?? undefined,
            count: matchedTxs.length,
            transactions: txHashes,
            utxosCreated: aggregatedCreated,
            utxosSpent: aggregatedSpent,
            blockHeight: maxBlock,
          },
        );
      } catch (emitErr) {
        logger.warn("Failed to emit credential.newTransactions event:", emitErr);
      }
    }
  } catch (err) {
    logger.error(`Error processing credential ${cred.paymentCredHex}:`, err);
  }

  return eventsDetected;
}

async function pollWatchedPolicies(): Promise<number> {
  let eventsDetected = 0;

  try {
    const watchedPolicies = await db.tx(async (tx: Service) => {
      return tx.run(
        SELECT.from(WatchedPolicies).where({ active: true })
      ) as Promise<WatchedPolicy[]>;
    });

    if (!watchedPolicies || watchedPolicies.length === 0) {
      logger.debug("No active watched policies found");
      return 0;
    }

    logger.debug(`Checking ${watchedPolicies.length} watched policies`);

    for (const policy of watchedPolicies) {
      eventsDetected += await processPolicy(policy);
    }
  } catch (err) {
    logger.error("Error in pollWatchedPolicies:", err);
    throw err;
  }

  return eventsDetected;
}

async function processPolicy(policy: WatchedPolicy): Promise<number> {
  const cfg = config.get();
  let eventsDetected = 0;

  if (!policy.policyId) {
    logger.warn("Watched policy has no policyId:", policy);
    return 0;
  }

  try {
    logger.debug(`Processing policy: ${policy.policyId}`);

    const events = await blockfrost.fetchPolicyAssetEvents(
      policy.policyId,
      policy.lastCheckedBlock ?? null,
      cfg.policyAssetCap ?? 100,
    );

    // null = asset cap exceeded; the blockfrost helper has already warned.
    if (events === null) {
      return 0;
    }

    if (events.length === 0) {
      logger.debug(`No new mint/burn events for policy ${policy.policyId}`);
      return 0;
    }

    logger.info(`Found ${events.length} new mint/burn events for policy ${policy.policyId}`);
    eventsDetected = events.length;

    const maxBlock = events.reduce(
      (acc, e) => (e.blockHeight > acc ? e.blockHeight : acc),
      policy.lastCheckedBlock ?? 0,
    );

    await db.tx(async (tx: Service) => {
      for (const ev of events) {
        await tx.run(
          INSERT.into(BlockchainEvent).entries({
            id: randomUUID(),
            type: ev.action === 'minted' ? 'ASSET_MINTED' : 'ASSET_BURNED',
            blockHeight: ev.blockHeight,
            txHash: ev.txHash,
            policy_policyId: policy.policyId,
            payload: JSON.stringify(ev),
            network: cfg.network,
            processed: false,
          } as BlockchainEvent)
        );
      }

      await tx.run(
        UPDATE.entity(WatchedPolicies)
          .set({ lastCheckedBlock: maxBlock })
          .where({ policyId: policy.policyId })
      );
    });

    // One bus event per mint/burn, matching the IMPROVEMENTS doc payload
    // shape — consumers register a single listener per action type.
    for (const ev of events) {
      const eventName = ev.action === 'minted'
        ? 'cardano.policy.assetMinted'
        : 'cardano.policy.assetBurned';
      try {
        await (cds as typeof cds & { emit: (event: string, data: unknown) => Promise<void> }).emit(
          eventName,
          {
            policyId: ev.policyId,
            tag: policy.tag ?? undefined,
            assetNameHex: ev.assetNameHex,
            quantity: ev.quantity,
            txHash: ev.txHash,
            blockHeight: ev.blockHeight,
          },
        );
      } catch (emitErr) {
        logger.warn(`Failed to emit ${eventName} event:`, emitErr);
      }
    }
  } catch (err) {
    logger.error(`Error processing policy ${policy.policyId}:`, err);
  }

  return eventsDetected;
}

/**
 * Get current watcher status
 */
export function getStatus(): {
  isRunning: boolean;
  backend: string;
  addressPolling: boolean;
  transactionPolling: boolean;
  credentialPolling: boolean;
  policyPolling: boolean;
  ogmiosChainSync: boolean;
  config: config.CardanoWatcherConfig;
  }
  {
    const cfg = config.get();
    return {
      isRunning,
      backend: cfg.backend ?? "blockfrost",
      addressPolling: addressPollingActive,
      transactionPolling: transactionPollingActive,
      credentialPolling: credentialPollingActive,
      policyPolling: policyPollingActive,
      ogmiosChainSync: ogmiosChainSyncActive,
      config: cfg,
    };
  }

