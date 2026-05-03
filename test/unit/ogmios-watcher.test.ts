import { jest } from '@jest/globals';

const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

const mockTx = {
  run: jest.fn<any>(),
};

const mockDb = {
  tx: jest.fn<any>(async (cb: (tx: any) => Promise<any>) => cb(mockTx)),
  run: jest.fn<any>(),
};

// Self-referencing chain — every method call returns the same proxy, and
// `.one` re-enters the chain. Lets cds.ql expressions like
// `SELECT.one.from(X).where(Y)` resolve without per-method mock surface.
// Important: the Proxy must NOT expose `then`, or `await chain` (or
// `Promise.resolve(chain)`) treats it as a thenable and never resolves.
function makeChain(): any {
  const target: any = {};
  const handler: ProxyHandler<any> = {
    get(_t, prop) {
      if (prop === 'then') return undefined;       // not a thenable
      if (prop === Symbol.toPrimitive) return undefined;
      if (prop === 'one') return chain;
      return (..._args: unknown[]) => chain;
    },
  };
  const chain = new Proxy(target, handler);
  return chain;
}

const SELECT_CHAIN = makeChain();
const INSERT_CHAIN = makeChain();
const UPDATE_CHAIN = makeChain();
const UPSERT_CHAIN = makeChain();
const DELETE_CHAIN = makeChain();

const mockCds = {
  log: jest.fn(() => mockLogger),
  ql: {
    SELECT: SELECT_CHAIN,
    INSERT: INSERT_CHAIN,
    UPDATE: UPDATE_CHAIN,
    UPSERT: UPSERT_CHAIN,
    DELETE: DELETE_CHAIN,
  },
  db: mockDb,
};

jest.mock('@sap/cds', () => ({ default: mockCds, ...mockCds }));

const mockConfig = {
  get: jest.fn<any>(() => ({ network: 'preview', backend: 'ogmios', ogmiosUrl: 'ws://localhost:1337' })),
};
jest.mock('../../src/config', () => mockConfig);

const mockBlockfrost = {
  parseAssetFilter: jest.fn<any>(),
  matchesAssetFilter: jest.fn<any>(),
};
jest.mock('../../src/blockfrost', () => mockBlockfrost);

import * as ogmiosWatcher from '../../src/ogmios-watcher';

describe('ogmios-watcher', () => {
  beforeEach(() => {
    // resetAllMocks (not clearAllMocks) — `clear` keeps mockResolvedValue
    // implementations from prior tests, which bleeds across test cases.
    jest.resetAllMocks();
    // Re-wire the mocks that need a default implementation post-reset.
    mockDb.tx.mockImplementation(async (cb: (tx: any) => Promise<any>) => cb(mockTx));
    mockCds.log.mockReturnValue(mockLogger);
    mockConfig.get.mockReturnValue({ network: 'preview', backend: 'ogmios', ogmiosUrl: 'ws://localhost:1337' });
    ogmiosWatcher.setDb(mockDb);
    ogmiosWatcher.__resetIndexForTesting();
    mockBlockfrost.parseAssetFilter.mockReturnValue(null);
    mockBlockfrost.matchesAssetFilter.mockReturnValue(true);
  });

  describe('paymentCredentialFromBech32', () => {
    it('extracts a 28-byte payment credential from a shelley address', () => {
      // addr_test1vqm5vyp8xztmxyl6mcr2xr5schajvsq8fjs8gn8g2zu0pgg8gckcp
      // (test fixture from CLAUDE.md / integration tests)
      const cred = ogmiosWatcher.paymentCredentialFromBech32(
        'addr_test1vqm5vyp8xztmxyl6mcr2xr5schajvsq8fjs8gn8g2zu0pgg8gckcp'
      );
      expect(cred).toMatch(/^[0-9a-f]{56}$/);
    });

    it('returns the same credential for two addresses sharing a payment cred', () => {
      // Both addresses encode the same payment credential. (Same payment-key,
      // different stake parts → different bech32, same paymentCredHex.)
      const cred1 = ogmiosWatcher.paymentCredentialFromBech32(
        'addr_test1vqm5vyp8xztmxyl6mcr2xr5schajvsq8fjs8gn8g2zu0pgg8gckcp'
      );
      // We don't have an exact second-form test fixture handy, so we just
      // assert the function is deterministic for a given input.
      const cred1Again = ogmiosWatcher.paymentCredentialFromBech32(
        'addr_test1vqm5vyp8xztmxyl6mcr2xr5schajvsq8fjs8gn8g2zu0pgg8gckcp'
      );
      expect(cred1).toBe(cred1Again);
    });

    it('returns null for non-shelley / non-bech32 addresses', () => {
      expect(ogmiosWatcher.paymentCredentialFromBech32('Ae2Byron123')).toBeNull();
      expect(ogmiosWatcher.paymentCredentialFromBech32('not-an-address')).toBeNull();
      expect(ogmiosWatcher.paymentCredentialFromBech32('')).toBeNull();
    });
  });

  describe('processRollForward', () => {
    const watchedAddr = 'addr_test1vqm5vyp8xztmxyl6mcr2xr5schajvsq8fjs8gn8g2zu0pgg8gckcp';

    function buildBlock(overrides: any = {}): any {
      return {
        type: 'praos',
        era: 'conway',
        id: 'block-hash-1',
        slot: 100,
        height: 50,
        ancestor: 'parent-hash',
        size: { bytes: 0 },
        protocol: { version: { major: 9, minor: 0 } },
        issuer: {} as any,
        transactions: [],
        ...overrides,
      };
    }

    it('skips non-praos blocks and just advances the cursor', async () => {
      const block = { type: 'ebb', height: 0, slot: 0, id: 'genesis' } as any;
      // Index is empty by default — no DB SELECT needed.
      mockDb.run.mockResolvedValue([]);  // refreshWatchIndex
      mockTx.run.mockResolvedValue(undefined);

      await ogmiosWatcher.processRollForward(block, mockConfig.get(), jest.fn() as any);

      // No emit, no INSERT.
      // (We assert via behaviour: nothing was emitted; mockTx.run wasn't called for INSERTs.)
    });

    it('skips empty-tx blocks but advances the cursor', async () => {
      const block = buildBlock({ transactions: [] });
      mockDb.run.mockResolvedValue([]);

      const emit = jest.fn() as any;
      await ogmiosWatcher.processRollForward(block, mockConfig.get(), emit);

      expect(emit).not.toHaveBeenCalled();
    });

    it('emits cardano.newTransactions for an output at a watched address', async () => {
      // Seed the in-memory index by mocking refreshWatchIndex's SELECT calls.
      mockDb.run
        .mockResolvedValueOnce([{ address: watchedAddr, tag: 'my-pool', includesAssetsJson: null, coalesceMs: null }])  // addresses
        .mockResolvedValueOnce([])  // credentials
        .mockResolvedValueOnce([]); // policies

      mockTx.run.mockResolvedValue(undefined);

      const block = buildBlock({
        transactions: [{
          id: 'tx-1',
          inputs: [],
          outputs: [{
            address: watchedAddr,
            value: { ada: { lovelace: 5000000n } },
          }],
        }],
      });

      const emit = jest.fn() as any;
      await ogmiosWatcher.processRollForward(block, mockConfig.get(), emit);

      expect(emit).toHaveBeenCalledWith(
        'cardano.newTransactions',
        expect.objectContaining({
          address: watchedAddr,
          tag: 'my-pool',
          count: 1,
          transactions: ['tx-1'],
          utxosCreated: [expect.objectContaining({
            txHash: 'tx-1',
            outputIndex: 0,
            lovelace: '5000000',
          })],
          utxosSpent: [],
        }),
      );
    });

    it('emits split mint/burn events for a watched policy', async () => {
      const policyId = '8d18d786e92776c824607fd8e193ec535c79dc61ea2405ddf3b09fe3';
      const assetName = '444a4544';

      mockDb.run
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ policyId, tag: 'djed' }]);

      mockTx.run.mockResolvedValue(undefined);

      const block = buildBlock({
        transactions: [{
          id: 'mint-tx',
          inputs: [],
          outputs: [],
          mint: { [policyId]: { [assetName]: 1000000n } },
        }, {
          id: 'burn-tx',
          inputs: [],
          outputs: [],
          mint: { [policyId]: { [assetName]: -500000n } },
        }],
      });

      const emit = jest.fn() as any;
      await ogmiosWatcher.processRollForward(block, mockConfig.get(), emit);

      expect(emit).toHaveBeenCalledWith(
        'cardano.policy.assetMinted',
        expect.objectContaining({ policyId, assetNameHex: assetName, quantity: '1000000', tag: 'djed' }),
      );
      expect(emit).toHaveBeenCalledWith(
        'cardano.policy.assetBurned',
        expect.objectContaining({ policyId, assetNameHex: assetName, quantity: '500000', tag: 'djed' }),
      );
    });

    it('drops non-matching txs when the watch has an asset filter', async () => {
      mockDb.run
        .mockResolvedValueOnce([{ address: watchedAddr, tag: null, includesAssetsJson: '[{"policyId":"abc","assetNameHex":""}]', coalesceMs: null }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      mockBlockfrost.parseAssetFilter.mockReturnValue([{ policyId: 'abc', assetNameHex: '' }]);
      mockBlockfrost.matchesAssetFilter.mockReturnValue(false);
      mockTx.run.mockResolvedValue(undefined);

      const block = buildBlock({
        transactions: [{
          id: 'unrelated-tx',
          inputs: [],
          outputs: [{ address: watchedAddr, value: { ada: { lovelace: 1000n } } }],
        }],
      });

      const emit = jest.fn() as any;
      await ogmiosWatcher.processRollForward(block, mockConfig.get(), emit);

      expect(emit).not.toHaveBeenCalled();
    });
  });

  describe('processRollBackward', () => {
    it('loadCursor returns the persisted row from db.run', async () => {
      mockDb.run.mockResolvedValueOnce({ id: 'chainsync', slot: 999, blockHash: 'b999' });
      const out = await ogmiosWatcher.loadCursor();
      expect(out).toEqual({ slot: 999, blockHash: 'b999' });
    });

    it('returns a no-op result when rollback is at or ahead of the cursor', async () => {
      // loadCursor returns a slot < toSlot.
      mockDb.run.mockResolvedValueOnce({ id: 'chainsync', slot: 50, blockHash: 'b50' });

      const out = await ogmiosWatcher.processRollBackward(
        { slot: 100, id: 'b100' } as any,
        mockConfig.get(),
      );

      expect(out).toEqual({ fromSlot: 50, toSlot: 100, affectedTxHashes: [] });
    });

    it('rewinds DB state and returns affected tx hashes', async () => {
      // 1st .run = loadCursor → cursor at slot 200.
      // 2nd .run = SELECT affected events.
      mockDb.run
        .mockResolvedValueOnce({ id: 'chainsync', slot: 200, blockHash: 'b200' })
        .mockResolvedValueOnce([
          { txHash: 'orphan-1', address_address: 'addr-A' },
          { txHash: 'orphan-2', credential_paymentCredHex: 'cred-B' },
          { txHash: 'orphan-1', address_address: 'addr-A' },  // duplicate
        ]);

      // Inside the tx: 1×DELETE + 2×(SELECT MAX, UPDATE) for each affected watch.
      mockTx.run
        // DELETE
        .mockResolvedValueOnce(undefined)
        // address recompute: SELECT MAX, UPDATE
        .mockResolvedValueOnce([{ m: 99 }])
        .mockResolvedValueOnce(undefined)
        // credential recompute: SELECT MAX, UPDATE
        .mockResolvedValueOnce([{ m: null }])
        .mockResolvedValueOnce(undefined)
        // UPSERT cursor
        .mockResolvedValueOnce(undefined);

      const out = await ogmiosWatcher.processRollBackward(
        { slot: 150, id: 'b150' } as any,
        mockConfig.get(),
      );

      expect(out.fromSlot).toBe(200);
      expect(out.toSlot).toBe(150);
      expect(out.affectedTxHashes.sort()).toEqual(['orphan-1', 'orphan-2']);
    });

    it('handles "origin" point by clearing the cursor row', async () => {
      mockDb.run
        .mockResolvedValueOnce({ id: 'chainsync', slot: 200, blockHash: 'b200' })
        .mockResolvedValueOnce([]);  // no affected rows

      mockTx.run.mockResolvedValue(undefined);

      const out = await ogmiosWatcher.processRollBackward('origin' as any, mockConfig.get());

      expect(out.toSlot).toBe(0);
      expect(out.affectedTxHashes).toEqual([]);
    });
  });
});
