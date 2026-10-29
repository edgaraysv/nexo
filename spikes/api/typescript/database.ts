import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { Pool } from 'pg';

export const LAB_DATABASE = Symbol('F01_LAB_DATABASE');

export interface LabRequest {
  method: string;
  path: string;
  authorization: string;
  idempotencyKey: string;
  body: unknown;
}

export interface LabResult {
  http_status: number;
  payload: Record<string, unknown>;
}

export interface LabDatabase extends OnApplicationShutdown {
  execute(request: LabRequest): Promise<LabResult>;
}

@Injectable()
export class PostgresLabDatabase implements LabDatabase {
  private readonly pool: Pool;

  constructor() {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL is required for the F01 laboratory');
    this.pool = new Pool({ connectionString, max: 24 });
  }

  async execute(request: LabRequest): Promise<LabResult> {
    // Mismas funciones SQL, fixtures y transacción que PHP/Go. No es dominio productivo.
    const result = await this.pool.query<LabResult>('SELECT * FROM api_call($1,$2,$3,$4,$5::jsonb)', [
      request.method, request.path, request.authorization, request.idempotencyKey,
      JSON.stringify(request.body),
    ]);
    const row = result.rows[0];
    if (!row) throw new Error('F01 database returned no result');
    return row;
  }

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
