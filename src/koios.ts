import cds from "@sap/cds";

const logger = cds.log("ODATANO-WATCH");

interface KoiosConfig {
  network: "mainnet" | "preview" | "preprod";
  apiKey?: string;
}

let koiosConfig: KoiosConfig | null = null;

export function initializeClient(config: { network?: string; koiosApiKey?: string }): void {
  const network = (config.network ?? "preview") as KoiosConfig["network"];
  if (!["mainnet", "preview", "preprod"].includes(network)) {
    throw new Error(`Invalid Koios network: ${network}`);
  }
  koiosConfig = { network, apiKey: config.koiosApiKey };
  logger.debug("Koios client initialized", {
    network,
    hasApiKey: !!config.koiosApiKey,
  });
}

export function isAvailable(): boolean {
  return koiosConfig !== null;
}

function baseUrl(network: KoiosConfig["network"]): string {
  switch (network) {
    case "mainnet": return "https://api.koios.rest/api/v1";
    case "preview": return "https://preview.koios.rest/api/v1";
    case "preprod": return "https://preprod.koios.rest/api/v1";
  }
}

async function postJson<T>(
  path: string,
  body: unknown,
  rangeHeader?: string,
): Promise<T> {
  if (!koiosConfig) {
    throw new Error("Koios client not initialized");
  }
  const url = `${baseUrl(koiosConfig.network)}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Accept": "application/json",
  };
  if (koiosConfig.apiKey) {
    headers["Authorization"] = `Bearer ${koiosConfig.apiKey}`;
  }
  if (rangeHeader) {
    headers["Range-Unit"] = "items";
    headers["Range"] = rangeHeader;
  }
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Koios ${path} failed: ${res.status} ${res.statusText} ${text}`);
  }
  return res.json() as Promise<T>;
}

/**
 * PostgREST `Range` header pagination: repeat until a page comes back smaller
 * than `pageSize`. The first poll on a credential with years of history can
 * trigger many pages; later polls (with `_after_block_height` set) usually
 * return a single page.
 */
const KOIOS_PAGE_SIZE = 1000;

async function postJsonPaginated<T>(path: string, body: unknown): Promise<T[]> {
  const all: T[] = [];
  let offset = 0;
  // Hard cap to avoid runaway loops on a misbehaving endpoint.
  const maxPages = 100;
  for (let i = 0; i < maxPages; i++) {
    const range = `${offset}-${offset + KOIOS_PAGE_SIZE - 1}`;
    const page = await postJson<T[]>(path, body, range);
    all.push(...page);
    if (page.length < KOIOS_PAGE_SIZE) return all;
    offset += KOIOS_PAGE_SIZE;
  }
  logger.warn(
    `Koios ${path} hit pagination cap (${maxPages * KOIOS_PAGE_SIZE} rows); ` +
    `truncating. Increase poll frequency or narrow the query.`,
  );
  return all;
}

interface KoiosUtxoRow {
  tx_hash?: string;
  tx_index?: number;
  address: string;
  // Other fields exist (value, asset_list, etc.) — we only need `address`.
}

/**
 * Resolve a payment credential to the set of bech32 addresses currently
 * holding UTxOs at it. The credential is a 28-byte payment-key hash (or
 * script hash) as 56-char hex.
 *
 * Koios has no `/credential_address` endpoint — `/credential_utxos` is the
 * only path. Each row is one UTxO; we dedup by `address`. For shared scripts
 * (Indigo CDP, Minswap V2 pools) this set can still be large.
 *
 * Caveat: this returns only currently-unspent addresses. An address that
 * previously held a UTxO at this credential but has since been emptied is
 * not returned. For the credential-watching use case (`processCredential` /
 * the Ogmios watcher's address-set filter), this is sufficient — any active
 * activity at the credential surfaces a current UTxO somewhere.
 */
export async function getAddressesByCredential(credHex: string): Promise<string[]> {
  const data = await postJsonPaginated<KoiosUtxoRow>("/credential_utxos", {
    _payment_credentials: [credHex],
  });
  const seen = new Set<string>();
  for (const row of data) {
    if (row.address) seen.add(row.address);
  }
  return [...seen];
}

export interface KoiosCredTx {
  txHash: string;
  blockHeight: number;
  blockTime: number;
}

interface KoiosCredTxRow {
  tx_hash: string;
  block_height: number;
  block_time: number;
  epoch_no?: number;
}

/**
 * List transactions touching a payment credential after `afterBlockHeight`.
 * Pass `null` to fetch from genesis (first poll on a new credential).
 *
 * Paginates via PostgREST `Range` header until exhausted (or the safety cap
 * trips at 100 pages × 1000 rows = 100k txs per poll). Beyond that the cap
 * fires and we log a warning; callers should poll more frequently.
 */
export async function getCredentialTxsSince(
  credHex: string,
  afterBlockHeight: number | null,
): Promise<KoiosCredTx[]> {
  const body: Record<string, unknown> = {
    _payment_credentials: [credHex],
  };
  if (afterBlockHeight !== null) {
    body._after_block_height = afterBlockHeight;
  }
  const data = await postJsonPaginated<KoiosCredTxRow>("/credential_txs", body);
  return data.map(row => ({
    txHash: row.tx_hash,
    blockHeight: row.block_height,
    blockTime: row.block_time,
  }));
}
