import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

export interface Session {
  token: string;
  surface: 'provider' | 'company';
  tenantId?: string;
  tenantName?: string;
  email: string;
  role: string;
  permissions: string[];
}

export interface MfaResult {
  selection: string;
  provider?: { role: string; name?: string };
  memberships: Array<{ tenant_id: string; name: string }>;
}

interface LoginResponse {
  challenge: string;
  mfa_required: boolean;
}

interface TokenResponse {
  token: string;
}

interface MeResponse {
  user: { email: string };
  provider?: { role: string | null };
  tenant?: { id: string; name: string };
  roles?: string[];
  permissions?: string[];
}

interface AuthContextValue {
  session: Session | null;
  isRestoring: boolean;
  login(email: string, password: string): Promise<{ challenge: string }>;
  verifyMfa(challenge: string, code: string): Promise<MfaResult>;
  selectProvider(selection: string): Promise<void>;
  selectCompany(selection: string, tenantId: string): Promise<void>;
  logout(): void;
  refreshMe(): Promise<void>;
}

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
    this.name = 'ApiError';
  }
}

async function request<T>(
  path: string,
  init: RequestInit = {},
  token?: string,
): Promise<T> {
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

function sessionFromMe(token: string, me: MeResponse): Session {
  const roles = me.roles ?? [];
  if (me.provider) {
    return {
      token,
      surface: 'provider',
      email: me.user.email,
      role: me.provider.role ?? roles.join(', '),
      permissions: me.permissions ?? [],
    };
  }

  return {
    token,
    surface: 'company',
    ...(me.tenant ? { tenantId: me.tenant.id } : {}),
    ...(me.tenant ? { tenantName: me.tenant.name } : {}),
    email: me.user.email,
    role: roles.join(', '),
    permissions: me.permissions ?? [],
  };
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [pendingSessionToken] = useState(() =>
    typeof window === 'undefined' ? null : window.sessionStorage.getItem('nexo_pending_session'),
  );
  const [isRestoring, setIsRestoring] = useState(Boolean(pendingSessionToken));
  const restoreStarted = useRef(false);

  useEffect(() => {
    if (!pendingSessionToken || restoreStarted.current) return;
    restoreStarted.current = true;
    window.sessionStorage.removeItem('nexo_pending_session');
    void request<MeResponse>('/v1/me', {}, pendingSessionToken)
      .then(me => setSession(sessionFromMe(pendingSessionToken, me)))
      .catch(() => setSession(null))
      .finally(() => setIsRestoring(false));
  }, [pendingSessionToken]);

  async function login(email: string, password: string) {
    const result = await request<LoginResponse>('/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    return { challenge: result.challenge };
  }

  async function verifyMfa(challenge: string, code: string) {
    return request<MfaResult>('/v1/auth/mfa', {
      method: 'POST',
      body: JSON.stringify({ challenge, code }),
    });
  }

  async function openSession(selection: string, scopeKind: 'provider' | 'tenant', tenantId?: string) {
    const result = await request<TokenResponse>('/v1/session/select', {
      method: 'POST',
      body: JSON.stringify({
        selection,
        scope_kind: scopeKind,
        ...(tenantId ? { tenant_id: tenantId } : {}),
      }),
    });
    const me = await request<MeResponse>('/v1/me', {}, result.token);
    setSession(sessionFromMe(result.token, me));
  }

  async function selectProvider(selection: string) {
    await openSession(selection, 'provider');
  }

  async function selectCompany(selection: string, tenantId: string) {
    await openSession(selection, 'tenant', tenantId);
  }

  function logout() {
    const current = session;
    setSession(null);
    if (current) {
      void request<void>('/v1/session/revoke', { method: 'POST' }, current.token).catch(() => undefined);
    }
  }

  async function refreshMe() {
    if (!session) throw new ApiError(401, 'unauthorized');
    try {
      const me = await request<MeResponse>('/v1/me', {}, session.token);
      setSession(sessionFromMe(session.token, me));
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) setSession(null);
      throw error;
    }
  }

  return (
    <AuthContext.Provider
      value={{ session, isRestoring, login, verifyMfa, selectProvider, selectCompany, logout, refreshMe }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth debe usarse dentro de AuthProvider');
  return context;
}
