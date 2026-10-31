import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import type { NodeRepository } from './node-repository.js';
import type { OperationRepository } from './operation-repository.js';
import type { SupportRepository } from './support-repository.js';
import { PostgresNodeRepository } from './postgres-node-repository.js';
import { PostgresOperationRepository } from './postgres-operation-repository.js';
import { PostgresSupportRepository } from './postgres-support-repository.js';

export interface WorkerCycleResult {
  endpoint: { dispatched: number; expired: number; repaired: number };
  node: { dispatched: number; expired: number; repaired: number };
  support?: { terminationDispatched: number };
}

export async function runWorkerCycle(operations: OperationRepository, nodes: NodeRepository, workerId: string, batchSize: number, support?: SupportRepository): Promise<WorkerCycleResult> {
  const [endpointReconciliation, nodeReconciliation] = await Promise.all([operations.reconcile(batchSize), nodes.reconcile(batchSize)]);
  const [endpointDispatched, nodeDispatched] = await Promise.all([operations.dispatch(workerId, batchSize), nodes.dispatch(workerId, batchSize)]);
  const result: WorkerCycleResult = {
    endpoint: { dispatched: endpointDispatched, ...endpointReconciliation },
    node: { dispatched: nodeDispatched, ...nodeReconciliation }
  };
  if (support) result.support = { terminationDispatched: await support.dispatchTerminationOutbox(workerId, batchSize) };
  return result;
}

function integer(value: string | undefined, fallback: number, minimum: number, maximum: number, name: string): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`invalid_${name}`);
  return parsed;
}

export async function startOperationWorker(env: NodeJS.ProcessEnv): Promise<void> {
  const database = env.PGDATABASE ?? 'nexo';
  const user = env.PGUSER ?? 'nexo_runtime';
  const host = env.PGHOST ?? '/var/run/postgresql';
  if (!/^[a-z_][a-z0-9_]{0,62}$/u.test(database) || !/^[a-z_][a-z0-9_]{0,62}$/u.test(user) || user === 'postgres') throw new Error('invalid_postgres_identity');
  if (!host.startsWith('/') || host.includes('\0')) throw new Error('invalid_pg_host');
  const intervalMs = integer(env.NEXO_WORKER_INTERVAL_MS, 1_000, 100, 60_000, 'worker_interval');
  const batchSize = integer(env.NEXO_WORKER_BATCH, 50, 1, 500, 'worker_batch');
  const workerId = `${hostname().slice(0, 80)}:${process.pid}`;
  const pool = new Pool({ host, port: integer(env.PGPORT, 5432, 1, 65_535, 'pg_port'), database, user, max: 4, application_name: 'nexo-operation-worker', idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000 });
  const operations = new PostgresOperationRepository(pool);
  const nodes = new PostgresNodeRepository(pool);
  const support = new PostgresSupportRepository(pool);
  let stopping = false;
  let backoff = intervalMs;
  const stop = (): void => { stopping = true; };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    await pool.query('SELECT 1');
    while (!stopping) {
      try {
        await runWorkerCycle(operations, nodes, workerId, batchSize, support);
        backoff = intervalMs;
      } catch {
        process.stderr.write('nexo_operation_worker_cycle_failed\n');
        backoff = Math.min(Math.max(backoff * 2, intervalMs), 30_000);
      }
      if (!stopping) await new Promise(resolveDelay => setTimeout(resolveDelay, backoff));
    }
  } finally {
    await pool.end().catch(() => {});
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  startOperationWorker(process.env).catch(() => {
    process.stderr.write('nexo_operation_worker_start_failed\n');
    process.exitCode = 1;
  });
}
