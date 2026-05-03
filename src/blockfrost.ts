import cds from "@sap/cds";
import { BlockFrostAPI } from "@blockfrost/blockfrost-js";
import { handleBackendRequest } from "../srv/utils/backend-request-handler";

interface BlockfrostAmount {
  unit: string;
  quantity: string;
}

export interface WatchedAsset {
  unit: string;
  quantity: string;
}

export interface WatchedUtxo {
  txHash: string;
  outputIndex: number;
  lovelace: string;
  assets: WatchedAsset[];
  inlineDatumHex?: string;
  referenceScriptHash?: string;
}

export interface SpentUtxoRef {
  txHash: string;
  outputIndex: number;
}

export interface PolicyAssetEvent {
  policyId: string;
  assetNameHex: string;
  /** Magnitude of the mint or burn. Always positive — the `action` field carries direction. */
  quantity: string;
  action: 'minted' | 'burned';
  txHash: string;
  blockHeight: number;
}

export interface AssetFilterEntry {
  policyId: string;
  assetNameHex: string;
}

export interface TransactionInfo {
  txHash: string;
  blockHash: string;
  blockHeight: number;
  amount: number;
  fee: number;
  confirmations: number;
  lastSeen: number; // Unix timestamp from Blockfrost
  utxosCreated: WatchedUtxo[];
  utxosSpent: SpentUtxoRef[];
}

export interface BlockInfo {
  height: number;
  hash: string;
  time: number;
  slot: number;
}

export interface AddressInfo {
  address: string;
  balance: number;
  stakeAddress: string | null;
  type: string;
  transactions?: TransactionInfo[];
}

const logger = cds.log("ODATANO-WATCH");

let blockfrostClient: BlockFrostAPI | null = null;

interface BlockfrostTxOutput {
  address: string;
  amount: BlockfrostAmount[];
  output_index: number;
  data_hash?: string | null;
  inline_datum?: string | null;
  reference_script_hash?: string | null;
  collateral?: boolean;
}

interface BlockfrostTxInput {
  address: string;
  amount: BlockfrostAmount[];
  tx_hash: string;
  output_index: number;
  data_hash?: string | null;
  inline_datum?: string | null;
  reference_script_hash?: string | null;
  collateral?: boolean;
  reference?: boolean;
}

interface BlockfrostTxUtxos {
  hash: string;
  inputs: BlockfrostTxInput[];
  outputs: BlockfrostTxOutput[];
}

/**
 * Split a Blockfrost amount[] into a lovelace string and a list of native assets.
 * Lovelace is kept as a string (not a JS number) — values exceed 2^53 on whale UTxOs.
 */
function splitAmounts(amounts: BlockfrostAmount[]): { lovelace: string; assets: WatchedAsset[] } {
  let lovelace = "0";
  const assets: WatchedAsset[] = [];
  for (const a of amounts) {
    if (a.unit === "lovelace") {
      lovelace = a.quantity;
    } else {
      assets.push({ unit: a.unit, quantity: a.quantity });
    }
  }
  return { lovelace, assets };
}

/**
 * Filter the inputs/outputs of a tx to those touching any address in the
 * watched set and shape them into the public WatchedUtxo / SpentUtxoRef payload.
 *
 * Reference-script and collateral inputs are excluded — they don't represent
 * value movement at the watched address.
 *
 * The set form is so the credential watcher can pass every bech32 derivative
 * of a payment credential at once. Address watchers pass a singleton set.
 */
export function extractUtxoDeltas(
  txUtxos: BlockfrostTxUtxos,
  txHash: string,
  watchedAddresses: Set<string>,
): { utxosCreated: WatchedUtxo[]; utxosSpent: SpentUtxoRef[] } {
  const utxosCreated: WatchedUtxo[] = [];
  for (const out of txUtxos.outputs) {
    if (out.collateral) continue;
    if (!watchedAddresses.has(out.address)) continue;
    const { lovelace, assets } = splitAmounts(out.amount);
    utxosCreated.push({
      txHash,
      outputIndex: out.output_index,
      lovelace,
      assets,
      ...(out.inline_datum ? { inlineDatumHex: out.inline_datum } : {}),
      ...(out.reference_script_hash ? { referenceScriptHash: out.reference_script_hash } : {}),
    });
  }

  const utxosSpent: SpentUtxoRef[] = [];
  for (const inp of txUtxos.inputs) {
    if (inp.collateral) continue;
    if (inp.reference) continue;
    if (!watchedAddresses.has(inp.address)) continue;
    utxosSpent.push({ txHash: inp.tx_hash, outputIndex: inp.output_index });
  }

  return { utxosCreated, utxosSpent };
}

/**
 * Parse a stored asset-filter JSON string. Returns `null` for absent/invalid
 * input rather than throwing — callers (the watcher) should keep polling
 * even if the filter column is malformed somehow, treating it as "no filter."
 */
export function parseAssetFilter(json: string | null | undefined): AssetFilterEntry[] | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    return parsed as AssetFilterEntry[];
  } catch {
    return null;
  }
}

/**
 * True iff at least one utxo in `utxosCreated` carries an asset listed in
 * the filter. A null filter means "no filter applied" → always true.
 *
 * Asset units in the WatchedUtxo come as `policyId + assetNameHex`
 * concatenated hex; we reconstruct the same form from the filter entry to
 * compare.
 */
export function matchesAssetFilter(
  utxosCreated: WatchedUtxo[],
  filter: AssetFilterEntry[] | null,
): boolean {
  if (filter === null) return true;
  if (utxosCreated.length === 0) return false;

  const wanted = new Set(filter.map(f => f.policyId + f.assetNameHex));
  for (const utxo of utxosCreated) {
    for (const asset of utxo.assets) {
      if (wanted.has(asset.unit)) return true;
    }
  }
  return false;
}

/**
 * Fetch a single tx's UTxOs and project deltas against a watched address set.
 * Used by the credential watcher, which already has the txHash from Koios and
 * needs the rich (assets + inline datum) shape.
 */
export async function fetchTxUtxos(
  txHash: string,
  watchedAddresses: Set<string>,
): Promise<{ utxosCreated: WatchedUtxo[]; utxosSpent: SpentUtxoRef[] } | null> {
  if (!blockfrostClient) {
    return null;
  }
  return handleBackendRequest(async () => {
    const txUtxos = await blockfrostClient!.txsUtxos(txHash);
    return extractUtxoDeltas(txUtxos as BlockfrostTxUtxos, txHash, watchedAddresses);
  }, "Blockfrost");
}

/**
 * Initialize Blockfrost client
 */
export function initializeClient(config: { blockfrostApiKey?: string; network?: string }): BlockFrostAPI {
  if (blockfrostClient) {
    return blockfrostClient;
  }

  try {
    blockfrostClient = new BlockFrostAPI({
      projectId: config.blockfrostApiKey!,
      network: config.network as 'mainnet' | 'preprod' | 'preview',
    });

    logger.debug("Blockfrost client initialized", {
      network: config.network,
      projectId: config.blockfrostApiKey?.substring(0, 10) + "..."
    });

    return blockfrostClient;
  } catch (err) {
    logger.error("Failed to initialize Blockfrost client:", err);
    throw err;
  }
}

/**
 * Fetch transactions for a specific address.
 *
 * `fromBlock` is exclusive (txs with `block_height > fromBlock`); `toBlock`
 * is inclusive when set (txs with `block_height <= toBlock`). Pass `toBlock`
 * during Ogmios-mode backfill to cap at the chainSync cursor — prevents
 * overlap with chainSync's per-block delivery.
 */
export async function fetchAddressTransactions(
  address: string,
  fromBlock: number | null = null,
  toBlock: number | null = null,
): Promise<TransactionInfo[] | null> {

  if (!blockfrostClient) {
    return null;
  }

  return handleBackendRequest(async () => {
    logger.debug(`Fetching transactions for address: ${address}`);

    const transactions = await blockfrostClient!.addressesTransactions(
      address,
      {
        order: "asc",
        count: 100,
      }
    );

    if (!transactions || transactions.length === 0) {
      return null;
    }

    logger.debug(`Found ${transactions.length} transactions`);

    // Fetch latest block once outside the loop for efficiency
    const latestBlock = await blockfrostClient!.blocksLatest();
    const latestBlockHeight = latestBlock.height ?? 0;

    const watchedSet = new Set([address]);
    const parsedTxs: TransactionInfo[] = [];
    for (const tx of transactions) {
      try {
        const txDetails = await blockfrostClient!.txs(tx.tx_hash);
        const txUtxos = await blockfrostClient!.txsUtxos(tx.tx_hash);

        // Honor block 0 as a real cursor — `fromBlock != null` distinguishes
        // "no cursor (initial poll)" from "cursor is genesis."
        if (fromBlock != null && txDetails.block_height <= fromBlock) {
          continue;
        }
        if (toBlock != null && txDetails.block_height > toBlock) {
          continue;
        }

        const { utxosCreated, utxosSpent } = extractUtxoDeltas(txUtxos as BlockfrostTxUtxos, tx.tx_hash, watchedSet);

        const amount = txUtxos.outputs[0]?.amount
          ? parseFloat(txUtxos.outputs[0].amount.find((a: BlockfrostAmount) => a.unit === "lovelace")?.quantity || "0") / 1000000
          : 0;

        const confirmations = latestBlockHeight - txDetails.block_height;

        parsedTxs.push({
          txHash: tx.tx_hash,
          blockHeight: txDetails.block_height,
          blockHash: txDetails.block,
          amount,
          fee: parseFloat(txDetails.fees) / 1000000,
          lastSeen: txDetails.block_time,
          confirmations,
          utxosCreated,
          utxosSpent,
        });

      } catch (txErr) {
        logger.error(`Error fetching details for tx ${tx.tx_hash}:`, txErr);
      }
    }

    return parsedTxs.length > 0 ? parsedTxs : null;
  }, "Blockfrost");
}

/**
 * Get latest block information
 */
export async function getLatestBlock(): Promise<BlockInfo | null> {
  if (!blockfrostClient) {
    return null;
  }

  return handleBackendRequest(async () => {
    const block = await blockfrostClient!.blocksLatest();
    return {
      height: block.height ?? 0,
      hash: block.hash,
      time: block.time ?? 0,
      slot: block.slot ?? 0,
    };
  }, "Blockfrost");
}

/**
 * Get address information
 */
export async function getAddressInfo(address: string): Promise<AddressInfo | null> {
  if (!blockfrostClient) {
    return null;
  }

  return handleBackendRequest(async () => {
    const info = await blockfrostClient!.addresses(address);
    
    const transactions = await fetchAddressTransactions(address);

    return {
      address: info.address,
      balance: parseFloat(info.amount.find((a: BlockfrostAmount) => a.unit === "lovelace")?.quantity || "0") / 1000000,
      stakeAddress: info.stake_address,
      type: info.type,
      transactions: transactions || [],
    };
  }, "Blockfrost");
}

export async function getTransaction(hash: string): Promise<TransactionInfo | null> {
  if (!blockfrostClient) {
    return null;
  }
  
  return handleBackendRequest(async () => {
    const tx = await blockfrostClient!.txs(hash);

    // Get latest block to calculate confirmations
    const latestBlock = await blockfrostClient!.blocksLatest();
    const latestBlockHeight = latestBlock.height ?? 0;
    const confirmations = latestBlockHeight - tx.block_height;

    return {
      txHash: tx.hash,
      blockHash: tx.block,
      blockHeight: tx.block_height,
      amount: parseFloat(tx.output_amount.find((a: BlockfrostAmount) => a.unit === "lovelace")?.quantity || "0") / 1000000,
      fee: parseFloat(tx.fees) / 1000000,
      confirmations,
      lastSeen: tx.block_time,
      utxosCreated: [],
      utxosSpent: [],
    };
  }, "Blockfrost").catch(err => {
    // Transaction might not be on chain yet or be in mempool
    logger.debug(`Transaction ${hash} not found:`, err);
    return null;
  });
}

interface BlockfrostPolicyAsset {
  asset: string;
  quantity: string;
}

interface BlockfrostAssetHistoryRow {
  tx_hash: string;
  action: 'minted' | 'burned';
  amount: string;
}

/**
 * Project mint/burn events for a minting policy as `PolicyAssetEvent[]`.
 *
 * Implementation walks Blockfrost per-asset:
 *   1. `assetsPolicyByIdAll(policyId)` — enumerate assets under the policy.
 *   2. For each asset, `assetsHistory(asset)` — list mint/burn actions.
 *   3. Resolve `block_height` per tx via `txs(hash)` (cached across assets).
 *
 * Returns `null` when the policy contains more than `assetCap` distinct
 * assets — the per-asset fan-out makes large NFT-style policies impractical
 * for this v0 path. Callers should warn and skip.
 */
export async function fetchPolicyAssetEvents(
  policyId: string,
  fromBlock: number | null,
  assetCap: number,
  toBlock: number | null = null,
): Promise<PolicyAssetEvent[] | null> {
  if (!blockfrostClient) {
    return null;
  }

  return handleBackendRequest(async () => {
    const assets = await blockfrostClient!.assetsPolicyByIdAll(policyId) as BlockfrostPolicyAsset[];

    if (assets.length > assetCap) {
      logger.warn(
        `Policy ${policyId} has ${assets.length} assets (cap: ${assetCap}); skipping. ` +
        `Increase policyAssetCap to opt in or use a future Ogmios backend for NFT policies.`,
      );
      return null;
    }

    if (assets.length === 0) {
      return [];
    }

    const events: PolicyAssetEvent[] = [];
    const txBlockCache = new Map<string, number>();

    for (const asset of assets) {
      const assetNameHex = asset.asset.slice(policyId.length);
      // Use `assetsHistoryAll` so we don't silently truncate at 100 rows on
      // policies with high mint/burn velocity.
      const history = await blockfrostClient!.assetsHistoryAll(asset.asset) as BlockfrostAssetHistoryRow[];

      for (const row of history) {
        let blockHeight = txBlockCache.get(row.tx_hash);
        if (blockHeight === undefined) {
          const tx = await blockfrostClient!.txs(row.tx_hash);
          blockHeight = tx.block_height;
          txBlockCache.set(row.tx_hash, blockHeight);
        }

        if (fromBlock !== null && blockHeight <= fromBlock) {
          continue;
        }
        if (toBlock !== null && blockHeight > toBlock) {
          continue;
        }

        events.push({
          policyId,
          assetNameHex,
          quantity: row.amount,
          action: row.action,
          txHash: row.tx_hash,
          blockHeight,
        });
      }
    }

    return events;
  }, "Blockfrost");
}

/**
 * Verify if Blockfrost is available and configured
 */
export function isAvailable(): boolean {
  return blockfrostClient !== null;
}
