import { useEffect, useState, type FormEvent } from 'react';
import { useApi, ApiError } from '../../api';
import { useAuth } from '../../auth/AuthContext';
import { Button, Card, Input, Table } from '../../components';

interface Company {
  id: string;
  name: string;
  status: string;
}

interface Operator {
  userId: string;
  email?: string;
  status: string;
}

interface Setting {
  key: string;
  sensitivity: 'normal' | 'secret_ref';
  value?: unknown;
  secretConfigured?: boolean;
  revision: number;
}

interface ItemsResponse<T> {
  items: T[];
}

type LoadState =
  | { status: 'loading' }
  | { status: 'ready' }
  | { status: 'forbidden' }
  | { status: 'error'; code: string };

function loadFailure(error: unknown): LoadState {
  if (error instanceof ApiError && error.status === 403) return { status: 'forbidden' };
  return { status: 'error', code: error instanceof ApiError ? error.code : 'request_failed' };
}

function renderLoadState(state: LoadState) {
  if (state.status === 'loading') return <p className="nx-muted">Cargando…</p>;
  if (state.status === 'forbidden') return <p>Sin permiso.</p>;
  if (state.status === 'error') return <p role="status">{state.code}</p>;
  return null;
}

function settingValue(setting: Setting): string {
  if (setting.sensitivity === 'secret_ref') return setting.secretConfigured ? 'Referencia protegida configurada' : 'No configurada';
  if (typeof setting.value === 'string') return setting.value;
  if (setting.value === undefined) return '—';
  return JSON.stringify(setting.value);
}

export default function ProviderCompaniesPage() {
  const api = useApi();
  const { session } = useAuth();
  const isOwner = session?.role === 'owner';
  const [companies, setCompanies] = useState<Company[]>([]);
  const [operators, setOperators] = useState<Operator[]>([]);
  const [assignments, setAssignments] = useState<Operator[]>([]);
  const [settings, setSettings] = useState<Setting[]>([]);
  const [companiesState, setCompaniesState] = useState<LoadState>({ status: 'loading' });
  const [operatorsState, setOperatorsState] = useState<LoadState>({ status: 'loading' });
  const [assignmentsState, setAssignmentsState] = useState<LoadState>({ status: 'loading' });
  const [settingsState, setSettingsState] = useState<LoadState>({ status: 'loading' });
  const [companyId, setCompanyId] = useState('');
  const [operatorId, setOperatorId] = useState('');
  const [sensitivity, setSensitivity] = useState<'normal' | 'secret_ref'>('normal');
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirmPending, setConfirmPending] = useState(false);
  const [pendingUnassignId, setPendingUnassignId] = useState('');

  useEffect(() => {
    let current = true;
    const operatorsRequest = isOwner ? api.get<ItemsResponse<Operator>>('/v1/provider/operators') : Promise.resolve({ items: [] });
    const settingsRequest = isOwner ? api.get<ItemsResponse<Setting>>('/v1/provider/settings') : Promise.resolve({ items: [] });
    void Promise.allSettled([
      api.get<ItemsResponse<Company>>('/v1/provider/companies'),
      operatorsRequest,
      settingsRequest,
    ]).then(([companyResult, operatorResult, settingsResult]) => {
      if (!current) return;
      if (companyResult.status === 'fulfilled') {
        setCompanies(companyResult.value.items);
        setCompaniesState({ status: 'ready' });
        setCompanyId((selected) => selected || companyResult.value.items[0]?.id || '');
      } else {
        setCompaniesState(loadFailure(companyResult.reason));
      }
      if (operatorResult.status === 'fulfilled') {
        setOperators(operatorResult.value.items);
        setOperatorsState({ status: 'ready' });
        setOperatorId((selected) => selected || operatorResult.value.items[0]?.userId || '');
      } else {
        setOperatorsState(loadFailure(operatorResult.reason));
      }
      if (settingsResult.status === 'fulfilled') {
        setSettings(settingsResult.value.items);
        setSettingsState({ status: 'ready' });
      } else {
        setSettingsState(loadFailure(settingsResult.reason));
      }
    });
    return () => { current = false; };
  }, [api, isOwner, refresh]);

  useEffect(() => {
    if (!isOwner || !companyId) {
      setAssignments([]);
      setAssignmentsState({ status: 'ready' });
      return;
    }
    let current = true;
    setAssignmentsState({ status: 'loading' });
    void api.get<ItemsResponse<Operator>>(`/v1/provider/companies/${encodeURIComponent(companyId)}/operators`)
      .then((result) => {
        if (!current) return;
        setAssignments(result.items);
        setAssignmentsState({ status: 'ready' });
      })
      .catch((reason: unknown) => {
        if (!current) return;
        setAssignmentsState(loadFailure(reason));
      });
    return () => { current = false; };
  }, [api, companyId, isOwner, refresh]);

  async function createCompany(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    const values = new FormData(form);
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const created = await api.post<Company>('/v1/provider/companies', {
        slug: String(values.get('slug') ?? ''),
        name: String(values.get('name') ?? ''),
      });
      setCompanies((current) => [...current, created]);
      setCompanyId(created.id);
      setNotice('Empresa creada.');
      form.reset();
      setRefresh((value) => value + 1);
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.code : 'request_failed');
    } finally {
      setBusy(false);
    }
  }

  async function assignOperator(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !companyId || !operatorId) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await api.put<void>(`/v1/provider/companies/${encodeURIComponent(companyId)}/operators/${encodeURIComponent(operatorId)}`, {});
      setNotice('Operador asignado.');
      setRefresh((value) => value + 1);
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.code : 'request_failed');
    } finally {
      setBusy(false);
    }
  }

  async function unassignOperator(userId: string) {
    if (busy || !companyId) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await api.del<void>(`/v1/provider/companies/${encodeURIComponent(companyId)}/operators/${encodeURIComponent(userId)}`);
      setNotice('Asignación retirada.');
      setConfirmPending(false);
      setPendingUnassignId('');
      setRefresh((value) => value + 1);
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.code : 'request_failed');
    } finally {
      setBusy(false);
    }
  }

  async function saveSetting(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    const values = new FormData(form);
    const key = String(values.get('key') ?? '');
    const entry = String(values.get('entry') ?? '');
    const expectedRevision = settings.find((setting) => setting.key === key)?.revision;
    const body = sensitivity === 'secret_ref'
      ? { sensitivity, secret_ref: entry, ...(expectedRevision !== undefined ? { expected_revision: expectedRevision } : {}) }
      : { sensitivity, value: entry, ...(expectedRevision !== undefined ? { expected_revision: expectedRevision } : {}) };
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await api.put<Setting>(`/v1/provider/settings/${encodeURIComponent(key)}`, body);
      setNotice('Configuración guardada.');
      form.reset();
      setSensitivity('normal');
      setRefresh((value) => value + 1);
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.code : 'request_failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="page-title">
      <h1 id="page-title">Empresas</h1>

      <Card heading="Empresas disponibles">
        {renderLoadState(companiesState)}
        {companiesState.status === 'ready' && (
          <Table
            headers={['Empresa', 'Estado']}
            rows={companies}
            renderRow={(company) => [company.name, company.status]}
            empty="No hay empresas para este alcance."
          />
        )}
      </Card>

      {isOwner && (
        <Card heading="Asignación de operadores">
          {companiesState.status === 'forbidden' && <p>Sin permiso.</p>}
          {companiesState.status === 'error' && <p role="status">{companiesState.code}</p>}
          {operatorsState.status === 'loading' && <p className="nx-muted">Cargando…</p>}
          {operatorsState.status === 'forbidden' && <p>Sin permiso.</p>}
          {operatorsState.status === 'error' && <p role="status">{operatorsState.code}</p>}
          {companiesState.status === 'ready' && operatorsState.status === 'ready' && (
            <>
              <form className="nx-row" onSubmit={assignOperator}>
                <label className="nx-field">
                  <span>Empresa</span>
                  <select className="nx-select" value={companyId} onChange={(event) => {
                    setCompanyId(event.target.value);
                    setConfirmPending(false);
                    setPendingUnassignId('');
                  }} required>
                    <option value="" disabled>Selecciona una empresa</option>
                    {companies.map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}
                  </select>
                </label>
                <label className="nx-field">
                  <span>Operador</span>
                  <select className="nx-select" value={operatorId} onChange={(event) => setOperatorId(event.target.value)} required>
                    <option value="" disabled>Selecciona un operador</option>
                    {operators.map((operator) => <option key={operator.userId} value={operator.userId}>{operator.email ?? operator.userId}</option>)}
                  </select>
                </label>
                <Button type="submit" disabled={busy || !companyId || !operatorId || operators.length === 0}>Asignar</Button>
              </form>
              {assignmentsState.status === 'loading' && <p className="nx-muted">Cargando asignaciones…</p>}
              {assignmentsState.status === 'forbidden' && <p>Sin permiso.</p>}
              {assignmentsState.status === 'error' && <p role="status">{assignmentsState.code}</p>}
              {assignmentsState.status === 'ready' && (
                <Table
                  headers={['Operador', 'Estado', 'Acción']}
                  rows={assignments}
                  renderRow={(operator) => [
                    operator.email ?? operator.userId,
                    operator.status,
                    confirmPending && pendingUnassignId === operator.userId ? (
                      <div className="nx-row">
                        <Button type="button" variant="secondary" onClick={() => { setConfirmPending(false); setPendingUnassignId(''); }}>
                          Revisar: se retirará la asignación de {operator.email ?? operator.userId}.
                        </Button>
                        <Button type="button" variant="danger" disabled={busy} onClick={() => void unassignOperator(operator.userId)}>
                          Confirmar desasignación
                        </Button>
                      </div>
                    ) : (
                      <Button type="button" variant="secondary" onClick={() => { setPendingUnassignId(operator.userId); setConfirmPending(true); }}>
                        Revisar desasignación
                      </Button>
                    ),
                  ]}
                  empty="No hay operadores asignados a esta empresa."
                />
              )}
            </>
          )}
        </Card>
      )}

      {isOwner && (
        <Card heading="Crear empresa">
          <form className="nx-row" onSubmit={createCompany}>
            <Input label="Identificador" name="slug" required maxLength={64} pattern="[a-z0-9][a-z0-9-]{1,62}[a-z0-9]" />
            <Input label="Nombre" name="name" required maxLength={160} />
            <Button type="submit" disabled={busy}>{busy ? 'Creando…' : 'Crear empresa'}</Button>
          </form>
        </Card>
      )}

      {isOwner && (
        <Card heading="Configuración del proveedor">
          {settingsState.status === 'loading' && <p className="nx-muted">Cargando…</p>}
          {settingsState.status === 'forbidden' && <p>Sin permiso.</p>}
          {settingsState.status === 'error' && <p role="status">{settingsState.code}</p>}
          {settingsState.status === 'ready' && (
            <Table
              headers={['Parámetro', 'Tipo', 'Valor o estado', 'Revisión']}
              rows={settings}
              renderRow={(setting) => [setting.key, setting.sensitivity, settingValue(setting), setting.revision]}
              empty="No hay parámetros configurados."
            />
          )}
          <form className="nx-row" onSubmit={saveSetting}>
            <Input label="Parámetro" name="key" required minLength={3} maxLength={128} pattern="[a-z][a-z0-9_.-]{2,127}" />
            <label className="nx-field">
              <span>Tipo</span>
              <select className="nx-select" value={sensitivity} onChange={(event) => setSensitivity(event.target.value === 'secret_ref' ? 'secret_ref' : 'normal')}>
                <option value="normal">Valor normal</option>
                <option value="secret_ref">Referencia protegida</option>
              </select>
            </label>
            <Input label="Valor/referencia" name="entry" type={sensitivity === 'secret_ref' ? 'password' : 'text'} required maxLength={512} autoComplete="off" />
            <Button type="submit" disabled={busy}>{busy ? 'Guardando…' : 'Guardar configuración'}</Button>
          </form>
          <p className="nx-muted">Las referencias protegidas no se vuelven a mostrar.</p>
        </Card>
      )}

      <p className="nx-status" role="status" aria-live="polite">{error || notice}</p>
    </section>
  );
}
