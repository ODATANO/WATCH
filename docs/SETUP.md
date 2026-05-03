# Setup Guide

Installation, configuration, and deployment for the Cardano Watcher Plugin.

## Installation

### For Plugin Users

```bash
npm add @odatano/watch
```

### For Plugin Developers

```bash
git clone https://github.com/odatano/cardano-watcher.git
npm install
npm run build
```

## Configuration

### Basic Configuration

```json
{
  "cds": {
    "requires": {
      "watch": {
        "network": "preprod",
        "blockfrostApiKey": "preprod_YOUR_KEY",
        "autoStart": true
      }
    }
  }
}
```

### Full Configuration Options

```typescript
interface CardanoWatcherConfig {
  network: "mainnet" | "preprod" | "preview";
  blockfrostApiKey?: string;
  /** Required only when credentialPolling.enabled. Free tier OK. */
  koiosApiKey?: string;
  autoStart?: boolean;       // default: true

  addressPolling?:    { enabled: boolean; interval: number }; // default on  / 30 s
  transactionPolling?:{ enabled: boolean; interval: number }; // default on  / 60 s
  credentialPolling?: { enabled: boolean; interval: number }; // default off / 60 s
  policyPolling?:     { enabled: boolean; interval: number }; // default off / 60 s

  /** Cap on distinct assets a watched policy may have. Default 100. */
  policyAssetCap?: number;

  maxRetries?: number;       // default: 3
  retryDelay?: number;       // ms, default: 5000
}
```

### Environment Variables

For **plugin development only**, you can use environment variables as fallback:

```bash
BLOCKFROST_KEY=mainnet_abc123
KOIOS_KEY=optional_koios_token
```

For **production**, configure via `cds.env.requires.watch.blockfrostApiKey` (and `koiosApiKey` when needed).

## Database Setup

Entities are deployed automatically with `cds deploy`.

**Manual inspection**:
```bash
cds deploy --dry-run > migration.sql
```

**Created entities**: `WatchedAddress`, `WatchedCredential`, `WatchedPolicy`, `TransactionSubmission`, `BlockchainEvent`, `WatcherConfig`.

## Security

### API Key Management

**❌ Never hardcode in package.json**:
```json
"watch": {
  "blockfrostApiKey": "mainnet_hardcoded_key"
}
```

**✅ Use environment-based config**:
```json
"watch": {
  "blockfrostApiKey": "${BLOCKFROST_KEY}"
}
```

**✅ Kubernetes Secrets**:
```yaml
env:
  - name: BLOCKFROST_KEY
    valueFrom:
      secretKeyRef:
        name: cardano-secrets
        key: blockfrostKey
```

### Authorization

Restrict admin service:

```cds
using { CardanoWatcherAdminService } from '@odatano/watch';
extend service CardanoWatcherAdminService with @(requires: 'admin');
```

## Deployment

### Docker

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .
EXPOSE 4004
CMD ["npx", "cds", "serve"]
```

```bash
docker run -p 4004:4004 \
  -e BLOCKFROST_KEY=mainnet_abc123 \
  my-cap-app
```

**Note**: The environment variable is used via config: `"blockfrostApiKey": "${BLOCKFROST_KEY}"`

### Cloud Foundry

```yaml
applications:
  - name: cardano-watcher-app
    memory: 512M
    buildpack: nodejs_buildpack
```

Bind secret service:
```bash
cf create-user-provided-service cardano-secrets -p '{"BLOCKFROST_KEY":"mainnet_abc123"}'
cf bind-service my-app cardano-secrets
```

**Note**: Use `"blockfrostApiKey": "${BLOCKFROST_KEY}"` in your config
cf bind-service my-app cardano-config
```

## Backend Notes

### Blockfrost
Always required. Used for: address-tx history, per-tx UTxO projections, transaction-submission lookup, policy mint/burn enumeration. Free tier: 50,000 req/day, 10 req/s — generally enough for a handful of watches; tighten polling intervals if you hit limits.

### Koios (optional)
Required only for credential watching. Used for credential→addresses resolution and credential-tx listing. Free tier with a 100 req/10 s rate limit and pagination cap of 1000 rows — the plugin paginates via `Range` headers up to a 100k-row safety cap per poll.

## Performance Tuning

| Watch count | Address Interval | Credential Interval | Policy Interval |
|---|---|---|---|
| < 10       | 30 s | 60 s | 60 s |
| 10 – 100   | 60 s | 90 s | 120 s |
| > 100      | 120 s | 180 s | 180 s |

For credentials with > 1000 txs per poll window or policies with > 100 mint/burn events per poll, prefer **shorter** intervals — the per-poll work scales with the number of new rows, not the cursor age.

## Troubleshooting

### Plugin Not Loading

```bash
# Check installation
npm ls @odatano/watch

# Verify config
cds env get requires.cardano-watcher

# View logs
cds watch
```

### CDS Models Not Discovered (fixed in v0.1.3)

If `CardanoWatcherAdminService` does not appear after `cds serve`, the plugin's CDS models are not being loaded. This was fixed in v0.1.3. If you are on an older version, add `model` explicitly in consumer `package.json`:

```json
{
  "cds": {
    "requires": {
      "cardano-watcher": {
        "model": ["@odatano/watch/db/schema", "@odatano/watch/srv/admin-service"],
        "network": "preview",
        "blockfrostApiKey": "preview_YOUR_KEY"
      }
    }
  }
}
```

### Events Not Firing

```typescript
// Check status — confirms which polling paths are active and how many watches each has
const status = await cardanoWatcher.getStatus();
console.log(status);

// Enable debug logs
cds.env.log.levels = { "ODATANO-WATCH": "debug" };
```

If the bus isn't receiving events but you expect them to be present on chain, replay the persisted record directly:

```http
POST /odata/v4/cardano-watcher-admin/getEventsSince
Content-Type: application/json

{ "scope": "address", "key": "addr_test1...", "fromBlock": null, "limit": 100 }
```

If `getEventsSince` returns rows but your bus handler never fired, the watcher is working — the listener registration in your service is the issue.

### API Rate Limits

- Increase polling intervals
- Reduce watched items
- Tighten the `includesAssetsJson` allowlist on noisy credentials
- Upgrade Blockfrost / Koios plan

## CI/CD

### GitHub Actions

```yaml
name: Test
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '18'
      - run: npm ci
      - run: npm run build
      - run: npm test
        env:
          BLOCKFROST_KEY: ${{ secrets.BLOCKFROST_KEY }}
```

## Resources

- **Issues**: [GitHub Issues](https://github.com/ODATANO/ODATANO-WATCH/issues)
- **CAP Documentation**: [cap.cloud.sap](https://cap.cloud.sap)
- **Blockfrost API**: [docs.blockfrost.io](https://docs.blockfrost.io)
- **Koios API**: [api.koios.rest](https://api.koios.rest)
