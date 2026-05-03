import { jest } from '@jest/globals';

// Mock the logger
const mockLogger = {
  debug: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
};

jest.mock('@sap/cds', () => ({
  log: jest.fn(() => mockLogger),
}));

// Mock BlockFrost API
const mockBlockfrostMethods = {
  addressesTransactions: jest.fn<any>(),
  blocksLatest: jest.fn<any>(),
  txs: jest.fn<any>(),
  txsUtxos: jest.fn<any>(),
  addresses: jest.fn<any>(),
  assetsPolicyByIdAll: jest.fn<any>(),
  assetsHistoryAll: jest.fn<any>(),
};

jest.mock('@blockfrost/blockfrost-js', () => ({
  BlockFrostAPI: jest.fn().mockImplementation(() => mockBlockfrostMethods),
}));

// Import after mocks are set up
import * as blockfrost from '../../src/blockfrost';

describe('Blockfrost Module', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('initializeClient', () => {
    it('should initialize client with valid config', () => {
      const config = {
        blockfrostApiKey: 'test-api-key-123',
        network: 'preview',
      };

      const client = blockfrost.initializeClient(config);

      expect(client).toBeDefined();
      expect(mockLogger.debug).toHaveBeenCalled();
    });

    it('should return same client on subsequent calls', () => {
      const config = {
        blockfrostApiKey: 'test-key',
        network: 'mainnet',
      };

      const client1 = blockfrost.initializeClient(config);
      const client2 = blockfrost.initializeClient(config);

      expect(client1).toBe(client2);
    });
  });

  describe('fetchAddressTransactions', () => {
    beforeEach(() => {
      blockfrost.initializeClient({
        blockfrostApiKey: 'test-key',
        network: 'preview',
      });
    });

    it('should return null when no transactions found', async () => {
      mockBlockfrostMethods.addressesTransactions.mockResolvedValue([]);

      const result = await blockfrost.fetchAddressTransactions('addr_test1...');

      expect(result).toBeNull();
    });

    it('should fetch and parse transactions successfully', async () => {
      mockBlockfrostMethods.addressesTransactions.mockResolvedValue([
        { tx_hash: 'hash1' },
      ]);
      mockBlockfrostMethods.blocksLatest.mockResolvedValue({ height: 1100 });
      mockBlockfrostMethods.txs.mockResolvedValue({
        hash: 'hash1',
        block: 'block-hash',
        block_height: 1000,
        block_time: 1640000000,
        fees: '170000',
        output_amount: [{ unit: 'lovelace', quantity: '5000000' }],
      });
      mockBlockfrostMethods.txsUtxos.mockResolvedValue({
        inputs: [],
        outputs: [{
          output_index: 0,
          address: 'addr_test1...',
          amount: [{ unit: 'lovelace', quantity: '5000000' }],
        }],
      });

      const result = await blockfrost.fetchAddressTransactions('addr_test1...');

      expect(result).toHaveLength(1);
      expect(result![0].txHash).toBe('hash1');
      expect(result![0].amount).toBe(5);
      expect(result![0].fee).toBe(0.17);
      expect(result![0].confirmations).toBe(100);
    });

    it('should filter by fromBlock parameter', async () => {
      mockBlockfrostMethods.addressesTransactions.mockResolvedValue([
        { tx_hash: 'hash1' },
        { tx_hash: 'hash2' },
      ]);
      mockBlockfrostMethods.blocksLatest.mockResolvedValue({ height: 1200 });
      mockBlockfrostMethods.txs
        .mockResolvedValueOnce({
          block_height: 900,
          block: 'block1',
          fees: '170000',
          block_time: 1640000000,
        })
        .mockResolvedValueOnce({
          block_height: 1100,
          block: 'block2',
          fees: '170000',
          block_time: 1640001000,
        });
      mockBlockfrostMethods.txsUtxos.mockResolvedValue({
        inputs: [],
        outputs: [{ output_index: 0, address: 'addr_test1...', amount: [{ unit: 'lovelace', quantity: '1000000' }] }],
      });

      const result = await blockfrost.fetchAddressTransactions('addr_test1...', 1000);

      expect(result).toHaveLength(1);
      expect(result![0].blockHeight).toBe(1100);
    });

    it('should handle individual tx fetch errors gracefully', async () => {
      mockBlockfrostMethods.addressesTransactions.mockResolvedValue([
        { tx_hash: 'hash1' },
        { tx_hash: 'hash2' },
      ]);
      mockBlockfrostMethods.blocksLatest.mockResolvedValue({ height: 1000 });
      mockBlockfrostMethods.txs
        .mockRejectedValueOnce(new Error('TX not found'))
        .mockResolvedValueOnce({
          block_height: 950,
          block: 'block2',
          fees: '170000',
          block_time: 1640000000,
        });
      mockBlockfrostMethods.txsUtxos.mockResolvedValue({
        inputs: [],
        outputs: [{ output_index: 0, address: 'addr_test1...', amount: [{ unit: 'lovelace', quantity: '1000000' }] }],
      });

      const result = await blockfrost.fetchAddressTransactions('addr_test1...');

      expect(mockLogger.error).toHaveBeenCalled();
      expect(result).toHaveLength(1);
    });

    it('should handle missing lovelace in amount', async () => {
      mockBlockfrostMethods.addressesTransactions.mockResolvedValue([
        { tx_hash: 'hash1' },
      ]);
      mockBlockfrostMethods.blocksLatest.mockResolvedValue({ height: 1100 });
      mockBlockfrostMethods.txs.mockResolvedValue({
        block_height: 1000,
        block: 'block1',
        fees: '170000',
        block_time: 1640000000,
      });
      mockBlockfrostMethods.txsUtxos.mockResolvedValue({
        inputs: [],
        outputs: [{
          output_index: 0,
          address: 'addr_test1...',
          amount: [{ unit: 'other-token', quantity: '100' }],
        }],
      });

      const result = await blockfrost.fetchAddressTransactions('addr_test1...');

      expect(result![0].amount).toBe(0);
    });

    it('should throw error on API failure', async () => {
      mockBlockfrostMethods.addressesTransactions.mockRejectedValue(
        new Error('API Error')
      );

      await expect(
        blockfrost.fetchAddressTransactions('addr_test1...')
      ).rejects.toThrow();
    });
  });

  describe('getLatestBlock', () => {
    beforeEach(() => {
      blockfrost.initializeClient({
        blockfrostApiKey: 'test-key',
        network: 'preview',
      });
    });

    it('should fetch latest block successfully', async () => {
      mockBlockfrostMethods.blocksLatest.mockResolvedValue({
        height: 1000,
        hash: 'block-hash-123',
        time: 1640000000,
        slot: 12345,
      });

      const result = await blockfrost.getLatestBlock();

      expect(result).toEqual({
        height: 1000,
        hash: 'block-hash-123',
        time: 1640000000,
        slot: 12345,
      });
    });

    it('should handle null values in response', async () => {
      mockBlockfrostMethods.blocksLatest.mockResolvedValue({
        height: null,
        hash: 'block-hash',
        time: null,
        slot: null,
      });

      const result = await blockfrost.getLatestBlock();

      expect(result).toEqual({
        height: 0,
        hash: 'block-hash',
        time: 0,
        slot: 0,
      });
    });

    it('should throw error on API failure', async () => {
      mockBlockfrostMethods.blocksLatest.mockRejectedValue(
        new Error('Network error')
      );

      await expect(blockfrost.getLatestBlock()).rejects.toThrow();
    });
  });

  describe('getAddressInfo', () => {
    beforeEach(() => {
      blockfrost.initializeClient({
        blockfrostApiKey: 'test-key',
        network: 'preview',
      });
    });

    it('should fetch address info with transactions', async () => {
      mockBlockfrostMethods.addresses.mockResolvedValue({
        address: 'addr_test1...',
        amount: [{ unit: 'lovelace', quantity: '10000000' }],
        stake_address: 'stake_test1...',
        type: 'shelley',
      });
      mockBlockfrostMethods.addressesTransactions.mockResolvedValue([]);

      const result = await blockfrost.getAddressInfo('addr_test1...');

      expect(result).toEqual({
        address: 'addr_test1...',
        balance: 10,
        stakeAddress: 'stake_test1...',
        type: 'shelley',
        transactions: [],
      });
    });

    it('should handle missing lovelace in amount array', async () => {
      mockBlockfrostMethods.addresses.mockResolvedValue({
        address: 'addr_test1...',
        amount: [{ unit: 'other-token', quantity: '100' }],
        stake_address: null,
        type: 'byron',
      });
      mockBlockfrostMethods.addressesTransactions.mockResolvedValue([]);

      const result = await blockfrost.getAddressInfo('addr_test1...');

      expect(result!.balance).toBe(0);
    });

    it('should throw error on API failure', async () => {
      mockBlockfrostMethods.addresses.mockRejectedValue(
        new Error('Address not found')
      );

      await expect(
        blockfrost.getAddressInfo('addr_test1...')
      ).rejects.toThrow();
    });
  });

  describe('getTransaction', () => {
    beforeEach(() => {
      blockfrost.initializeClient({
        blockfrostApiKey: 'test-key',
        network: 'preview',
      });
    });

    it('should fetch transaction info successfully', async () => {
      mockBlockfrostMethods.txs.mockResolvedValue({
        hash: 'tx-hash-123',
        block: 'block-hash',
        block_height: 1000,
        block_time: 1640000000,
        fees: '170000',
        output_amount: [{ unit: 'lovelace', quantity: '5000000' }],
      });
      mockBlockfrostMethods.blocksLatest.mockResolvedValue({ height: 1100 });

      const result = await blockfrost.getTransaction('tx-hash-123');

      expect(result).toEqual({
        txHash: 'tx-hash-123',
        blockHash: 'block-hash',
        blockHeight: 1000,
        amount: 5,
        fee: 0.17,
        confirmations: 100,
        lastSeen: 1640000000,
        utxosCreated: [],
        utxosSpent: [],
      });
    });

    it('should return null for transaction not found', async () => {
      mockBlockfrostMethods.txs.mockRejectedValue(new Error('Not found'));

      const result = await blockfrost.getTransaction('non-existent-tx');

      expect(result).toBeNull();
      expect(mockLogger.debug).toHaveBeenCalled();
    });

    it('should handle missing lovelace in output amount', async () => {
      mockBlockfrostMethods.txs.mockResolvedValue({
        hash: 'tx-hash',
        block: 'block-hash',
        block_height: 1000,
        block_time: 1640000000,
        fees: '170000',
        output_amount: [{ unit: 'other-asset', quantity: '100' }],
      });
      mockBlockfrostMethods.blocksLatest.mockResolvedValue({ height: 1100 });

      const result = await blockfrost.getTransaction('tx-hash');

      expect(result!.amount).toBe(0);
    });
  });

  describe('isAvailable', () => {
    it('should return true when client is initialized', () => {
      blockfrost.initializeClient({
        blockfrostApiKey: 'test-key',
        network: 'preview',
      });

      expect(blockfrost.isAvailable()).toBe(true);
    });
  });

  describe('extractUtxoDeltas', () => {
    const watched = 'addr_watched';
    const other = 'addr_other';

    it('captures outputs at the watched address with assets and inline datum', () => {
      const txUtxos = {
        hash: 'tx1',
        inputs: [],
        outputs: [
          {
            output_index: 0,
            address: watched,
            amount: [
              { unit: 'lovelace', quantity: '2000000' },
              { unit: 'policy123assetname', quantity: '7' },
            ],
            inline_datum: 'd87980',
            reference_script_hash: null,
          },
          {
            output_index: 1,
            address: other,
            amount: [{ unit: 'lovelace', quantity: '1000000' }],
          },
        ],
      };

      const { utxosCreated, utxosSpent } = blockfrost.extractUtxoDeltas(txUtxos, 'tx1', new Set([watched]));

      expect(utxosCreated).toEqual([{
        txHash: 'tx1',
        outputIndex: 0,
        lovelace: '2000000',
        assets: [{ unit: 'policy123assetname', quantity: '7' }],
        inlineDatumHex: 'd87980',
      }]);
      expect(utxosSpent).toEqual([]);
    });

    it('captures inputs at the watched address as spent refs', () => {
      const txUtxos = {
        hash: 'tx2',
        inputs: [
          {
            address: watched,
            tx_hash: 'prevtx',
            output_index: 3,
            amount: [{ unit: 'lovelace', quantity: '5000000' }],
          },
          {
            address: other,
            tx_hash: 'othertx',
            output_index: 0,
            amount: [{ unit: 'lovelace', quantity: '1000000' }],
          },
        ],
        outputs: [],
      };

      const { utxosCreated, utxosSpent } = blockfrost.extractUtxoDeltas(txUtxos, 'tx2', new Set([watched]));

      expect(utxosCreated).toEqual([]);
      expect(utxosSpent).toEqual([{ txHash: 'prevtx', outputIndex: 3 }]);
    });

    it('skips collateral and reference inputs even when address matches', () => {
      const txUtxos = {
        hash: 'tx3',
        inputs: [
          {
            address: watched,
            tx_hash: 'collat',
            output_index: 0,
            amount: [],
            collateral: true,
          },
          {
            address: watched,
            tx_hash: 'refscript',
            output_index: 0,
            amount: [],
            reference: true,
          },
        ],
        outputs: [
          {
            output_index: 0,
            address: watched,
            amount: [{ unit: 'lovelace', quantity: '0' }],
            collateral: true,
          },
        ],
      };

      const { utxosCreated, utxosSpent } = blockfrost.extractUtxoDeltas(txUtxos, 'tx3', new Set([watched]));

      expect(utxosCreated).toEqual([]);
      expect(utxosSpent).toEqual([]);
    });

    it('captures referenceScriptHash when present', () => {
      const txUtxos = {
        hash: 'tx4',
        inputs: [],
        outputs: [{
          output_index: 0,
          address: watched,
          amount: [{ unit: 'lovelace', quantity: '4000000' }],
          reference_script_hash: 'abcdef',
        }],
      };

      const { utxosCreated } = blockfrost.extractUtxoDeltas(txUtxos, 'tx4', new Set([watched]));

      expect(utxosCreated[0].referenceScriptHash).toBe('abcdef');
      expect(utxosCreated[0].inlineDatumHex).toBeUndefined();
    });
  });

  describe('fetchPolicyAssetEvents', () => {
    const policyId = '8d18d786e92776c824607fd8e193ec535c79dc61ea2405ddf3b09fe3';
    const assetNameHex = '444a4544';
    const fullAssetId = policyId + assetNameHex;

    beforeEach(() => {
      blockfrost.initializeClient({
        blockfrostApiKey: 'test-key',
        network: 'mainnet',
      });
    });

    it('returns null when the policy exceeds the asset cap and emits a warning', async () => {
      // 5 assets with a cap of 4 — should bail.
      mockBlockfrostMethods.assetsPolicyByIdAll.mockResolvedValue(
        Array.from({ length: 5 }, (_, i) => ({ asset: policyId + i.toString(16).padStart(2, '0'), quantity: '1' }))
      );

      const out = await blockfrost.fetchPolicyAssetEvents(policyId, null, 4);

      expect(out).toBeNull();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('5 assets (cap: 4)')
      );
      // History was never fetched — we bailed early.
      expect(mockBlockfrostMethods.assetsHistoryAll).not.toHaveBeenCalled();
    });

    it('returns an empty list when the policy has no assets', async () => {
      mockBlockfrostMethods.assetsPolicyByIdAll.mockResolvedValue([]);

      const out = await blockfrost.fetchPolicyAssetEvents(policyId, null, 100);

      expect(out).toEqual([]);
    });

    it('projects mint and burn rows into PolicyAssetEvent shape', async () => {
      mockBlockfrostMethods.assetsPolicyByIdAll.mockResolvedValue([
        { asset: fullAssetId, quantity: '1000000' },
      ]);
      mockBlockfrostMethods.assetsHistoryAll.mockResolvedValue([
        { tx_hash: 'mint_tx', action: 'minted', amount: '1000000' },
        { tx_hash: 'burn_tx', action: 'burned', amount: '500000' },
      ]);
      mockBlockfrostMethods.txs
        .mockResolvedValueOnce({ block_height: 105 })
        .mockResolvedValueOnce({ block_height: 110 });

      const out = await blockfrost.fetchPolicyAssetEvents(policyId, null, 100);

      expect(out).toEqual([
        { policyId, assetNameHex, quantity: '1000000', action: 'minted', txHash: 'mint_tx', blockHeight: 105 },
        { policyId, assetNameHex, quantity: '500000',  action: 'burned', txHash: 'burn_tx', blockHeight: 110 },
      ]);
    });

    it('drops events at or below the cursor block', async () => {
      mockBlockfrostMethods.assetsPolicyByIdAll.mockResolvedValue([
        { asset: fullAssetId, quantity: '1' },
      ]);
      mockBlockfrostMethods.assetsHistoryAll.mockResolvedValue([
        { tx_hash: 'old_tx', action: 'minted', amount: '1' },
        { tx_hash: 'new_tx', action: 'minted', amount: '2' },
      ]);
      mockBlockfrostMethods.txs
        .mockResolvedValueOnce({ block_height: 100 })
        .mockResolvedValueOnce({ block_height: 110 });

      const out = await blockfrost.fetchPolicyAssetEvents(policyId, 100, 100);

      expect(out).toHaveLength(1);
      expect(out![0].txHash).toBe('new_tx');
    });

    it('caches per-tx block lookups across assets', async () => {
      // Same tx hash appears in two assets — should hit txs() once, not twice.
      const otherAsset = policyId + '5348454e';
      mockBlockfrostMethods.assetsPolicyByIdAll.mockResolvedValue([
        { asset: fullAssetId, quantity: '1' },
        { asset: otherAsset,  quantity: '1' },
      ]);
      mockBlockfrostMethods.assetsHistoryAll
        .mockResolvedValueOnce([{ tx_hash: 'shared_tx', action: 'minted', amount: '1' }])
        .mockResolvedValueOnce([{ tx_hash: 'shared_tx', action: 'minted', amount: '2' }]);
      mockBlockfrostMethods.txs.mockResolvedValue({ block_height: 200 });

      const out = await blockfrost.fetchPolicyAssetEvents(policyId, null, 100);

      expect(mockBlockfrostMethods.txs).toHaveBeenCalledTimes(1);
      expect(out).toHaveLength(2);
    });

  });

  describe('parseAssetFilter', () => {
    it('returns null for null/empty/invalid input', () => {
      expect(blockfrost.parseAssetFilter(null)).toBeNull();
      expect(blockfrost.parseAssetFilter(undefined)).toBeNull();
      expect(blockfrost.parseAssetFilter('')).toBeNull();
      expect(blockfrost.parseAssetFilter('not json')).toBeNull();
      expect(blockfrost.parseAssetFilter('{}')).toBeNull();
      expect(blockfrost.parseAssetFilter('[]')).toBeNull();
    });

    it('parses a valid asset-filter JSON array', () => {
      const json = '[{"policyId":"abc","assetNameHex":"01"},{"policyId":"def","assetNameHex":""}]';
      expect(blockfrost.parseAssetFilter(json)).toEqual([
        { policyId: 'abc', assetNameHex: '01' },
        { policyId: 'def', assetNameHex: '' },
      ]);
    });
  });

  describe('matchesAssetFilter', () => {
    const make = (assets: Array<{ unit: string; quantity: string }>) => ({
      txHash: 't', outputIndex: 0, lovelace: '1', assets,
    });

    it('returns true for null filter (no filter applied)', () => {
      expect(blockfrost.matchesAssetFilter([], null)).toBe(true);
      expect(blockfrost.matchesAssetFilter([make([])], null)).toBe(true);
    });

    it('returns false for empty utxosCreated when filter is non-null', () => {
      expect(blockfrost.matchesAssetFilter([], [{ policyId: 'abc', assetNameHex: '01' }])).toBe(false);
    });

    it('returns true when at least one utxo holds a listed asset', () => {
      const utxos = [
        make([{ unit: 'unrelated_asset', quantity: '1' }]),
        make([{ unit: 'abc01', quantity: '5' }, { unit: 'other', quantity: '1' }]),
      ];
      expect(
        blockfrost.matchesAssetFilter(utxos, [{ policyId: 'abc', assetNameHex: '01' }])
      ).toBe(true);
    });

    it('returns false when no utxo holds any listed asset', () => {
      const utxos = [
        make([{ unit: 'xyz99', quantity: '1' }]),
        make([{ unit: 'aaa00', quantity: '1' }]),
      ];
      expect(
        blockfrost.matchesAssetFilter(utxos, [{ policyId: 'abc', assetNameHex: '01' }])
      ).toBe(false);
    });

    it('matches an empty asset name (single-asset policy like a stablecoin)', () => {
      const utxos = [make([{ unit: 'abc', quantity: '1' }])];
      expect(
        blockfrost.matchesAssetFilter(utxos, [{ policyId: 'abc', assetNameHex: '' }])
      ).toBe(true);
    });
  });
});
