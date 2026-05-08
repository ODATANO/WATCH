import cds from '@sap/cds';

const logger = cds.log('ODATANO-WATCH');

let initialized = false;

/**
 * CAP Plugin registration for @odatano/watch
 * This is executed when the plugin is loaded
 */

// Register watcher service kind
if (!cds.env.requires) {
  (cds.env as { requires?: Record<string, unknown> }).requires = {};
}

if (!cds.env.requires.kinds) {
  (cds.env.requires as { kinds?: Record<string, unknown> }).kinds = {};
}

// Register watch service kind
(cds.env.requires as { kinds?: Record<string, unknown> }).kinds!['watch'] = {
  impl: '@odatano/watch',
  model: ['@odatano/watch/db/schema', '@odatano/watch/srv/admin-service'],
};

// CRITICAL: Also set model directly on the requires entry.
// CAP's _link_required_services() runs during env construction, BEFORE cds-plugin.js is loaded,
// so the model array on the kind is never merged into cds.env.requires['watch'].
// We must set it directly on the requires entry for CAP's model resolution to find it.
const reqEntry = cds.env.requires['watch'] as Record<string, unknown> | undefined;
if (reqEntry) {
  reqEntry.model = ['@odatano/watch/db/schema', '@odatano/watch/srv/admin-service'];
}

logger.debug('Plugin registered');

/**
 * Initialize the watcher when services are served
 */
cds.on('served', async () => {
  if (initialized) return;
  
  logger.debug('Plugin activation triggered');
  
  try {
    // Import the watcher module
    const watcher = await import('./index.js');
    
    // Initialize the watcher with the application's database
    await watcher.initialize();
    
    logger.info('Plugin initialized successfully');
    initialized = true;
  } catch (err) {
    // Don't throw an error, just log it - plugin failure shouldn't crash the main app
    logger.error('Failed to initialize plugin:', err);
  }
});

/**
 * Graceful shutdown handler
 */
cds.on('shutdown', async () => {
  if (!initialized) return;
  
  try {
    logger.debug('Shutting down...');
    const watcher = await import('./index.js');
    await watcher.stop();
    logger.info('stopped');
  } catch (err) {
    logger.error('Error during shutdown:', err);
  }
});

export {};
