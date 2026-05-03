/**
 * Unit tests for plugin.ts (CAP plugin registration)
 */
import { jest } from '@jest/globals';

const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

// Track event handlers
const eventHandlers: Map<string, Array<(...args: unknown[]) => void>> = new Map();

const mockCds = {
  log: jest.fn(() => mockLogger),
  env: {
    requires: {},
  },
  on: jest.fn((event: string, handler: (...args: unknown[]) => void) => {
    if (!eventHandlers.has(event)) {
      eventHandlers.set(event, []);
    }
    eventHandlers.get(event)!.push(handler);
  }),
};

jest.mock('@sap/cds', () => ({
  default: mockCds,
  ...mockCds,
}));

// Mock the index module (watcher)
const mockWatcher = {
  initialize: jest.fn<any>(),
  stop: jest.fn<any>(),
};

// Match the dynamic-import target in plugin.ts (`./index.js`).
jest.mock('../../src/index.js', () => mockWatcher);

describe('Plugin Module', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    eventHandlers.clear();
    // Reset cds.env.requires
    mockCds.env.requires = {};
    mockWatcher.initialize.mockResolvedValue(undefined);
    mockWatcher.stop.mockResolvedValue(undefined);
  });

  describe('Plugin Registration', () => {
    it('should register cardano-watcher service kind', async () => {
      // Import the plugin module - this triggers registration
      jest.resetModules();
      await import('../../src/plugin');

      // Check that requires and kinds objects exist
      expect(mockCds.env.requires).toBeDefined();
      expect((mockCds.env.requires as any).kinds).toBeDefined();
      expect((mockCds.env.requires as any).kinds['cardano-watcher']).toEqual({
        impl: '@odatano/watch',
        model: ['@odatano/watch/db/schema', '@odatano/watch/srv/admin-service'],
      });
    });

    it('should log debug message on registration', async () => {
      jest.resetModules();
      await import('../../src/plugin');

      expect(mockLogger.debug).toHaveBeenCalledWith('Plugin registered');
    });

    it('should register served event handler', async () => {
      jest.resetModules();
      await import('../../src/plugin');

      expect(mockCds.on).toHaveBeenCalledWith('served', expect.any(Function));
    });

    it('should register shutdown event handler', async () => {
      jest.resetModules();
      await import('../../src/plugin');

      expect(mockCds.on).toHaveBeenCalledWith('shutdown', expect.any(Function));
    });
  });

  describe('served Event Handler', () => {
    it('should initialize watcher on served event', async () => {
      jest.resetModules();
      await import('../../src/plugin');

      // Get the served handler
      const servedHandlers = eventHandlers.get('served');
      expect(servedHandlers).toBeDefined();
      expect(servedHandlers!.length).toBeGreaterThan(0);

      // Execute the handler
      await servedHandlers![0]();

      expect(mockWatcher.initialize).toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith('Plugin initialized successfully');
    });

    it('should only initialize once (idempotent)', async () => {
      jest.resetModules();
      await import('../../src/plugin');

      const servedHandlers = eventHandlers.get('served');

      // Call served handler twice
      await servedHandlers![0]();
      await servedHandlers![0]();

      // Should only initialize once
      expect(mockWatcher.initialize).toHaveBeenCalledTimes(1);
    });

    it('should log error but not throw when initialization fails', async () => {
      mockWatcher.initialize.mockRejectedValueOnce(new Error('Init failed'));

      jest.resetModules();
      await import('../../src/plugin');

      const servedHandlers = eventHandlers.get('served');

      // Should not throw
      await expect(servedHandlers![0]()).resolves.not.toThrow();

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to initialize plugin:',
        expect.any(Error)
      );
    });
  });

  describe('shutdown Event Handler', () => {
    it('should stop watcher on shutdown event', async () => {
      jest.resetModules();
      await import('../../src/plugin');

      // First initialize
      const servedHandlers = eventHandlers.get('served');
      await servedHandlers![0]();

      // Then shutdown
      const shutdownHandlers = eventHandlers.get('shutdown');
      expect(shutdownHandlers).toBeDefined();
      await shutdownHandlers![0]();

      expect(mockWatcher.stop).toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith('stopped');
    });

    it('should not stop if not initialized', async () => {
      jest.resetModules();
      await import('../../src/plugin');

      // Shutdown without initializing
      const shutdownHandlers = eventHandlers.get('shutdown');
      await shutdownHandlers![0]();

      expect(mockWatcher.stop).not.toHaveBeenCalled();
    });

    it('should log error on shutdown failure', async () => {
      mockWatcher.stop.mockRejectedValueOnce(new Error('Stop failed'));

      jest.resetModules();
      await import('../../src/plugin');

      // Initialize first
      const servedHandlers = eventHandlers.get('served');
      await servedHandlers![0]();

      // Then shutdown
      const shutdownHandlers = eventHandlers.get('shutdown');
      await shutdownHandlers![0]();

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Error during shutdown:',
        expect.any(Error)
      );
    });
  });

  describe('cds.env.requires initialization', () => {
    it('should create requires object if missing', async () => {
      (mockCds.env as any).requires = undefined;

      jest.resetModules();
      await import('../../src/plugin');

      expect(mockCds.env.requires).toBeDefined();
    });

    it('should create kinds object if missing', async () => {
      mockCds.env.requires = {};

      jest.resetModules();
      await import('../../src/plugin');

      expect((mockCds.env.requires as any).kinds).toBeDefined();
    });
  });
});
