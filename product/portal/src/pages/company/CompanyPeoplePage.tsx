import { useEffect, useState, type FormEvent } from 'react';
import { ApiError, useApi } from '../../api';
import { useAuth } from '../../auth/AuthContext';
import { Button, Card, Table } from '../../components';

interface CompanyUser {
  userId: string;
  email: string;
  status: string;
  roles: string[];
}

interface CompanySite {
  id: string;
  name: string;
}

interface DeclaredDevice {
  id: string;
  siteId?: string;
  name: string;
  platform: string;
  status: string;
}

interface ExportGrant {
  role: string;
  enabled: boolean;
}

interface DeviceInvitation {
  token: string;
  expires_in: number;
  uses: number;
}

interface ItemsResponse<T> {
  items: T[];
}

type LoadState =
  | { status: 'loading' }
  | { status: 'ready' }
  | { status: 'forbidden' }
  | { status: 'error'; code: string };

function failed(error: unknown): LoadState {
  if (error instanceof ApiError && error.status === 403) return { status: 'forbidden' };
  return { status: 'error', code: error instanceof ApiError ? error.code : 'request_failed' };
}

function renderLoadState(state: LoadState) {
  if (state.status === 'loading') return <p className="nx-muted">Cargando…</p>;
  if (state.status === 'forbidden') return <p>Sin permiso.</p>;
  if (state.status === 'error') return <p role="status">{state.code}</p>;
  return null;
}

export default function CompanyPeoplePage() {
  const api = useApi();
  const { session } = useAuth();
  const permissions = session?.permissions ?? [];
  const canCreateDevice = permissions.includes('company.device.create');
  const canInviteDevice = permissions.includes('company.agent.invite');
  const canManageExports = permissions.includes('company.resource_grant.manage');
  const [users, setUsers] = useState<CompanyUser[]>([]);
  const [sites, setSites] = useState<CompanySite[]>([]);
  const [grants, setGrants] = useState<ExportGrant[]>([]);
  const [usersState, setUsersState] = useState<LoadState>({ status: 'loading' });
  const [sitesState, setSitesState] = useState<LoadState>(canCreateDevice ? { status: 'loading' } : { status: 'ready' });
  const [grantsState, setGrantsState] = useState<LoadState>(canManageExports ? { status: 'loading' } : { status: 'ready' });
  const [invitation, setInvitation] = useState<DeviceInvitation | null>(null);
  const [deviceKind, setDeviceKind] = useState<'endpoint' | 'gateway'>('endpoint');
  const [busy, setBusy] = useState(false);
  const [busyRole, setBusyRole] = useState('');
  const [pendingGrantRole, setPendingGrantRole] = useState('');
  const [confirmPending, setConfirmPending] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    if (!canCreateDevice) return;
    let current = true;
    void api.get<ItemsResponse<CompanySite>>('/v1/company/sites')
      .then((response) => {
        if (!current) return;
        setSites(response.items);
        setSitesState({ status: 'ready' });
      })
      .catch((reason: unknown) => {
        if (current) setSitesState(failed(reason));
      });
    return () => { current = false; };
  }, [api, canCreateDevice]);

  useEffect(() => {
    let current = true;
    const grantsRequest = canManageExports
      ? api.get<ItemsResponse<ExportGrant>>('/v1/company/report/export-grants')
      : Promise.resolve(undefined);
    void Promise.allSettled([
      api.get<ItemsResponse<CompanyUser>>('/v1/company/users'),
      grantsRequest,
    ]).then(([usersResult, grantsResult]) => {
      if (!current) return;
      if (usersResult.status === 'fulfilled') {
        setUsers(usersResult.value.items);
        setUsersState({ status: 'ready' });
      } else {
        setUsersState(failed(usersResult.reason));
      }
      if (grantsResult.status === 'fulfilled') {
        if (grantsResult.value) {
          setGrants(grantsResult.value.items);
          setGrantsState({ status: 'ready' });
        }
      } else {
        setGrantsState(failed(grantsResult.reason));
      }
    });
    return () => { current = false; };
  }, [api, canManageExports]);

  async function registerDevice(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    const values = new FormData(form);
    const siteId = String(values.get('site_id') ?? '');
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await api.post<DeclaredDevice>('/v1/company/devices', {
        name: String(values.get('name') ?? '').trim(),
        platform: String(values.get('platform') ?? 'unknown'),
        ...(siteId ? { site_id: siteId } : {}),
      });
      setNotice('Dispositivo declarado.');
      form.reset();
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.code : 'request_failed');
    } finally {
      setBusy(false);
    }
  }

  async function createInvitation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    setInvitation(null);
    try {
      const created = await api.post<DeviceInvitation>('/v1/company/device-invitations', {
        device_kind: deviceKind,
        uses: 1,
      });
      setInvitation(created);
      setNotice('Invitación creada. Guarda el token antes de salir de esta página.');
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.code : 'request_failed');
    } finally {
      setBusy(false);
    }
  }

  async function copyInvitationToken() {
    if (!invitation) return;
    try {
      await navigator.clipboard.writeText(invitation.token);
      setNotice('Token copiado. Recuerda guardarlo ahora; no se vuelve a mostrar.');
      setError('');
    } catch {
      setError('clipboard_unavailable');
    }
  }

  async function updateGrant(role: string, enabled: boolean) {
    if (busyRole) return;
    setBusyRole(role);
    setError('');
    setNotice('');
    try {
      const result = await api.put<{ role: string; enabled: boolean }>(
        `/v1/company/report/export-grants/${encodeURIComponent(role)}`,
        { enabled },
      );
      setGrants((current) => current.map((grant) => grant.role === role ? { ...grant, enabled: result.enabled } : grant));
      setPendingGrantRole('');
      setConfirmPending(false);
      setNotice('Permiso de exportación actualizado.');
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.code : 'request_failed');
    } finally {
      setBusyRole('');
    }
  }

  function onGrantToggle(role: string, enabled: boolean) {
    if (enabled) {
      void updateGrant(role, true);
      return;
    }
    setPendingGrantRole(role);
    setConfirmPending(false);
  }

  const exportGrantRows = grants.map((grant) => ({ ...grant }));

  return (
    <section aria-labelledby="page-title">
      <h1 id="page-title">Usuarios y equipos</h1>

      <Card heading="Usuarios">
        {renderLoadState(usersState)}
        {usersState.status === 'ready' && (
          <Table
            headers={['Email', 'Estado', 'Roles']}
            rows={users}
            renderRow={(user) => [user.email, user.status, user.roles.join(', ') || '—']}
            empty="No hay usuarios en esta empresa."
          />
        )}
      </Card>

      {canCreateDevice && (
        <Card heading="Registrar dispositivo">
          {renderLoadState(sitesState)}
          <form className="nx-row" onSubmit={registerDevice}>
            <label className="nx-field">
              <span>Sede (opcional)</span>
              <select className="nx-select" name="site_id" defaultValue="">
                <option value="">Sin sede</option>
                {sites.map((site) => <option key={site.id} value={site.id}>{site.name}</option>)}
              </select>
            </label>
            <label className="nx-field">
              <span>Plataforma</span>
              <select className="nx-select" name="platform" defaultValue="windows">
                <option value="windows">Windows</option>
                <option value="linux">Linux</option>
                <option value="macos">macOS</option>
                <option value="gateway">Gateway</option>
                <option value="unknown">Desconocida</option>
              </select>
            </label>
            <label className="nx-field">
              <span>Nombre</span>
              <input className="nx-input" name="name" required maxLength={160} />
            </label>
            <Button type="submit" disabled={busy}>{busy ? 'Registrando…' : 'Registrar dispositivo'}</Button>
          </form>
        </Card>
      )}

      {canInviteDevice && (
        <Card heading="Invitación de dispositivo">
          <form className="nx-row" onSubmit={createInvitation}>
            <label className="nx-field">
              <span>Tipo de dispositivo</span>
              <select className="nx-select" value={deviceKind} onChange={(event) => setDeviceKind(event.target.value === 'gateway' ? 'gateway' : 'endpoint')}>
                <option value="endpoint">Endpoint</option>
                <option value="gateway">Gateway</option>
              </select>
            </label>
            <Button type="submit" disabled={busy}>{busy ? 'Creando…' : 'Crear invitación (un uso)'}</Button>
          </form>
          {invitation && (
            <div>
              <p>Guarda el token ahora: no se vuelve a mostrar. Vigencia: 15 minutos.</p>
              <pre className="nx-pre">{invitation.token}</pre>
              <Button type="button" variant="secondary" onClick={() => void copyInvitationToken()}>Copiar token</Button>
            </div>
          )}
        </Card>
      )}

      {canManageExports && (
        <Card heading="Permisos de exportación">
          {renderLoadState(grantsState)}
          {grantsState.status === 'ready' && (
            <Table
              headers={['Rol', 'Habilitado', 'Acción']}
              rows={exportGrantRows}
              renderRow={(grant) => [
                grant.role,
                grant.enabled ? 'Sí' : 'No',
                <input
                  type="checkbox"
                  aria-label={`Permitir exportación al rol ${grant.role}`}
                  checked={grant.enabled}
                  disabled={busyRole === grant.role}
                  onChange={(event) => onGrantToggle(grant.role, event.target.checked)}
                />,
              ]}
              empty="No hay roles configurables."
            />
          )}
          {pendingGrantRole && !confirmPending && (
            <Button type="button" variant="secondary" onClick={() => setConfirmPending(true)}>
              Revisar: se deshabilitará la exportación CSV para {pendingGrantRole}.
            </Button>
          )}
          {pendingGrantRole && confirmPending && (
            <div>
              <p role="alert">Confirmación requerida: el rol {pendingGrantRole} perderá el permiso de exportación.</p>
              <Button type="button" variant="secondary" onClick={() => { setPendingGrantRole(''); setConfirmPending(false); }}>Cancelar</Button>
              <Button type="button" variant="danger" disabled={busyRole === pendingGrantRole} onClick={() => void updateGrant(pendingGrantRole, false)}>
                {busyRole === pendingGrantRole ? 'Actualizando…' : 'Confirmar deshabilitación'}
              </Button>
            </div>
          )}
        </Card>
      )}

      <p className="nx-status" role="status" aria-live="polite">{error || notice}</p>
    </section>
  );
}
