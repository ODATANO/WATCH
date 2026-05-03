import cds, { Request, Service } from "@sap/cds";
const { SELECT, INSERT, UPDATE } = cds.ql;
import * as watcher from "../src/watcher";
import * as backfill from "../src/backfill";
import * as blockfrost from "../src/blockfrost";
import { initialize as initializeWatcher } from "../src/index";
import { rejectMissing, rejectInvalid } from './utils/errors';
import { isValidBech32Address, isValidNetwork, isTxHash, isPaymentCredHex, isPolicyId, isAssetFilterJson, isCoalesceMs, isWatchScope } from './utils/validators';
import { handleRequest } from './utils/backend-request-handler';
import type { WatchedAddress, WatchedCredential, WatchedPolicy, TransactionSubmission } from '../@cds-models/CardanoWatcherAdminService';

const logger = cds.log('ODATANO-WATCH');

// Initialize Cardano Watcher on module load
initializeWatcher().catch((err: Error) => {
  logger.error("Failed to initialize Cardano Watcher:", err);
});

/**
 * Pick the initial `lastCheckedBlock` for a freshly-added watch.
 *
 * Default: current Blockfrost tip. This prevents the genesis-backfill
 * stampede on hot script credentials (Minswap V2, etc.) that would
 * otherwise hit Koios's pagination cap on the first poll.
 *
 * Under Ogmios mode we return null instead — the post-add backfill path
 * caps at the chainSync cursor; pre-setting `lastCheckedBlock = tip`
 * would short-circuit it.
 *
 * Returns null if Blockfrost is unavailable or tip lookup fails — caller
 * falls back to "no cursor" semantics.
 */
async function pickInitialCursor(): Promise<number | null> {
  if (watcher.getStatus().config.backend === "ogmios") return null;
  if (!blockfrost.isAvailable()) return null;
  try {
    const tip = await blockfrost.getLatestBlock();
    return tip?.height ?? null;
  } catch (err) {
    logger.warn("Failed to fetch Blockfrost tip for initial cursor; falling back to null:", err);
    return null;
  }
}

/**
 * Cardano Watcher Admin Service Implementation
 * Manages blockchain address monitoring and transaction tracking
 */
module.exports = (srv: cds.Service) => {
  logger.info("Cardano Watcher Admin Service Module loaded - registering handlers");
  
  // Use a literal relative path (not `#cds-models/...`) so consumers don't
  // need to mirror an `imports` field in their own package.json. The build
  // ships @cds-models/ at the package root; admin-service.js is at srv/
  // after in-place compile, so `../@cds-models/...` resolves correctly.
  const {
    WatchedAddresses,
    WatchedCredentials,
    WatchedPolicies,
    TransactionSubmissions,
    BlockchainEvents,
  } = require('../@cds-models/CardanoWatcherAdminService/index.js');

  // ---------------------------------------------------------------------------
  // Watcher Control Actions
  // ---------------------------------------------------------------------------

  /**
   * Start Watcher - Start all polling paths
   */
  srv.on("startWatcher", async (req: Request) => {
    logger.debug("startWatcher action called");
    
    return handleRequest(req, async () => {
      await watcher.start();
      logger.info("Watcher started successfully");
      return { success: true, message: "Watcher started successfully"};
    });
  });

  /**
   * Stop Watcher - Stop all polling paths
   */
  srv.on("stopWatcher", async (req: Request) => {
    logger.debug("stopWatcher action called");
    
    return handleRequest(req, async () => {
      await watcher.stop();
      logger.info("Watcher stopped successfully");
      return { success: true, message: "Watcher stopped successfully"};
    });
  });

  /**
   * Get Watcher Status
   */
  srv.on("getWatcherStatus", async (req: Request) => {
    logger.debug("Admin Service getWatcherStatus action called");
    
    return handleRequest(req, async (db: Service) => {
      const status = watcher.getStatus();

      // Count active watches
      const [addressCount, credentialCount, policyCount, submissionCount] = await Promise.all([
        db.run(SELECT.from(WatchedAddresses).where({ active: true })),
        db.run(SELECT.from(WatchedCredentials).where({ active: true })),
        db.run(SELECT.from(WatchedPolicies).where({ active: true })),
        db.run(SELECT.from(TransactionSubmissions).where({ active: true })),
      ]);

      logger.debug({
        addresses: Array.isArray(addressCount) ? addressCount.length : 0,
        credentials: Array.isArray(credentialCount) ? credentialCount.length : 0,
        policies: Array.isArray(policyCount) ? policyCount.length : 0,
        submissions: Array.isArray(submissionCount) ? submissionCount.length : 0
      }, "Active watch counts");

      return {
        isRunning: status.isRunning,
        addressPolling: status.addressPolling,
        transactionPolling: status.transactionPolling,
        credentialPolling: status.credentialPolling,
        policyPolling: status.policyPolling,
        network: status.config.network || "preview",
        pollingIntervals: {
          address: status.config.addressPolling?.interval || 30,
          transaction: status.config.transactionPolling?.interval || 60,
          credential: status.config.credentialPolling?.interval || 60,
          policy: status.config.policyPolling?.interval || 60,
        },
        watchCounts: {
          addresses: Array.isArray(addressCount) ? addressCount.length : 0,
          credentials: Array.isArray(credentialCount) ? credentialCount.length : 0,
          policies: Array.isArray(policyCount) ? policyCount.length : 0,
          submissions: Array.isArray(submissionCount) ? submissionCount.length : 0,
          newTransactions: 0,
        },
      };
    });
  });

  // ---------------------------------------------------------------------------
  // Address Monitoring Actions
  // ---------------------------------------------------------------------------

  /**
   * Add Watched Address
   * Adds a new Cardano address to monitor for blockchain activity
   */
  srv.on("addWatchedAddress", async (req: Request) => {
    logger.debug("addWatchedAddress action called");
    const { address, description, tag, includesAssetsJson, coalesceMs, network } = req.data;

    // Validate inputs
    if (!address) return rejectMissing('addWatchedAddress', 'address');
    if (!isValidBech32Address(address)) {
      return rejectInvalid('addWatchedAddress', 'Invalid Bech32 address format', 'address');
    }
    if (network && !isValidNetwork(network)) {
      return rejectInvalid('addWatchedAddress', 'Invalid network (must be mainnet, preview, or preprod)', 'network');
    }
    if (includesAssetsJson && !isAssetFilterJson(includesAssetsJson)) {
      return rejectInvalid('addWatchedAddress', 'includesAssetsJson must be a non-empty JSON array of {policyId, assetNameHex}', 'includesAssetsJson');
    }
    if (coalesceMs !== null && coalesceMs !== undefined && !isCoalesceMs(coalesceMs)) {
      return rejectInvalid('addWatchedAddress', 'coalesceMs must be a positive integer up to 300000 (5 min)', 'coalesceMs');
    }

    return handleRequest(req, async (db: Service) => {
      // check if already exists / being watched
      const existing = await db.run(SELECT.one.from(WatchedAddresses).where({ address }));
      if (existing) {
        return rejectInvalid('addWatchedAddress', `Address ${address} is already being watched`, 'address');
      }

      // create new watch entry — initial cursor is current Blockfrost tip
      // (or null under Ogmios mode, so backfill can run from chainSync cap).
      const initialCursor = await pickInitialCursor();
      const watchedAddressEntry: WatchedAddress = {
        address,
        description: description || null,
        tag: tag || null,
        includesAssetsJson: includesAssetsJson || null,
        coalesceMs: coalesceMs ?? null,
        network: network || watcher.getStatus().config.network || 'preview',
        active: true,
        lastCheckedBlock: initialCursor,
      };

      const result = await db.run(INSERT.into(WatchedAddresses).entries(watchedAddressEntry));

      logger.info({ address, tag, includesAssetsJson, coalesceMs, initialCursor, result }, "Added watched address");

      // Phase 2: under Ogmios mode, kick off Blockfrost backfill in the
      // background so the watch sees its history. Don't block the request.
      if (watcher.getStatus().config.backend === "ogmios") {
        backfill.backfillAddress(address).catch((err: Error) =>
          logger.error(`Address backfill failed for ${address}:`, err)
        );
      }

      return watchedAddressEntry;
    });
  });

  srv.on("removeWatchedAddress", async (req: Request) => {
    logger.debug("removeWatchedAddress action called");
    const { address } = req.data;

    // Validate inputs
    if (!address) return rejectMissing('removeWatchedAddress', 'address');
    if (!isValidBech32Address(address)) {
      return rejectInvalid('removeWatchedAddress', 'Invalid Bech32 address format', 'address');
    } 
    return handleRequest(req, async (db: Service) => {
      // Check if exists
      const existing = await db.run(SELECT.one.from(WatchedAddresses).where({ address }));
      if (!existing) {
        return rejectInvalid('removeWatchedAddress', `Address ${address} is not being watched`, 'address');
      }
      // Remove watch entry
      const result = await db.run(UPDATE.entity(WatchedAddresses).set({ active: false }).where({ address }));
      logger.info({ address, result }, "Removed watched address");
      return { success: true, message: `Stopped watching address ${address}` };
    });
  });

  // ---------------------------------------------------------------------------
  // Credential Monitoring Actions
  // ---------------------------------------------------------------------------

  srv.on("addWatchedCredential", async (req: Request) => {
    logger.debug("addWatchedCredential action called");
    const { paymentCredHex, description, tag, includesAssetsJson, coalesceMs, network } = req.data;

    if (!paymentCredHex) return rejectMissing('addWatchedCredential', 'paymentCredHex');
    if (!isPaymentCredHex(paymentCredHex)) {
      return rejectInvalid('addWatchedCredential', 'Invalid payment credential (must be 56-char hex)', 'paymentCredHex');
    }
    if (network && !isValidNetwork(network)) {
      return rejectInvalid('addWatchedCredential', 'Invalid network (must be mainnet, preview, or preprod)', 'network');
    }
    if (includesAssetsJson && !isAssetFilterJson(includesAssetsJson)) {
      return rejectInvalid('addWatchedCredential', 'includesAssetsJson must be a non-empty JSON array of {policyId, assetNameHex}', 'includesAssetsJson');
    }
    if (coalesceMs !== null && coalesceMs !== undefined && !isCoalesceMs(coalesceMs)) {
      return rejectInvalid('addWatchedCredential', 'coalesceMs must be a positive integer up to 300000 (5 min)', 'coalesceMs');
    }

    return handleRequest(req, async (db: Service) => {
      const existing = await db.run(SELECT.one.from(WatchedCredentials).where({ paymentCredHex }));
      if (existing) {
        return rejectInvalid('addWatchedCredential', `Credential ${paymentCredHex} is already being watched`, 'paymentCredHex');
      }

      const initialCursor = await pickInitialCursor();
      const entry: WatchedCredential = {
        paymentCredHex,
        description: description || null,
        tag: tag || null,
        includesAssetsJson: includesAssetsJson || null,
        coalesceMs: coalesceMs ?? null,
        network: network || watcher.getStatus().config.network || 'preview',
        active: true,
        lastCheckedBlock: initialCursor,
      };

      const result = await db.run(INSERT.into(WatchedCredentials).entries(entry));

      logger.info({ paymentCredHex, tag, includesAssetsJson, coalesceMs, initialCursor, result }, "Added watched credential");

      if (watcher.getStatus().config.backend === "ogmios") {
        backfill.backfillCredential(paymentCredHex).catch((err: Error) =>
          logger.error(`Credential backfill failed for ${paymentCredHex}:`, err)
        );
      }

      return entry;
    });
  });

  srv.on("removeWatchedCredential", async (req: Request) => {
    logger.debug("removeWatchedCredential action called");
    const { paymentCredHex } = req.data;

    if (!paymentCredHex) return rejectMissing('removeWatchedCredential', 'paymentCredHex');
    if (!isPaymentCredHex(paymentCredHex)) {
      return rejectInvalid('removeWatchedCredential', 'Invalid payment credential (must be 56-char hex)', 'paymentCredHex');
    }

    return handleRequest(req, async (db: Service) => {
      const existing = await db.run(SELECT.one.from(WatchedCredentials).where({ paymentCredHex }));
      if (!existing) {
        return rejectInvalid('removeWatchedCredential', `Credential ${paymentCredHex} is not being watched`, 'paymentCredHex');
      }
      const result = await db.run(UPDATE.entity(WatchedCredentials).set({ active: false }).where({ paymentCredHex }));
      logger.info({ paymentCredHex, result }, "Removed watched credential");
      return { success: true, message: `Stopped watching credential ${paymentCredHex}` };
    });
  });

  // ---------------------------------------------------------------------------
  // Policy Monitoring Actions
  // ---------------------------------------------------------------------------

  srv.on("addWatchedPolicy", async (req: Request) => {
    logger.debug("addWatchedPolicy action called");
    const { policyId, description, tag, network } = req.data;

    if (!policyId) return rejectMissing('addWatchedPolicy', 'policyId');
    if (!isPolicyId(policyId)) {
      return rejectInvalid('addWatchedPolicy', 'Invalid policy ID (must be 56-char hex)', 'policyId');
    }
    if (network && !isValidNetwork(network)) {
      return rejectInvalid('addWatchedPolicy', 'Invalid network (must be mainnet, preview, or preprod)', 'network');
    }

    return handleRequest(req, async (db: Service) => {
      const existing = await db.run(SELECT.one.from(WatchedPolicies).where({ policyId }));
      if (existing) {
        return rejectInvalid('addWatchedPolicy', `Policy ${policyId} is already being watched`, 'policyId');
      }

      const initialCursor = await pickInitialCursor();
      const entry: WatchedPolicy = {
        policyId,
        description: description || null,
        tag: tag || null,
        network: network || watcher.getStatus().config.network || 'preview',
        active: true,
        lastCheckedBlock: initialCursor,
      };

      const result = await db.run(INSERT.into(WatchedPolicies).entries(entry));

      logger.info({ policyId, tag, initialCursor, result }, "Added watched policy");

      if (watcher.getStatus().config.backend === "ogmios") {
        backfill.backfillPolicy(policyId).catch((err: Error) =>
          logger.error(`Policy backfill failed for ${policyId}:`, err)
        );
      }

      return entry;
    });
  });

  srv.on("removeWatchedPolicy", async (req: Request) => {
    logger.debug("removeWatchedPolicy action called");
    const { policyId } = req.data;

    if (!policyId) return rejectMissing('removeWatchedPolicy', 'policyId');
    if (!isPolicyId(policyId)) {
      return rejectInvalid('removeWatchedPolicy', 'Invalid policy ID (must be 56-char hex)', 'policyId');
    }

    return handleRequest(req, async (db: Service) => {
      const existing = await db.run(SELECT.one.from(WatchedPolicies).where({ policyId }));
      if (!existing) {
        return rejectInvalid('removeWatchedPolicy', `Policy ${policyId} is not being watched`, 'policyId');
      }
      const result = await db.run(UPDATE.entity(WatchedPolicies).set({ active: false }).where({ policyId }));
      logger.info({ policyId, result }, "Removed watched policy");
      return { success: true, message: `Stopped watching policy ${policyId}` };
    });
  });

  // ---------------------------------------------------------------------------
  // Transaction Tracking Actions
  // ---------------------------------------------------------------------------

  /**
   * Submit and Track Transaction
   * Submits a transaction hash for status tracking
   */
  srv.on("addWatchedTransaction", async (req: Request) => {
    const { txHash, description, network } = req.data;

    logger.info({ txHash }, "addWatchedTransaction action called");
    
    // Validate inputs
    if (!txHash) return rejectMissing('TrackSubmittedTransaction', 'txHash');
    if (!isTxHash(txHash)) {
      return rejectInvalid('TrackSubmittedTransaction', 'Invalid transaction hash format', 'txHash');
    }
    if (network && !isValidNetwork(network)) {
      return rejectInvalid('TrackSubmittedTransaction', 'Invalid network', 'network');
    }

    return handleRequest(req, async (db: Service) => {
      // Check if already exists
      const existing = await db.run(SELECT.one.from(TransactionSubmissions).where({ txHash }));
      if (existing) {
        return rejectInvalid('TrackSubmittedTransaction', `Transaction ${txHash} is already being tracked`, 'txHash');
      }
      
      // create new submission entry
      const submissionEntry: TransactionSubmission = {
        txHash,
        description: description || null,
        network: network,
        active: true,
        currentStatus: "PENDING",
        confirmations: 0,
      };

      await db.run(INSERT.into(TransactionSubmissions).entries(submissionEntry));
      
      return submissionEntry;
    });
  });

  srv.on("removeWatchedTransaction", async (req: Request) => {
    logger.debug("removeWatchedTransaction action called");
    const { txHash } = req.data;
    // Validate inputs
    if (!txHash) return rejectMissing('removeWatchedTransaction', 'txHash');
    if (!isTxHash(txHash)) {
      return rejectInvalid('removeWatchedTransaction', 'Invalid transaction hash format', 'txHash');
    }
    return handleRequest(req, async (db: Service) => {
      // Check if exists
      const existing = await db.run(SELECT.one.from(TransactionSubmissions).where({ txHash }));
      if (!existing) {
        return rejectInvalid('removeWatchedTransaction', `Transaction ${txHash} is not being tracked`, 'txHash');
      }
      // Remove watch entry
      const result = await db.run(UPDATE.entity(TransactionSubmissions).set({ active: false }).where({ txHash }));
      logger.info({ txHash, result }, "Removed watched transaction");
      return { success: true, message: `Stopped tracking transaction ${txHash}` };
    });
  });

  // ---------------------------------------------------------------------------
  // Replay
  // ---------------------------------------------------------------------------

  /**
   * Return persisted BlockchainEvent rows for a watch since the given
   * blockHeight. Cursor-paginated: pass the last returned event's
   * blockHeight as `fromBlock` on the next call to continue.
   */
  srv.on("getEventsSince", async (req: Request) => {
    const { scope, key, fromBlock, limit } = req.data;

    if (!scope) return rejectMissing('getEventsSince', 'scope');
    if (!isWatchScope(scope)) {
      return rejectInvalid('getEventsSince', "scope must be 'address', 'credential', or 'policy'", 'scope');
    }
    if (!key) return rejectMissing('getEventsSince', 'key');

    // Validate the key shape against the chosen scope so the SELECT can't
    // silently match unrelated rows because of a typo'd identifier.
    if (scope === 'address' && !isValidBech32Address(key)) {
      return rejectInvalid('getEventsSince', 'key must be a valid Bech32 address for scope=address', 'key');
    }
    if (scope === 'credential' && !isPaymentCredHex(key)) {
      return rejectInvalid('getEventsSince', 'key must be a 56-char hex payment credential for scope=credential', 'key');
    }
    if (scope === 'policy' && !isPolicyId(key)) {
      return rejectInvalid('getEventsSince', 'key must be a 56-char hex policy ID for scope=policy', 'key');
    }

    const HARD_CAP = 10_000;
    const effectiveLimit = !limit || limit <= 0
      ? 1000
      : Math.min(limit, HARD_CAP);

    const fkColumn =
      scope === 'address'    ? 'address_address' :
      scope === 'credential' ? 'credential_paymentCredHex' :
                               'policy_policyId';

    return handleRequest(req, async (db: Service) => {
      const where: Record<string, unknown> = { [fkColumn]: key };
      if (fromBlock != null) {
        where.blockHeight = { '>': fromBlock };
      }

      const rows = await db.run(
        SELECT.from(BlockchainEvents)
          .where(where)
          .orderBy('blockHeight asc')
          .limit(effectiveLimit)
      );

      logger.debug({ scope, key, fromBlock, returned: Array.isArray(rows) ? rows.length : 0 }, "getEventsSince");

      return rows;
    });
  });

  logger.debug("Admin Service All handlers registered");
};

