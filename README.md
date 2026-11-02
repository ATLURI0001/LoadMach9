# LoadMach9

Push Node.js to its limits.

Compare Express, Fastify, and Cpeak under load. Explore PostgreSQL query optimization, Redis-backed reads and writes, and multicore scaling with PM2.

## What It Covers

- **Framework comparison** — equivalent API workloads across three Node.js frameworks.
- **Database performance** — compare random-row queries with indexed lookups.
- **Redis acceleration** — benchmark in-memory reads and writes.
- **Multicore execution** — distribute requests across Node.js worker processes.
- **Load testing** — measure throughput, latency, and errors using Autocannon.

## Performance Metrics

| Metric | What to observe |
| --- | --- |
| Requests per second | How many requests the server completes each second |
| Latency | Average response time and reported latency percentiles |
| Errors and timeouts | Requests that fail or exceed the timeout |
| Response status codes | Whether responses are successful or return HTTP errors |
| Transfer rate | Response data transferred per second |

Results depend on hardware, endpoint complexity, dataset size, connection count, and configuration. No fixed throughput is guaranteed.

## Requirements

- Node.js and npm
- PostgreSQL
- Redis
- PM2 for optional process clustering
- Autocannon for load testing

Start PostgreSQL and Redis before running database-backed examples.

## Setup

### 1. Clone the Repository

```bash
git clone https://github.com/ATLURI0001/LoadMach9.git
cd LoadMach9
npm install
```

### 2. Configure PostgreSQL

Create `database/keys.js`:

```javascript
const keys = {
  dbUser: "<your-postgres-username>",
  dbHost: "localhost",
  dbDatabase: "benchmark",
  dbPassword: "<your-postgres-password>",
  dbPort: 5432,
};

export default keys;
```

Use your local PostgreSQL credentials. Keep this file out of version control.

### 3. Seed the Database

```bash
npm run seed
```

To specify a larger dataset:

```bash
npm run seed -- -r 20000000
```

This requests insertion of 20 million records into the `codes` table. Allow enough storage and time for the operation.

### 4. Start a Server

Choose one framework:

```bash
node cpeak.js
```

```bash
node express.js
```

```bash
node fastify.js
```

Use the address printed by the selected server. Cpeak uses port `3000`; Express uses port `3001`.

## Benchmarking

Install Autocannon:

```bash
npm install -g autocannon
```

With Cpeak running, benchmark the simple response endpoint:

```bash
autocannon -m GET --connections 20 --duration 20 --pipelining 2 --workers 6 http://localhost:3000/simple
```

Benchmark Redis-backed reads after populating Redis:

```bash
autocannon -m GET --connections 20 --duration 20 --pipelining 2 --workers 6 http://localhost:3000/code-fast
```

Adjust the port for the framework being tested. More example commands are available in `autocannon.txt`.

For useful comparisons, keep hardware, dataset, endpoint, and load settings consistent. Inspect response status codes alongside throughput: fast error responses are not successful operations.

## API Workloads

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | `/simple` | Minimal JSON response |
| PATCH | `/update-something/:id/:name` | Input processing and a larger JSON response |
| POST | `/code` | Insert a generated code into PostgreSQL |
| GET | `/code-v1` | Random-row selection using `ORDER BY RANDOM()` |
| GET | `/code-v2` | Count records, then query a random ID |
| GET | `/code-v3` | Find the maximum ID, then query a random ID |
| GET | `/code-v4` | Query a random ID within a fixed range |
| POST | `/code-fast` | Create a code in Redis and queue its ID for later synchronization |
| GET | `/code-fast` | Retrieve a random code from Redis |

Random-ID lookups can return “record not found” when the selected ID does not exist. The `/code-v4` implementation uses a fixed range of 1–700,000.

## Environment Variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `REDIS_CLUSTER` | `false` | Connect to Redis in cluster mode |
| `PG_CONNECT` | `true` | Enable the PostgreSQL connection |

Disabling PostgreSQL does not make PostgreSQL-backed endpoints usable.

### Bash / WSL

```bash
PG_CONNECT=false REDIS_CLUSTER=true node express.js
```

### Windows PowerShell

```powershell
$env:PG_CONNECT = "false"
$env:REDIS_CLUSTER = "true"
node express.js
```

To clear these overrides afterward:

```powershell
Remove-Item Env:PG_CONNECT
Remove-Item Env:REDIS_CLUSTER
```

## Redis Cluster

The `redis.sh` script provides Redis cluster setup.

Review the script before running it in a compatible Bash environment, such as Linux or WSL. Set `REDIS_CLUSTER=true` when connecting the application to the cluster.

## Multicore Scaling

Install PM2:

```bash
npm install -g pm2
```

Start the default Cpeak configuration:

```bash
pm2 start ecosystem.config.cjs
```

The configuration uses cluster mode with `instances: "max"`.

To select Express:

### Bash / WSL

```bash
F=express pm2 start ecosystem.config.cjs
```

### Windows PowerShell

```powershell
$env:F = "express"
pm2 start ecosystem.config.cjs
```

Use `fastify` instead of `express` to select Fastify.

Configure `REDIS_CLUSTER` and `PG_CONNECT` in `ecosystem.config.cjs` for PM2 runs.

View process status and logs:

```bash
pm2 status
pm2 logs
```

## PostgreSQL-to-Redis Migration

Copy the PostgreSQL dataset into Redis:

```bash
npm run migrate
```

The migration command does not support Redis cluster mode.
