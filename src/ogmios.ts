import cds from "@sap/cds";
import * as Ogmios from "@cardano-ogmios/client";
import type { Schema } from "@cardano-ogmios/client";

const logger = cds.log("ODATANO-WATCH");

export interface OgmiosConfig {
  url: string;
  network: "mainnet" | "preview" | "preprod";
  maxRetries?: number;
  retryDelayMs?: number;
}

export interface ChainSyncCursor {
  slot: number;
  blockHash: string;
}

export interface ChainSyncHandlers {
  /**
   * Called for each new block delivered by chainSync. The implementation
   * must call `next()` when it's ready for the next message — chainSync is
   * a request/response protocol; the next message is only sent after.
   * If `next()` is not called, the stream stalls on this block.
   */
  rollForward(block: Schema.Block, tip: Schema.Tip | "origin", next: () => void): Promise<void>;
  /**
   * Called when the chain rolls back to `point`. The implementation should
   * delete persisted state past the rollback point and emit
   * `cardano.rollback`. Then call `next()` to resume.
   */
  rollBackward(point: Schema.Point | "origin", tip: Schema.Tip | "origin", next: () => void): Promise<void>;
}

let config: OgmiosConfig | null = null;
let context: Ogmios.InteractionContext | null = null;
let client: Ogmios.ChainSynchronization.ChainSynchronizationClient | null = null;
let stopRequested = false;
let reconnectTimer: NodeJS.Timeout | null = null;

export function initializeClient(cfg: OgmiosConfig): void {
  if (!/^wss?:\/\//.test(cfg.url)) {
    throw new Error(`Invalid Ogmios URL: ${cfg.url} (expected ws:// or wss://)`);
  }
  config = {
    ...cfg,
    maxRetries: cfg.maxRetries ?? 0, // 0 = retry forever
    retryDelayMs: cfg.retryDelayMs ?? 1000,
  };
  logger.debug("Ogmios client initialized", { url: cfg.url, network: cfg.network });
}

export function isAvailable(): boolean {
  return config !== null;
}

/**
 * Open the chainSync stream. `cursor` is the last applied point — if null,
 * resumes from origin (genesis). Tries to find an intersection with the node's
 * canonical chain; if the cursor is on an orphaned chain (rare under typical
 * operation, only after deep reorgs), the node will RollBackward to a common
 * ancestor before the next RollForward.
 */
export async function start(
  cursor: ChainSyncCursor | null,
  handlers: ChainSyncHandlers,
): Promise<void> {
  if (!config) {
    throw new Error("Ogmios client not initialized");
  }
  if (client) {
    logger.warn("Ogmios chainSync already started");
    return;
  }

  stopRequested = false;
  await connect(cursor, handlers);
}

async function connect(
  cursor: ChainSyncCursor | null,
  handlers: ChainSyncHandlers,
): Promise<void> {
  if (!config) throw new Error("Ogmios client not initialized");

  const wsAddress = config.url;
  let attempts = 0;

  while (!stopRequested) {
    try {
      logger.debug(`Ogmios: connecting to ${wsAddress} (attempt ${attempts + 1})`);

      context = await Ogmios.createInteractionContext(
        (err) => {
          logger.error("Ogmios WebSocket error:", err);
        },
        (code, reason) => {
          logger.warn(`Ogmios WebSocket closed: code=${code} reason=${reason || "(none)"}`);
          // The chainSync client teardown is driven by close events;
          // schedule a reconnect attempt.
          if (!stopRequested) scheduleReconnect(cursor, handlers);
        },
        { connection: { address: { webSocket: wsAddress, http: wsAddress.replace(/^ws/, "http") } } },
      );

      client = await Ogmios.createChainSynchronizationClient(
        context,
        {
          rollForward: async (response, next) => {
            await handlers.rollForward(response.block, response.tip, next);
          },
          rollBackward: async (response, next) => {
            await handlers.rollBackward(response.point, response.tip, next);
          },
        },
        { sequential: true },
      );

      const points: (Schema.Point | "origin")[] = cursor
        ? [{ slot: cursor.slot, id: cursor.blockHash }, "origin"]
        : ["origin"];

      const intersection = await client.resume(points);
      logger.info(
        `Ogmios chainSync resumed at`,
        intersection.intersection === "origin"
          ? "origin"
          : { slot: intersection.intersection.slot, id: intersection.intersection.id },
      );
      // Successfully connected — reset attempts and return; the chainSync
      // client drives the loop from here via the registered handlers.
      return;
    } catch (err) {
      attempts++;
      logger.error(`Ogmios connect failed (attempt ${attempts}):`, err);
      if (config.maxRetries && attempts >= config.maxRetries) {
        logger.error(`Ogmios: max retries (${config.maxRetries}) exhausted; giving up`);
        throw err;
      }
      const delay = backoff(attempts, config.retryDelayMs ?? 1000);
      logger.debug(`Ogmios: retrying in ${delay}ms`);
      await sleep(delay);
    }
  }
}

function scheduleReconnect(cursor: ChainSyncCursor | null, handlers: ChainSyncHandlers): void {
  if (reconnectTimer) return;
  const delay = backoff(1, config?.retryDelayMs ?? 1000);
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    if (stopRequested) return;
    try {
      client = null;
      context = null;
      await connect(cursor, handlers);
    } catch (err) {
      logger.error("Ogmios reconnect ultimately failed:", err);
    }
  }, delay);
}

function backoff(attempt: number, base: number): number {
  // Exponential up to 30s, with a jitter floor on attempt 1 so we don't
  // immediately hammer a node that just closed.
  const exp = Math.min(base * 2 ** Math.min(attempt - 1, 5), 30_000);
  return Math.max(exp, 250);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function shutdown(): Promise<void> {
  stopRequested = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (client) {
    try {
      await client.shutdown();
    } catch (err) {
      logger.warn("Ogmios shutdown error:", err);
    }
    client = null;
  }
  context = null;
}
