export interface SupportTransportOpenInput {
  sessionId: string;
  tenantId: string;
  deviceId: string;
  operatorId: string;
  capabilities: string[];
  expiresAt: string;
  idempotencyKey: string;
  signal: AbortSignal;
}

export interface SupportTransportTerminationInput {
  engineSessionId: string;
  idempotencyKey: string;
  signal: AbortSignal;
}

export type SupportTransportLookup =
  | { status: 'opened'; engineSessionId: string }
  // This must mean the provider has conclusively found no session and no
  // in-flight open for the key. If absence is not authoritative, return pending.
  | { status: 'not_found' }
  | { status: 'pending' };

export interface SupportTransport {
  readonly kind: string;
  open(input: SupportTransportOpenInput): Promise<{ engineSessionId: string }>;
  findByIdempotencyKey(input: { idempotencyKey: string; signal: AbortSignal }): Promise<SupportTransportLookup>;
  terminate(input: SupportTransportTerminationInput): Promise<void>;
  terminateByIdempotencyKey?(input: { idempotencyKey: string; signal: AbortSignal }): Promise<void>;
}

export class SupportTransportError extends Error {
  constructor(readonly code: string, readonly outcome: 'not_opened' | 'unknown') {
    super(code);
    this.name = 'SupportTransportError';
  }
}

export function withSupportTransportDeadline<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new SupportTransportError('transport_timeout', 'unknown'));
    }, timeoutMs);
    Promise.resolve().then(() => operation(controller.signal)).then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); },
    );
  });
}

export class SyntheticSupportTransport implements SupportTransport {
  readonly kind = 'synthetic_test';
  readonly sessions = new Map<string, string>();
  readonly pendingKeys = new Set<string>();
  readonly terminated = new Set<string>();
  openCalls = 0;
  terminateCalls = 0;

  constructor(private readonly failures: { openBeforeCreation?: number; openAfterCreation?: number; terminate?: number } = {}) {}

  async open(input: SupportTransportOpenInput): Promise<{ engineSessionId: string }> {
    input.signal.throwIfAborted();
    this.openCalls += 1;
    const existing = this.sessions.get(input.idempotencyKey);
    if (existing) return { engineSessionId: existing };
    this.pendingKeys.add(input.idempotencyKey);
    if ((this.failures.openBeforeCreation ?? 0) > 0) {
      this.failures.openBeforeCreation!--;
      this.pendingKeys.delete(input.idempotencyKey);
      throw new SupportTransportError('synthetic_open_unavailable', 'not_opened');
    }
    const engineSessionId = `synthetic-${crypto.randomUUID()}`;
    this.sessions.set(input.idempotencyKey, engineSessionId);
    this.pendingKeys.delete(input.idempotencyKey);
    if ((this.failures.openAfterCreation ?? 0) > 0) {
      this.failures.openAfterCreation!--;
      throw new SupportTransportError('synthetic_open_ack_lost', 'unknown');
    }
    return { engineSessionId };
  }

  async findByIdempotencyKey(input: { idempotencyKey: string; signal: AbortSignal }): Promise<SupportTransportLookup> {
    input.signal.throwIfAborted();
    const engineSessionId = this.sessions.get(input.idempotencyKey);
    if (engineSessionId) return { status: 'opened', engineSessionId };
    return this.pendingKeys.has(input.idempotencyKey) ? { status: 'pending' } : { status: 'not_found' };
  }

  async terminate(input: SupportTransportTerminationInput): Promise<void> {
    input.signal.throwIfAborted();
    this.terminateCalls += 1;
    if ((this.failures.terminate ?? 0) > 0) {
      this.failures.terminate!--;
      throw new SupportTransportError('synthetic_terminate_unavailable', 'unknown');
    }
    this.terminated.add(input.engineSessionId);
    for (const [key, value] of this.sessions) if (value === input.engineSessionId) this.sessions.delete(key);
  }

  async terminateByIdempotencyKey(input: { idempotencyKey: string; signal: AbortSignal }): Promise<void> {
    const result = await this.findByIdempotencyKey(input);
    if (result.status === 'opened') await this.terminate({ engineSessionId: result.engineSessionId, idempotencyKey: `terminate:${input.idempotencyKey}`, signal: input.signal });
    else if (result.status === 'pending') throw new SupportTransportError('termination_target_pending', 'unknown');
  }
}
