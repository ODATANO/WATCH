using { odatano.watch as db } from '../db/schema';

/**
 * Cardano Watcher Admin Service
 * Manages blockchain address monitoring and transaction tracking
 */
service CardanoWatcherAdminService @(impl: '@odatano/watch/srv/admin-service') {
  
  // ---------------------------------------------------------------------------
  // Entity Projections
  // ---------------------------------------------------------------------------

  @title      : 'Watched Addresses'
  @description: 'Projection for Watched Addresses'
  entity WatchedAddresses         as projection on db.WatchedAddress;

  @title      : 'Watched Credentials'
  @description: 'Projection for Watched Credentials'
  entity WatchedCredentials       as projection on db.WatchedCredential;

  @title      : 'Watched Policies'
  @description: 'Projection for Watched Policies'
  entity WatchedPolicies          as projection on db.WatchedPolicy;

  @title      : 'Transaction Submissions'
  @description: 'Projection for Transaction Submissions'
  entity TransactionSubmissions   as projection on db.TransactionSubmission;

  @title      : 'Blockchain Events'
  @description: 'Projection for Blockchain Events'
  entity BlockchainEvents         as projection on db.BlockchainEvent;

  @title      : 'Watcher Configurations'
  @description: 'Projection for Watcher Configurations'
  entity WatcherConfigs           as projection on db.WatcherConfig;

  @title      : 'Watcher Cursors'
  @description: 'Projection for Watcher Cursors (Ogmios chainSync state)'
  entity WatcherCursors           as projection on db.WatcherCursor;

  // ---------------------------------------------------------------------------
  // Replay
  // ---------------------------------------------------------------------------

  @title      : 'Get Events Since'
  @description: 'Replay persisted BlockchainEvent rows for a watch since the given block height. Returns rows ordered by blockHeight asc. Use the last returned blockHeight as the next call''s fromBlock for cursor pagination.'
  action getEventsSince(
                           @title: 'Scope'
                           @description: 'Watch scope: address | credential | policy'
                           scope: String,

                           @title: 'Key'
                           @description: 'The address (Bech32), credential (paymentCredHex), or policy ID for the chosen scope'
                           key: String,

                           @title: 'From Block (exclusive)'
                           @description: 'Return events with blockHeight > fromBlock. Null/omitted = from earliest persisted event.'
                           fromBlock: Integer64,

                           @title: 'Limit'
                           @description: 'Maximum rows to return. Default 1000. Hard cap 10000.'
                           limit: Integer)                       returns array of BlockchainEvents;

  // ---------------------------------------------------------------------------
  // Watcher Control Actions
  // ---------------------------------------------------------------------------

  @title      : 'Start Watcher'
  @description: 'Start all watcher polling paths'
  action startWatcher()                                            returns db.WatcherActionResult;

  @title      : 'Stop Watcher'
  @description: 'Stop all watcher polling paths'
  action stopWatcher()                                             returns db.WatcherActionResult;

  @title      : 'Get Watcher Status'
  @description: 'Retrieve current status and configuration of the watcher'
  action getWatcherStatus()                                        returns {
    isRunning          : Boolean;
    addressPolling     : Boolean;
    transactionPolling : Boolean;
    credentialPolling  : Boolean;
    policyPolling      : Boolean;
    network            : String;
    pollingIntervals   : {
      address     : Integer;
      transaction : Integer;
      credential  : Integer;
      policy      : Integer;
    };
    watchCounts        : {
      addresses       : Integer;
      credentials     : Integer;
      policies        : Integer;
      submissions     : Integer;
      newTransactions : Integer;
    };
  };

  // ---------------------------------------------------------------------------
  // Address Monitoring Actions
  // ---------------------------------------------------------------------------

  @title      : 'Add Watched Address'
  @description: 'Add a new address to monitor for blockchain activity'
  action addWatchedAddress(
                           @title: 'Address'
                           @description: 'The Bech32 encoded address to watch'
                           address: db.Bech32,

                           @title: 'Description'
                           @description: 'Optional description of the address'
                           description: String,

                           @title: 'Tag'
                           @description: 'Consumer-supplied label echoed back in emitted events for dispatch routing'
                           tag: String,

                           @title: 'Asset Filter (JSON)'
                           @description: 'Optional asset-allowlist as a JSON array [{policyId, assetNameHex}]. Only txs whose outputs at this address contain at least one listed asset will fire events.'
                           includesAssetsJson: LargeString,

                           @title: 'Coalesce Window (ms)'
                           @description: 'Optional. Bus events are batched and emitted at most once per coalesce window with cumulative deltas. Capped at 300000 (5 min).'
                           coalesceMs: Integer64,

                           @title: 'Network'
                           @description: 'The Cardano network (mainnet, preview, preprod)'
                           network: String)                      returns WatchedAddresses;

  @title      : 'Remove Watched Address'
  @description: 'Remove an address from monitoring'
  action removeWatchedAddress(
                           @title: 'Address'
                           @description: 'The Bech32 encoded address to stop watching'
                           address: db.Bech32)                   returns db.WatcherActionResult;

  // ---------------------------------------------------------------------------
  // Credential Monitoring Actions
  // ---------------------------------------------------------------------------

  @title      : 'Add Watched Credential'
  @description: 'Watch a payment credential across every bech32 address that shares it'
  action addWatchedCredential(
                           @title: 'Payment Credential Hex'
                           @description: '28-byte payment-key or script hash as 56-char hex'
                           paymentCredHex: db.PaymentCredHex,

                           @title: 'Description'
                           @description: 'Optional description of the credential'
                           description: String,

                           @title: 'Tag'
                           @description: 'Consumer-supplied label echoed back in emitted events for dispatch routing'
                           tag: String,

                           @title: 'Asset Filter (JSON)'
                           @description: 'Optional asset-allowlist as a JSON array [{policyId, assetNameHex}]. Only txs whose outputs at addresses sharing this credential contain at least one listed asset will fire events.'
                           includesAssetsJson: LargeString,

                           @title: 'Coalesce Window (ms)'
                           @description: 'Optional. Bus events are batched and emitted at most once per coalesce window with cumulative deltas. Capped at 300000 (5 min).'
                           coalesceMs: Integer64,

                           @title: 'Network'
                           @description: 'The Cardano network (mainnet, preview, preprod)'
                           network: String)                      returns WatchedCredentials;

  @title      : 'Remove Watched Credential'
  @description: 'Stop watching a payment credential'
  action removeWatchedCredential(
                           @title: 'Payment Credential Hex'
                           @description: 'The 56-char hex credential to stop watching'
                           paymentCredHex: db.PaymentCredHex)    returns db.WatcherActionResult;

  // ---------------------------------------------------------------------------
  // Policy Monitoring Actions
  // ---------------------------------------------------------------------------

  @title      : 'Add Watched Policy'
  @description: 'Watch a minting policy for asset mint and burn events'
  action addWatchedPolicy(
                           @title: 'Policy ID'
                           @description: '28-byte minting policy hash as 56-char hex'
                           policyId: db.PolicyId,

                           @title: 'Description'
                           @description: 'Optional description of the policy'
                           description: String,

                           @title: 'Tag'
                           @description: 'Consumer-supplied label echoed back in emitted events for dispatch routing'
                           tag: String,

                           @title: 'Network'
                           @description: 'The Cardano network (mainnet, preview, preprod)'
                           network: String)                      returns WatchedPolicies;

  @title      : 'Remove Watched Policy'
  @description: 'Stop watching a minting policy'
  action removeWatchedPolicy(
                           @title: 'Policy ID'
                           @description: 'The 56-char hex policy ID to stop watching'
                           policyId: db.PolicyId)                returns db.WatcherActionResult;

  // ---------------------------------------------------------------------------
  // Transaction Tracking Actions
  // ---------------------------------------------------------------------------

  @title      : 'Track Submitted Transaction'
  @description: 'Submit a transaction hash for status tracking'
  action addWatchedTransaction(
                                   @title: 'Transaction Hash'
                                   @description: 'The transaction hash to track'
                                   txHash: db.Blake2b256,

                                   @title: 'Description'
                                   @description: 'Optional description'
                                   description: String,

                                   @title: 'Network'
                                   @description: 'The Cardano network'
                                   network: String)             returns TransactionSubmissions;

                                   
  @title      : 'Remove Watched Transaction'
  @description: 'Stop tracking a transaction'
  action removeWatchedTransaction(
                                   @title: 'Transaction Hash'
                                   @description: 'The transaction hash to stop tracking'
                                   txHash: db.Blake2b256)        returns db.WatcherActionResult;
}
