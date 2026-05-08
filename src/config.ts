import cds from "@sap/cds";
import { config as loadEnv } from "dotenv";
import { env } from "process";

// Load .env file if present
// This allows environment variables to be set from a .env file during development and testing
// because cds.env loads .env files after this module is loaded.
loadEnv({ quiet: true });

export interface PollingConfig {
  enabled: boolean;
  interval: number; // in seconds
}

const logger = cds.log("ODATANO-WATCH");

export type WatcherBackend = "blockfrost" | "ogmios";

export interface CardanoWatcherConfig {
  network?: "mainnet" | "preview" | "preprod";
  blockfrostApiKey?: string;
  /**
   * Optional self-hosted Blockfrost-compatible endpoint (e.g. Dolos MiniBF
   * at `http://localhost:3100/api/v0`). When set, the SDK routes all calls
   * here instead of the public Blockfrost service, and `blockfrostApiKey`
   * becomes optional. Useful for high-volume polling that would exhaust
   * the public free-tier daily quota.
   */
  blockfrostCustomBackend?: string;
  /**
   * Koios API key. Optional — Koios has a free tier with rate limits.
   * Required only for credential watching, where we resolve a payment
   * credential to its set of bech32 addresses via Koios `credential_*`.
   */
  koiosApiKey?: string;
  /**
   * Primary backend (Phase 2). Default 'blockfrost' — keeps the polling
   * paths active. Set to 'ogmios' to use chainSync; the polling paths are
   * skipped and replaced by per-block filtering with native rollback.
   * Pick one per process; no auto-failover.
   */
  backend?: WatcherBackend;
  /**
   * Ogmios WebSocket URL. Required when backend === 'ogmios'.
   * Default `ws://localhost:1337`.
   */
  ogmiosUrl?: string;
  autoStart?: boolean;
  maxRetries?: number;
  retryDelay?: number;
  // Individual polling configurations
  addressPolling?: PollingConfig;        // Monitor watched addresses for new transactions
  transactionPolling?: PollingConfig;    // Check if submitted transactions are in the network
  credentialPolling?: PollingConfig;     // Monitor watched payment credentials for new transactions
  policyPolling?: PollingConfig;         // Monitor watched minting policies for asset mint/burn
  /**
   * Maximum number of distinct assets allowed under a watched policy before
   * the watcher refuses to poll it. The per-policy fan-out is one Blockfrost
   * `assetsHistory` request per asset; high-asset NFT policies will exhaust
   * rate limits quickly. Default 100 — well clear of stablecoin/utility-token
   * policies (typically 1–10 assets).
   */
  policyAssetCap?: number;
}

/**
 * Load configuration from cds.env or environment variables
 */
function loadInitialConfig(): CardanoWatcherConfig {
  // Try to get config from cds.env.requires.watch
  const cdsConfig = cds.env?.requires?.watch;

  if (!cdsConfig) {
    logger.debug("No cds.env.requires.watch configuration found, falling back to environment variables");
  }
  // Resolve from CDS config, fallback to env variable (lets consumers keep secrets out of package.json)
  let apiKey = cdsConfig?.blockfrostApiKey ?? env.BLOCKFROST_API_KEY;
  let customBackend = cdsConfig?.blockfrostCustomBackend ?? env.BLOCKFROST_CUSTOM_BACKEND;
  let koiosKey = cdsConfig?.koiosApiKey ?? env.KOIOS_API_KEY;
  let ogmiosUrl = cdsConfig?.ogmiosUrl ?? env.OGMIOS_URL ?? "ws://localhost:1337";
  let backend = (cdsConfig?.backend ?? env.WATCHER_BACKEND ?? "blockfrost") as WatcherBackend;

  return {
    network: cdsConfig?.network ?? "preview",
    blockfrostApiKey: apiKey,
    blockfrostCustomBackend: customBackend,
    koiosApiKey: koiosKey,
    backend,
    ogmiosUrl,
    autoStart: cdsConfig?.autoStart ?? true,
    maxRetries: cdsConfig?.maxRetries ?? 3,
    retryDelay: cdsConfig?.retryDelay ?? 5000,

    // Individual polling configs with sensible defaults
    addressPolling: {
      enabled: cdsConfig?.addressPolling?.enabled !== undefined ? cdsConfig.addressPolling.enabled : true,
      interval: cdsConfig?.addressPolling?.interval ?? 60,
    },
    transactionPolling: {
      enabled: cdsConfig?.transactionPolling?.enabled !== undefined ? cdsConfig.transactionPolling.enabled : true,
      interval: cdsConfig?.transactionPolling?.interval ?? 60,
    },
    credentialPolling: {
      // Default off — credential watching needs a Koios key, so opt-in
      enabled: cdsConfig?.credentialPolling?.enabled === true,
      interval: cdsConfig?.credentialPolling?.interval ?? 60,
    },
    policyPolling: {
      // Default off — opt-in, since per-asset history walks Blockfrost
      enabled: cdsConfig?.policyPolling?.enabled === true,
      interval: cdsConfig?.policyPolling?.interval ?? 60,
    },
    policyAssetCap: cdsConfig?.policyAssetCap ?? 100,
  };
}

let configuration: CardanoWatcherConfig = loadInitialConfig();

/**
 * Initialize configuration with options
 * @param options Configuration options
 * @returns void 
 */
export function initialize(options: CardanoWatcherConfig = {}): void {
  configuration = {
    ...configuration,
    ...options,
  };

  validateConfiguration();
}

/**
 * Validate configuration
 */
function validateConfiguration(): void {
  const validNetworks = ["mainnet", "preview", "preprod"];
  logger.debug(`Validating configuration for network: ${configuration.network}`);
  if (!validNetworks.includes(configuration.network!)) {
    throw new Error(`Invalid network: ${configuration.network}. Must be one of: ${validNetworks.join(", ")}`);
  }

  const validBackends: WatcherBackend[] = ["blockfrost", "ogmios"];
  if (!validBackends.includes(configuration.backend as WatcherBackend)) {
    throw new Error(`Invalid backend: ${configuration.backend}. Must be one of: ${validBackends.join(", ")}`);
  }

  if (!configuration.blockfrostApiKey && !configuration.blockfrostCustomBackend) {
    logger.warn(
      "No Blockfrost API key configured. Set blockfrostApiKey in cds.env.requires.watch configuration"
    );
  }

  if (configuration.backend === "ogmios" && !configuration.ogmiosUrl) {
    throw new Error("backend=ogmios requires ogmiosUrl (or OGMIOS_URL env)");
  }
}

/**
 * Get current configuration
 */
export function get(): CardanoWatcherConfig {
  return { ...configuration };
}

/**
 * Update configuration
 */
export function update(updates: Partial<CardanoWatcherConfig>): void {
  configuration = {
    ...configuration,
    ...updates,
  };
  validateConfiguration();
}
