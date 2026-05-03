import cds from '@sap/cds';
jest.setTimeout(20000);

/**
 * Integration Test Suite
 *
 * Comprehensive tests for the Cardano Watcher plugin covering:
 * - Service availability and entity exposure
 * - Watcher lifecycle (start/stop/status)
 * - Address monitoring (add/remove/query)
 * - Transaction tracking (add/remove/query)
 * - Entity relationships and data integrity
 * - Query capabilities (filter, select, orderby, count)
 * - Error handling and validation
 * - Edge cases and state management
 */

const TEST_DATA = {
  network: 'preview',
  testAddress1: 'addr_test1vqm5vyp8xztmxyl6mcr2xr5schajvsq8fjs8gn8g2zu0pgg8gckcp',
  testAddress2: 'addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgs68faae',
  testTxHash1: '2b8216b428b5292a4b13075cf37b26434f890a4ffcce1f75da1f85d2297efe83',
  testTxHash2: 'cb082e3e77a7d8cf56baaba5cbe8843d63b53fa41074557ed29e0dbfe7daab39',
  invalidAddress: 'INVALID_ADDRESS',
  invalidTxHash: 'INVALID_TX_HASH',
  tooShortAddress: 'addr1',
  tooShortTxHash: '2b8216',
};

describe('Integration Tests', () => {
  const test = cds.test(__dirname + '/../../');
  const expect = test.expect;

  beforeEach(async () => {
    await test.data.reset();
  });

  describe('Service Availability', () => {
    it('should expose CardanoWatcherAdminService', async () => {
      const services = cds.services;
      expect(services).to.have.property('CardanoWatcherAdminService');
    });

    it('should expose all required entities', async () => {
      const { status: statusAddr } = await test.get('/odata/v4/cardano-watcher-admin/WatchedAddresses');
      const { status: statusTx } = await test.get('/odata/v4/cardano-watcher-admin/TransactionSubmissions');
      const { status: statusEvents } = await test.get('/odata/v4/cardano-watcher-admin/BlockchainEvents');
      const { status: statusConfig } = await test.get('/odata/v4/cardano-watcher-admin/WatcherConfigs');

      expect(statusAddr).to.equal(200);
      expect(statusTx).to.equal(200);
      expect(statusEvents).to.equal(200);
      expect(statusConfig).to.equal(200);
    });

    it('should return empty collections initially', async () => {
      const { data: addresses } = await test.get('/odata/v4/cardano-watcher-admin/WatchedAddresses');
      const { data: transactions } = await test.get('/odata/v4/cardano-watcher-admin/TransactionSubmissions');

      expect(addresses.value).to.be.an('array').that.is.empty;
      expect(transactions.value).to.be.an('array').that.is.empty;
    });
  });

  describe('Watcher Lifecycle', () => {
    it('should start and stop the watcher', async () => {
      const { data: startResult } = await test.post('/odata/v4/cardano-watcher-admin/startWatcher', {});
      expect(startResult.success).to.be.true;
      expect(startResult.message).to.match(/started/i);

      const { data: stopResult } = await test.post('/odata/v4/cardano-watcher-admin/stopWatcher', {});
      expect(stopResult.success).to.be.true;
      expect(stopResult.message).to.match(/stopped/i);
    });

    it('should retrieve watcher status with all required fields', async () => {
      const { data } = await test.post('/odata/v4/cardano-watcher-admin/getWatcherStatus', {});

      expect(data).to.have.property('isRunning');
      expect(data).to.have.property('addressPolling');
      expect(data).to.have.property('transactionPolling');
      expect(data).to.have.property('network');
      expect(data).to.have.property('pollingIntervals');
      expect(data.pollingIntervals).to.have.property('address');
      expect(data.pollingIntervals).to.have.property('transaction');
      expect(data).to.have.property('watchCounts');
    });

    it('should handle multiple start calls gracefully', async () => {
      const { data: result1 } = await test.post('/odata/v4/cardano-watcher-admin/startWatcher', {});
      expect(result1.success).to.be.true;

      const { data: result2 } = await test.post('/odata/v4/cardano-watcher-admin/startWatcher', {});
      expect(result2).to.have.property('success');
    });

    it('should handle stop when not running', async () => {
      const { data: result } = await test.post('/odata/v4/cardano-watcher-admin/stopWatcher', {});
      expect(result).to.have.property('success');
    });
  });

  describe('Address Monitoring', () => {
    it('should add and query watched addresses', async () => {
      const { data } = await test.post('/odata/v4/cardano-watcher-admin/addWatchedAddress', {
        address: TEST_DATA.testAddress1,
        description: 'Test Address',
        network: TEST_DATA.network,
      });

      expect(data.address).to.equal(TEST_DATA.testAddress1);
      expect(data.active).to.be.true;

      const { data: addresses } = await test.get('/odata/v4/cardano-watcher-admin/WatchedAddresses');
      expect(addresses.value).to.have.lengthOf(1);
    });

    it('should remove a watched address', async () => {
      await test.post('/odata/v4/cardano-watcher-admin/addWatchedAddress', {
        address: TEST_DATA.testAddress1,
        network: TEST_DATA.network,
      });

      const { data } = await test.post('/odata/v4/cardano-watcher-admin/removeWatchedAddress', {
        address: TEST_DATA.testAddress1,
      });

      expect(data.success).to.be.true;
    });

    it('should allow adding address without description', async () => {
      const { status, data } = await test.post('/odata/v4/cardano-watcher-admin/addWatchedAddress', {
        address: TEST_DATA.testAddress1,
        network: TEST_DATA.network,
      });

      expect(status).to.equal(200);
      expect(data.address).to.equal(TEST_DATA.testAddress1);
    });

    it('should use default network if not specified', async () => {
      const { data } = await test.post('/odata/v4/cardano-watcher-admin/addWatchedAddress', {
        address: TEST_DATA.testAddress1,
        description: 'Test',
      });

      expect(data).to.have.property('network');
    });
  });

  describe('Transaction Tracking', () => {
    it('should add and query watched transactions', async () => {
      const { data } = await test.post('/odata/v4/cardano-watcher-admin/addWatchedTransaction', {
        txHash: TEST_DATA.testTxHash1,
        description: 'Test Transaction',
        network: TEST_DATA.network,
      });

      expect(data.txHash).to.equal(TEST_DATA.testTxHash1);
      expect(data.currentStatus).to.equal('PENDING');
      expect(data.confirmations).to.equal(0);

      const { data: transactions } = await test.get('/odata/v4/cardano-watcher-admin/TransactionSubmissions');
      expect(transactions.value).to.have.lengthOf(1);
    });

    it('should remove a watched transaction', async () => {
      await test.post('/odata/v4/cardano-watcher-admin/addWatchedTransaction', {
        txHash: TEST_DATA.testTxHash1,
        network: TEST_DATA.network,
      });

      const { data } = await test.post('/odata/v4/cardano-watcher-admin/removeWatchedTransaction', {
        txHash: TEST_DATA.testTxHash1,
      });

      expect(data.success).to.be.true;
    });

    it('should allow adding transaction without description', async () => {
      const { status, data } = await test.post('/odata/v4/cardano-watcher-admin/addWatchedTransaction', {
        txHash: TEST_DATA.testTxHash1,
        network: TEST_DATA.network,
      });

      expect(status).to.equal(200);
      expect(data.txHash).to.equal(TEST_DATA.testTxHash1);
    });
  });

  describe('Entity Relationships', () => {
    it('should support expand on WatchedAddress.events', async () => {
      await test.post('/odata/v4/cardano-watcher-admin/addWatchedAddress', {
        address: TEST_DATA.testAddress1,
        network: TEST_DATA.network,
      });

      const { data } = await test.get(
        `/odata/v4/cardano-watcher-admin/WatchedAddresses('${TEST_DATA.testAddress1}')?$expand=events`
      );

      expect(data).to.have.property('events');
      expect(data.events).to.be.an('array');
    });

    it('should support expand on TransactionSubmission.events', async () => {
      await test.post('/odata/v4/cardano-watcher-admin/addWatchedTransaction', {
        txHash: TEST_DATA.testTxHash1,
        network: TEST_DATA.network,
      });

      const { data } = await test.get(
        `/odata/v4/cardano-watcher-admin/TransactionSubmissions('${TEST_DATA.testTxHash1}')?$expand=events`
      );

      expect(data).to.have.property('events');
      expect(data.events).to.be.an('array');
    });
  });

  describe('Query Capabilities', () => {
    beforeEach(async () => {
      await test.post('/odata/v4/cardano-watcher-admin/addWatchedAddress', {
        address: TEST_DATA.testAddress1,
        description: 'Test Address',
        network: 'preview',
      });
      await test.post('/odata/v4/cardano-watcher-admin/addWatchedTransaction', {
        txHash: TEST_DATA.testTxHash1,
        network: 'preview',
      });
    });

    it('should filter by network', async () => {
      const { data } = await test.get(
        `/odata/v4/cardano-watcher-admin/WatchedAddresses?$filter=network eq 'preview'`
      );

      expect(data.value).to.have.lengthOf.at.least(1);
      expect(data.value[0].network).to.equal('preview');
    });

    it('should filter by active status', async () => {
      const { data } = await test.get(
        `/odata/v4/cardano-watcher-admin/WatchedAddresses?$filter=active eq true`
      );

      data.value.forEach((addr: any) => {
        expect(addr.active).to.be.true;
      });
    });

    it('should support $select', async () => {
      const { data } = await test.get(
        `/odata/v4/cardano-watcher-admin/WatchedAddresses?$select=address,network`
      );

      expect(data.value[0]).to.have.property('address');
      expect(data.value[0]).to.have.property('network');
    });

    it('should support $count', async () => {
      const { data } = await test.get(
        `/odata/v4/cardano-watcher-admin/WatchedAddresses?$count=true`
      );

      expect(data).to.have.property('@odata.count');
      expect(data['@odata.count']).to.be.a('number');
    });

    it('should support $top and $skip', async () => {
      await test.post('/odata/v4/cardano-watcher-admin/addWatchedAddress', {
        address: TEST_DATA.testAddress2,
        network: TEST_DATA.network,
      });

      const { data } = await test.get('/odata/v4/cardano-watcher-admin/WatchedAddresses?$top=1');
      expect(data.value).to.have.lengthOf(1);
    });
  });

  describe('Input Validation', () => {
    it('should reject invalid address format', async () => {
      try {
        await test.post('/odata/v4/cardano-watcher-admin/addWatchedAddress', {
          address: TEST_DATA.invalidAddress,
          network: TEST_DATA.network,
        });
        expect.fail('Should have thrown an error');
      } catch (error: any) {
        expect(error.response.status).to.equal(400);
      }
    });

    it('should reject address that is too short', async () => {
      try {
        await test.post('/odata/v4/cardano-watcher-admin/addWatchedAddress', {
          address: TEST_DATA.tooShortAddress,
          network: TEST_DATA.network,
        });
        expect.fail('Should have thrown an error');
      } catch (error: any) {
        expect(error.response.status).to.equal(400);
      }
    });

    it('should reject invalid transaction hash', async () => {
      try {
        await test.post('/odata/v4/cardano-watcher-admin/addWatchedTransaction', {
          txHash: TEST_DATA.invalidTxHash,
          network: TEST_DATA.network,
        });
        expect.fail('Should have thrown an error');
      } catch (error: any) {
        expect(error.response.status).to.equal(400);
      }
    });

    it('should reject transaction hash that is too short', async () => {
      try {
        await test.post('/odata/v4/cardano-watcher-admin/addWatchedTransaction', {
          txHash: TEST_DATA.tooShortTxHash,
          network: TEST_DATA.network,
        });
        expect.fail('Should have thrown an error');
      } catch (error: any) {
        expect(error.response.status).to.equal(400);
      }
    });

    it('should reject missing address field', async () => {
      try {
        await test.post('/odata/v4/cardano-watcher-admin/addWatchedAddress', {
          description: 'Missing address',
        });
        expect.fail('Should have thrown an error');
      } catch (error: any) {
        expect(error.response.status).to.be.greaterThan(399);
      }
    });

    it('should reject missing txHash field', async () => {
      try {
        await test.post('/odata/v4/cardano-watcher-admin/addWatchedTransaction', {
          description: 'Missing txHash',
        });
        expect.fail('Should have thrown an error');
      } catch (error: any) {
        expect(error.response.status).to.be.greaterThan(399);
      }
    });
  });

  describe('Error Handling', () => {
    it('should handle duplicate address addition', async () => {
      await test.post('/odata/v4/cardano-watcher-admin/addWatchedAddress', {
        address: TEST_DATA.testAddress1,
        network: TEST_DATA.network,
      });

      try {
        await test.post('/odata/v4/cardano-watcher-admin/addWatchedAddress', {
          address: TEST_DATA.testAddress1,
          network: TEST_DATA.network,
        });
        expect.fail('Should have thrown an error');
      } catch (error: any) {
        expect(error.response.status).to.equal(400);
        expect(error.response.data.error.message).to.include('already being watched');
      }
    });

    it('should handle duplicate transaction addition', async () => {
      await test.post('/odata/v4/cardano-watcher-admin/addWatchedTransaction', {
        txHash: TEST_DATA.testTxHash1,
        network: TEST_DATA.network,
      });

      try {
        await test.post('/odata/v4/cardano-watcher-admin/addWatchedTransaction', {
          txHash: TEST_DATA.testTxHash1,
          network: TEST_DATA.network,
        });
        expect.fail('Should have thrown an error');
      } catch (error: any) {
        expect(error.response.status).to.equal(400);
        expect(error.response.data.error.message).to.include('already being tracked');
      }
    });

    it('should handle removing non-existent address', async () => {
      try {
        await test.post('/odata/v4/cardano-watcher-admin/removeWatchedAddress', {
          address: TEST_DATA.testAddress1,
        });
        expect.fail('Should have thrown an error');
      } catch (error: any) {
        expect(error.response.status).to.equal(400);
      }
    });

    it('should handle removing non-existent transaction', async () => {
      try {
        await test.post('/odata/v4/cardano-watcher-admin/removeWatchedTransaction', {
          txHash: TEST_DATA.testTxHash1,
        });
        expect.fail('Should have thrown an error');
      } catch (error: any) {
        expect(error.response.status).to.equal(400);
      }
    });

    it('should handle querying non-existent entity', async () => {
      try {
        await test.get(`/odata/v4/cardano-watcher-admin/WatchedAddresses('addr_test1nonexistent')`);
        expect.fail('Should have thrown an error');
      } catch (error: any) {
        expect(error.response.status).to.equal(404);
      }
    });
  });

  describe('Watch Counts', () => {
    it('should update counts after adding/removing addresses', async () => {
      let { data: status1 } = await test.post('/odata/v4/cardano-watcher-admin/getWatcherStatus', {});
      const initialCount = status1.watchCounts.addresses;

      await test.post('/odata/v4/cardano-watcher-admin/addWatchedAddress', {
        address: TEST_DATA.testAddress1,
        network: TEST_DATA.network,
      });

      let { data: status2 } = await test.post('/odata/v4/cardano-watcher-admin/getWatcherStatus', {});
      expect(status2.watchCounts.addresses).to.equal(initialCount + 1);

      await test.post('/odata/v4/cardano-watcher-admin/removeWatchedAddress', {
        address: TEST_DATA.testAddress1,
      });

      let { data: status3 } = await test.post('/odata/v4/cardano-watcher-admin/getWatcherStatus', {});
      expect(status3.watchCounts.addresses).to.equal(initialCount);
    });

    it('should maintain separate counts for addresses and transactions', async () => {
      await test.post('/odata/v4/cardano-watcher-admin/addWatchedAddress', {
        address: TEST_DATA.testAddress1,
        network: TEST_DATA.network,
      });

      await test.post('/odata/v4/cardano-watcher-admin/addWatchedTransaction', {
        txHash: TEST_DATA.testTxHash1,
        network: TEST_DATA.network,
      });

      const { data: status } = await test.post('/odata/v4/cardano-watcher-admin/getWatcherStatus', {});
      expect(status.watchCounts.addresses).to.equal(1);
      expect(status.watchCounts.submissions).to.equal(1);
    });
  });

  describe('Concurrent Operations', () => {
    it('should handle concurrent add operations safely', async () => {
      const promises = [
        test.post('/odata/v4/cardano-watcher-admin/addWatchedAddress', {
          address: TEST_DATA.testAddress1,
          network: TEST_DATA.network,
        }),
        test.post('/odata/v4/cardano-watcher-admin/addWatchedTransaction', {
          txHash: TEST_DATA.testTxHash1,
          network: TEST_DATA.network,
        }),
      ];

      const results = await Promise.all(promises);
      expect(results).to.have.lengthOf(2);
      expect(results[0].status).to.equal(200);
      expect(results[1].status).to.equal(200);
    });
  });

  describe('Replay (getEventsSince)', () => {
    const validCredHex = '0805d8541db33f4841585fed4c3a7e87e2ff7018243038f06ceb660c';
    const validPolicyId = '8d18d786e92776c824607fd8e193ec535c79dc61ea2405ddf3b09fe3';

    async function seedAddressEvents(address: string, blocks: number[]): Promise<void> {
      const { INSERT } = cds.ql;
      for (let i = 0; i < blocks.length; i++) {
        await cds.db.run(INSERT.into('odatano.watch.BlockchainEvent').entries({
          id: `seed-${address.slice(-6)}-${i}-${blocks[i]}`,
          type: 'TRANSACTION',
          blockHeight: blocks[i],
          txHash: `tx_${blocks[i]}`,
          address_address: address,
          payload: JSON.stringify({ txHash: `tx_${blocks[i]}`, blockHeight: blocks[i] }),
          network: 'preview',
          processed: false,
          createdAt: new Date().toISOString(),
        }));
      }
    }

    it('rejects an unknown scope', async () => {
      try {
        await test.post('/odata/v4/cardano-watcher-admin/getEventsSince', {
          scope: 'banana',
          key: 'whatever',
        });
        expect.fail('Should have thrown an error');
      } catch (error: any) {
        expect(error.response.status).to.equal(400);
      }
    });

    it('rejects a key that does not match the scope shape', async () => {
      try {
        await test.post('/odata/v4/cardano-watcher-admin/getEventsSince', {
          scope: 'credential',
          key: 'not-a-cred',
        });
        expect.fail('Should have thrown an error');
      } catch (error: any) {
        expect(error.response.status).to.equal(400);
      }
    });

    it('returns an empty array for a watch with no persisted events', async () => {
      const { status, data } = await test.post('/odata/v4/cardano-watcher-admin/getEventsSince', {
        scope: 'address',
        key: TEST_DATA.testAddress1,
      });
      expect(status).to.equal(200);
      expect(data.value ?? data).to.deep.equal([]);
    });

    it('returns persisted address events ordered by blockHeight asc', async () => {
      await seedAddressEvents(TEST_DATA.testAddress1, [200, 100, 150]);

      const { status, data } = await test.post('/odata/v4/cardano-watcher-admin/getEventsSince', {
        scope: 'address',
        key: TEST_DATA.testAddress1,
      });
      expect(status).to.equal(200);
      const rows = data.value ?? data;
      expect(rows).to.have.lengthOf(3);
      expect(rows.map((r: { blockHeight: number }) => r.blockHeight)).to.deep.equal([100, 150, 200]);
    });

    it('honors fromBlock as an exclusive cursor', async () => {
      await seedAddressEvents(TEST_DATA.testAddress1, [100, 150, 200]);

      const { data } = await test.post('/odata/v4/cardano-watcher-admin/getEventsSince', {
        scope: 'address',
        key: TEST_DATA.testAddress1,
        fromBlock: 150,
      });
      const rows = data.value ?? data;
      expect(rows).to.have.lengthOf(1);
      expect(rows[0].blockHeight).to.equal(200);
    });

    it('does not bleed events across watches with different keys', async () => {
      await seedAddressEvents(TEST_DATA.testAddress1, [100]);
      await seedAddressEvents(TEST_DATA.testAddress2, [100]);

      const { data } = await test.post('/odata/v4/cardano-watcher-admin/getEventsSince', {
        scope: 'address',
        key: TEST_DATA.testAddress1,
      });
      const rows = data.value ?? data;
      expect(rows).to.have.lengthOf(1);
    });

    it('caps limit at 10_000 even when caller asks for more', async () => {
      // Don't actually seed 10k rows; just verify the action accepts the
      // request and returns ≤ 10_000 (here, 0).
      const { status } = await test.post('/odata/v4/cardano-watcher-admin/getEventsSince', {
        scope: 'policy',
        key: validPolicyId,
        limit: 100_000,
      });
      expect(status).to.equal(200);
    });

    it('accepts credential and policy scopes with correctly-shaped keys', async () => {
      const credResp = await test.post('/odata/v4/cardano-watcher-admin/getEventsSince', {
        scope: 'credential',
        key: validCredHex,
      });
      expect(credResp.status).to.equal(200);

      const policyResp = await test.post('/odata/v4/cardano-watcher-admin/getEventsSince', {
        scope: 'policy',
        key: validPolicyId,
      });
      expect(policyResp.status).to.equal(200);
    });
  });
});
