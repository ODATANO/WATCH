/** 
 * Input Validators
 * Validation functions for common blockchain data types
 */

/**
 * Validate transaction hash (64 character hex string for Blake2b-256)
 * @param hash - The transaction hash to validate
 * @returns {boolean} True if valid
 */
export function isTxHash(hash: unknown): boolean {
  if (typeof hash !== 'string') return false;
  return /^[a-f0-9]{64}$/i.test(hash);
}

/**
 * Validate block hash (64 character hex string for Blake2b-256)
 * @param hash - The block hash to validate
 * @returns {boolean} True if valid
 */
export function isBlockHash(hash: unknown): boolean {
  if (typeof hash !== 'string') return false;
  return /^[a-f0-9]{64}$/i.test(hash);
}

/**
 * Validate a Cardano payment credential as 56-character hex (28 bytes).
 * Both payment-key hashes and script hashes are 28 bytes; this validator
 * accepts either.
 * @param hex - The credential to validate
 * @returns {boolean} True if valid
 */
export function isPaymentCredHex(hex: unknown): boolean {
  if (typeof hex !== 'string') return false;
  return /^[a-f0-9]{56}$/i.test(hex);
}

/**
 * Validate a Cardano minting policy ID as 56-character hex (28 bytes).
 * Same shape as PaymentCredHex but kept distinct for clarity at call sites.
 * @param hex - The policy ID to validate
 * @returns {boolean} True if valid
 */
export function isPolicyId(hex: unknown): boolean {
  if (typeof hex !== 'string') return false;
  return /^[a-f0-9]{56}$/i.test(hex);
}

/**
 * Validate an asset name as hex (0–32 bytes → 0–64 hex chars). Empty allowed
 * — Cardano permits empty asset names (e.g. ADA-handle-style policies).
 * @param hex - The asset name hex to validate
 * @returns {boolean} True if valid
 */
export function isAssetNameHex(hex: unknown): boolean {
  if (typeof hex !== 'string') return false;
  return /^[a-f0-9]{0,64}$/i.test(hex);
}

/**
 * Validate the replay scope param. Accepts 'address', 'credential', 'policy'.
 * @param scope - The scope string
 * @returns {boolean} True if valid
 */
export function isWatchScope(scope: unknown): boolean {
  return scope === 'address' || scope === 'credential' || scope === 'policy';
}

/**
 * Validate `coalesceMs` (P9). Positive integer up to 5 minutes. Larger
 * windows are almost certainly a misuse — raise the poll interval instead.
 * @param value - The coalesce window in milliseconds
 * @returns {boolean} True if valid
 */
export function isCoalesceMs(value: unknown): boolean {
  if (typeof value !== 'number') return false;
  if (!Number.isInteger(value)) return false;
  return value > 0 && value <= 300_000;
}

/**
 * Validate the asset-filter JSON used by P8 (`includesAssetsJson`). The
 * filter is a JSON array of `{ policyId, assetNameHex }` entries. The empty
 * array is rejected — a no-op filter should be expressed by leaving the
 * column null, not by storing `[]`.
 * @param json - The JSON string to validate
 * @returns {boolean} True if valid
 */
export function isAssetFilterJson(json: unknown): boolean {
  if (typeof json !== 'string') return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return false;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return false;
  for (const entry of parsed) {
    if (entry === null || typeof entry !== 'object') return false;
    const e = entry as Record<string, unknown>;
    if (!isPolicyId(e.policyId)) return false;
    if (!isAssetNameHex(e.assetNameHex)) return false;
  }
  return true;
}

/**
 * Validate Cardano Bech32 address
 * Note: Cardano addresses are always lowercase per convention, so this
 * validator intentionally only accepts lowercase characters.
 * @param address - The address to validate
 * @returns {boolean} True if valid
 */
export function isValidBech32Address(address: unknown): boolean {
  if (typeof address !== 'string') return false;

  // Basic Bech32 pattern for Cardano addresses
  // addr1 (mainnet) or addr_test1 (testnet) followed by lowercase alphanumeric characters
  const bech32Pattern = /^(addr1|addr_test1)[a-z0-9]{53,98}$/;

  return bech32Pattern.test(address);
}

/**
 * Validate network type
 * @param network - The network to validate
 * @returns {boolean} True if valid
 */
export function isValidNetwork(network: unknown): boolean {
  if (typeof network !== 'string') return false;
  
  const validNetworks = ['mainnet', 'preview', 'preprod'];
  return validNetworks.includes(network.toLowerCase());
}

/**
 * Validate epoch number
 * @param epoch - The epoch number to validate
 * @returns {boolean} True if valid
 */
export function isEpochNumber(epoch: unknown): boolean {
  if (typeof epoch !== 'number') return false;
  return Number.isInteger(epoch) && epoch >= 0;
}

/**
 * Validate positive integer
 * @param value - The value to validate
 * @returns {boolean} True if valid
 */
export function isPositiveInteger(value: unknown): boolean {
  if (typeof value !== 'number') return false;
  return Number.isInteger(value) && value > 0;
}

/**
 * Validate non-negative integer
 * @param value - The value to validate
 * @returns {boolean} True if valid
 */
export function isNonNegativeInteger(value: unknown): boolean {
  if (typeof value !== 'number') return false;
  return Number.isInteger(value) && value >= 0;
}

/**
 * Validate string not empty
 * @param value - The value to validate
 * @returns {boolean} True if valid
 */
export function isNonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}
