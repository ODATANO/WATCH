import cds from "@sap/cds";
import * as config from "./config";
import * as watcher from "./watcher";
import type { CardanoWatcherConfig } from "./config";

let initialized = false;

/**
 * Initialize the Cardano Watcher plugin
 */
export async function initialize(): Promise<void> {
  if (initialized) {
    return;
  }

  const logger = cds.log('ODATANO-WATCH');

  logger.info("Initializing Cardano Watcher plugin...");

  // Initialize config from cds.env.requires.watch (merge with defaults)
  const envConfig = cds.env.requires?.watch || {};
  logger.debug("Config from cds.env.requires.watch:", envConfig);
  config.initialize(envConfig);
  
  const cfg = config.get();
  logger.debug("Final config:", { 
      network: cfg.network, 
      hasApiKey: !!cfg.blockfrostApiKey,
      apiKeyLength: cfg.blockfrostApiKey?.length 
    });

  // Setup watcher using the standard database
  // The database will be available via cds.db at this point
  logger.debug("Setting up Cardano Watcher...");
  await watcher.setup();
  logger.info("Cardano Watcher initialized successfully");
  initialized = true;
}

/**
 * Start the watcher (all enabled paths)
 */
export async function start(): Promise<void> {
  return watcher.start();
}

/**
 * Stop the watcher (all paths)
 */
export async function stop(): Promise<void> {
  return watcher.stop();
}

/**
 * Start individual polling paths
 */
export async function startAddressPolling(): Promise<void> {
  return watcher.startAddressPolling();
}

export async function startTransactionPolling(): Promise<void> {
  return watcher.startTransactionPolling();
}

export async function startCredentialPolling(): Promise<void> {
  return watcher.startCredentialPolling();
}

export async function startPolicyPolling(): Promise<void> {
  return watcher.startPolicyPolling();
}

/**
 * Stop individual polling paths
 */
export async function stopAddressPolling(): Promise<void> {
  return watcher.stopAddressPolling();
}

export async function stopTransactionPolling(): Promise<void> {
  return watcher.stopTransactionPolling();
}

export async function stopCredentialPolling(): Promise<void> {
  return watcher.stopCredentialPolling();
}

export async function stopPolicyPolling(): Promise<void> {
  return watcher.stopPolicyPolling();
}

/**
 * Get watcher status
 */
export function getStatus() {
  return watcher.getStatus();
}

/**
 * Get current configuration
 */
export function getConfig(): CardanoWatcherConfig {
  return config.get();
}

// Export types
export type { CardanoWatcherConfig } from "./config";
export type {
  TransactionInfo,
  AddressInfo,
  WatchedUtxo,
  WatchedAsset,
  SpentUtxoRef,
  PolicyAssetEvent,
  AssetFilterEntry,
} from "./blockfrost";
import type { WatchedUtxo, SpentUtxoRef } from "./blockfrost";

// Event payload types
export interface NewTransactionsEvent {
  address: string;
  tag?: string;
  count: number;
  transactions: string[];
  utxosCreated: WatchedUtxo[];
  utxosSpent: SpentUtxoRef[];
}

export interface CredentialNewTransactionsEvent {
  paymentCredHex: string;
  tag?: string;
  count: number;
  transactions: string[];
  utxosCreated: WatchedUtxo[];
  utxosSpent: SpentUtxoRef[];
  blockHeight: number;
}

export interface PolicyAssetMintedEvent {
  policyId: string;
  tag?: string;
  assetNameHex: string;
  quantity: string;
  txHash: string;
  blockHeight: number;
}

export type PolicyAssetBurnedEvent = PolicyAssetMintedEvent;

/**
 * Rollback event (Phase 2 / Ogmios backend only). Fired when the upstream
 * chain rolls back past previously-emitted txs. `affectedTxHashes` lists
 * the distinct txs that were persisted under `backend: 'ogmios'` and have
 * now been orphaned and deleted from `BlockchainEvent`.
 */
export interface RollbackEvent {
  fromSlot: number;
  toSlot: number;
  affectedTxHashes: string[];
}

export interface TxConfirmedEvent {
  txHash: string;
  blockHeight: number;
  confirmations: number;
}

export interface ContractEvent {
  txHash: string;
  contractAddress: string;
  eventType: string;
  scriptHash: string;
  datum?: unknown;
  redeemer?: unknown;
}

// Default export
export default {
  initialize,
  start,
  stop,
  startAddressPolling,
  startTransactionPolling,
  stopAddressPolling,
  stopTransactionPolling,
  getStatus,
  config: getConfig,
};
