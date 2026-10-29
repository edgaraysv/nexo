import type { Pool, PoolClient, QueryResultRow } from 'pg';

export interface TenantContext { tenantId: string; userId: string }

export async function withTenantTransaction<T>(pool: Pool, context: TenantContext, work: (client: PoolClient) => Promise<T>): Promise<T> {
  if (!/^[0-9a-f-]{36}$/iu.test(context.tenantId) || !/^[0-9a-f-]{36}$/iu.test(context.userId)) throw new Error('invalid_context');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true), set_config($3, $4, true)', ['app.tenant_id', context.tenantId, 'app.user_id', context.userId]);
    const result = await work(client); await client.query('COMMIT'); return result;
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); }
}

export async function tenantQuery<T extends QueryResultRow>(client: PoolClient, text: string, values: unknown[] = []): Promise<T[]> {
  if (/\b(set_config|current_user|pg_read_file|copy)\b/iu.test(text)) throw new Error('unsafe_tenant_query');
  return (await client.query<T>(text, values)).rows;
}
