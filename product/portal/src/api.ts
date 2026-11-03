import { useMemo } from 'react';
import { useAuth } from './auth/AuthContext';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
    this.name = 'ApiError';
  }
}

export async function apiFetch<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  if (token) headers.set('authorization', `Bearer ${token}`);

  const response = await fetch(path, { ...init, headers });
  let payload: unknown;
  if (response.status !== 204) {
    try {
      payload = await response.json();
    } catch {
      payload = undefined;
    }
  }

  if (!response.ok) {
    const errorCode =
      typeof payload === 'object' && payload !== null && 'error' in payload &&
      typeof payload.error === 'string'
        ? payload.error
        : 'request_failed';
    throw new ApiError(response.status, errorCode);
  }
  return payload as T;
}

export function useApi() {
  const { session } = useAuth();
  const token = session?.token ?? '';
  return useMemo(() => ({
    get<T>(path: string): Promise<T> {
      return apiFetch<T>(path, token);
    },
    post<T>(path: string, body: unknown): Promise<T> {
      return apiFetch<T>(path, token, { method: 'POST', body: JSON.stringify(body) });
    },
    put<T>(path: string, body: unknown): Promise<T> {
      return apiFetch<T>(path, token, { method: 'PUT', body: JSON.stringify(body) });
    },
    del<T>(path: string): Promise<T> {
      return apiFetch<T>(path, token, { method: 'DELETE' });
    },
  }), [token]);
}
