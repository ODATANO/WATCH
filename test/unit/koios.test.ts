import { jest } from '@jest/globals';

const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

jest.mock('@sap/cds', () => ({
  log: jest.fn(() => mockLogger),
}));

import * as koios from '../../src/koios';

const fetchMock = jest.fn<(input: any, init?: any) => Promise<Response>>();
(globalThis as unknown as { fetch: typeof fetchMock }).fetch = fetchMock;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('Koios client', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('initializeClient', () => {
    it('rejects an unknown network', () => {
      expect(() =>
        koios.initializeClient({ network: 'banana' as never })
      ).toThrow(/Invalid Koios network/);
    });

    it('marks the client available after a valid initialization', () => {
      koios.initializeClient({ network: 'preview' });
      expect(koios.isAvailable()).toBe(true);
    });
  });

  describe('getAddressesByCredential', () => {
    beforeEach(() => {
      koios.initializeClient({ network: 'mainnet', koiosApiKey: 'k_test' });
    });

    it('hits the mainnet base URL and forwards the bearer token', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse([
        { payment_address: 'addr1qx1', stake_address: 'stake1' },
        { payment_address: 'addr1qx2', stake_address: 'stake2' },
      ]));

      const out = await koios.getAddressesByCredential('a'.repeat(56));

      expect(out).toEqual(['addr1qx1', 'addr1qx2']);
      const [url, init] = fetchMock.mock.calls[0];
      expect(String(url)).toBe('https://api.koios.rest/api/v1/credential_address');
      expect((init as RequestInit).method).toBe('POST');
      const headers = (init as RequestInit).headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer k_test');
      expect(JSON.parse((init as RequestInit).body as string)).toEqual({
        _payment_credentials: ['a'.repeat(56)],
      });
    });

    it('omits the Authorization header when no API key is set', async () => {
      koios.initializeClient({ network: 'preprod' });
      fetchMock.mockResolvedValueOnce(jsonResponse([]));

      await koios.getAddressesByCredential('b'.repeat(56));

      const [url, init] = fetchMock.mock.calls[0];
      expect(String(url)).toBe('https://preprod.koios.rest/api/v1/credential_address');
      const headers = (init as RequestInit).headers as Record<string, string>;
      expect(headers['Authorization']).toBeUndefined();
    });

    it('deduplicates payment_address entries', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse([
        { payment_address: 'addr1qsame' },
        { payment_address: 'addr1qsame' },
        { payment_address: 'addr1qother' },
      ]));

      const out = await koios.getAddressesByCredential('c'.repeat(56));

      expect(out).toEqual(['addr1qsame', 'addr1qother']);
    });

    it('throws on a non-2xx response', async () => {
      fetchMock.mockResolvedValueOnce(new Response('rate limited', {
        status: 429,
        statusText: 'Too Many Requests',
      }));

      await expect(
        koios.getAddressesByCredential('d'.repeat(56))
      ).rejects.toThrow(/Koios .* failed: 429/);
    });
  });

  describe('getCredentialTxsSince', () => {
    beforeEach(() => {
      koios.initializeClient({ network: 'preview' });
    });

    it('passes _after_block_height when a cursor is set', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse([
        { tx_hash: 'tx1', block_height: 105, block_time: 1640000000 },
      ]));

      const out = await koios.getCredentialTxsSince('e'.repeat(56), 100);

      expect(out).toEqual([{ txHash: 'tx1', blockHeight: 105, blockTime: 1640000000 }]);
      const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
      expect(body).toEqual({
        _payment_credentials: ['e'.repeat(56)],
        _after_block_height: 100,
      });
    });

    it('omits _after_block_height for first-poll bootstraps', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse([]));

      await koios.getCredentialTxsSince('f'.repeat(56), null);

      const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
      expect(body).toEqual({ _payment_credentials: ['f'.repeat(56)] });
    });

    it('paginates via Range header and concatenates pages until short page', async () => {
      // Page 1: full (1000 rows). Page 2: short (3 rows) → stop.
      const page1 = Array.from({ length: 1000 }, (_, i) => ({
        tx_hash: `tx${i}`, block_height: 100 + i, block_time: 1,
      }));
      const page2 = [
        { tx_hash: 'tx1000', block_height: 1100, block_time: 2 },
        { tx_hash: 'tx1001', block_height: 1101, block_time: 3 },
        { tx_hash: 'tx1002', block_height: 1102, block_time: 4 },
      ];
      fetchMock
        .mockResolvedValueOnce(jsonResponse(page1))
        .mockResolvedValueOnce(jsonResponse(page2));

      const out = await koios.getCredentialTxsSince('a'.repeat(56), null);

      expect(out).toHaveLength(1003);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      // Range header advances on the second call
      const headers1 = fetchMock.mock.calls[0][1].headers as Record<string, string>;
      const headers2 = fetchMock.mock.calls[1][1].headers as Record<string, string>;
      expect(headers1['Range']).toBe('0-999');
      expect(headers2['Range']).toBe('1000-1999');
    });

    it('stops after the first page when results are under the page size', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse([
        { tx_hash: 'only', block_height: 50, block_time: 1 },
      ]));

      const out = await koios.getCredentialTxsSince('b'.repeat(56), null);

      expect(out).toHaveLength(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
});
