import { useEffect, useState, type FormEvent } from 'react';
import { ApiError, useApi } from '../../api';
import { useAuth } from '../../auth/AuthContext';
import { Button, Card, Input, Table } from '../../components';

interface Company {
  id: string;
  name: string;
  status: string;
}

interface Plan {
  id: string;
  name: string;
}

interface ModuleState {
  state: string;
  revision?: number;
}

interface QuotaState {
  used: number;
  limit: number;
  exceptionRevision?: number;
}

interface CommercialState {
  subscription?: { planId?: string; state: string; revision?: number };
  modules: Record<string, ModuleState>;
  quotas: Record<string, QuotaState>;
  payments?: Array<{ id: string; amountMinor: number; currency: string; reference: string; paidAt: string }>;
}

interface ItemsResponse<T> {
  items: T[];
}

type LoadState =
  | { status: 'loading' }
  | { status: 'ready' }
  | { status: 'forbidden' }
  | { status: 'error'; code: string };

type Remote<T> =
  | { status: 'loading' }
  | { status: 'ready'; data: T }
  | { status: 'forbidden' }
  | { status: 'error'; code: string };

function loadFailure(error: unknown): LoadState {
  if (error instanceof ApiError && error.status === 403) return { status: 'forbidden' };
  return { status: 'error', code: error instanceof ApiError ? error.code : 'request_failed' };
}

function remoteFailure(error: unknown): Remote<never> {
  if (error instanceof ApiError && error.status === 403) return { status: 'forbidden' };
  return { status: 'error', code: error instanceof ApiError ? error.code : 'request_failed' };
}

function displayRemote<T>(remote: Remote<T> | undefined): string {
  if (!remote || remote.status === 'loading') return 'Cargando…';
  if (remote.status === 'forbidden') return 'Sin permiso.';
  if (remote.status === 'error') return remote.code;
  return 'Disponible';
}

function formatModules(modules: Record<string, ModuleState>): string {
  const entries = Object.entries(modules).map(([key, value]) => `${key}: ${value.state}`);
  return entries.length ? entries.join(', ') : '—';
}

function formatQuotas(quotas: Record<string, QuotaState>): string {
  const entries = Object.entries(quotas).map(([key, value]) => `${key}: ${value.used}/${value.limit}`);
  return entries.length ? entries.join(', ') : '—';
}

export default function ProviderCommercialPage() {
  const api = useApi();
  const { session } = useAuth();
  const isOwner = session?.role === 'owner';
  const [companies, setCompanies] = useState<Company[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [companyState, setCompanyState] = useState<LoadState>({ status: 'loading' });
  const [plansState, setPlansState] = useState<LoadState>({ status: 'loading' });
  const [commercialByCompany, setCommercialByCompany] = useState<Record<string, Remote<CommercialState>>>({});
  const [companyId, setCompanyId] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let current = true;
    void Promise.allSettled([
      api.get<ItemsResponse<Company>>('/v1/provider/companies'),
      api.get<ItemsResponse<Plan>>('/v1/provider/plans'),
    ]).then(([companiesResult, plansResult]) => {
      if (!current) return;
      if (companiesResult.status === 'fulfilled') {
        setCompanies(companiesResult.value.items);
        setCompanyState({ status: 'ready' });
        setCompanyId((selected) => companiesResult.value.items.some((company) => company.id === selected)
          ? selected
          : companiesResult.value.items[0]?.id || '');
      } else {
        setCompanyState(loadFailure(companiesResult.reason));
      }
      if (plansResult.status === 'fulfilled') {
        setPlans(plansResult.value.items);
        setPlansState({ status: 'ready' });
      } else {
        setPlansState(loadFailure(plansResult.reason));
      }
    });
    return () => { current = false; };
  }, [api, refresh]);

  useEffect(() => {
    if (companies.length === 0) {
      setCommercialByCompany({});
      return;
    }
    let current = true;
    const loading: Record<string, Remote<CommercialState>> = {};
    companies.forEach((company) => { loading[company.id] = { status: 'loading' }; });
    setCommercialByCompany(loading);
    void Promise.allSettled(companies.map((company) =>
      api.get<CommercialState>(`/v1/provider/companies/${encodeURIComponent(company.id)}/commercial`),
    )).then((results) => {
      if (!current) return;
      const next: Record<string, Remote<CommercialState>> = {};
      results.forEach((result, index) => {
        const company = companies[index];
        if (!company) return;
        next[company.id] = result.status === 'fulfilled'
          ? { status: 'ready', data: result.value }
          : remoteFailure(result.reason);
      });
      setCommercialByCompany(next);
    });
    return () => { current = false; };
  }, [api, companies, refresh]);

  async function createPlan(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    const values = new FormData(form);
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await api.post<Plan>('/v1/provider/plans', {
        code: String(values.get('code') ?? ''),
        name: String(values.get('name') ?? ''),
        modules: {
          vpn: values.has('vpn'),
          support: values.has('support'),
          backup: values.has('backup'),
        },
        quotas: { endpoints: Number(values.get('endpoints')) },
      });
      setNotice('Plan creado.');
      form.reset();
      setRefresh((value) => value + 1);
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.code : 'request_failed');
    } finally {
      setBusy(false);
    }
  }

  async function setSubscription(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !companyId) return;
    const values = new FormData(event.currentTarget);
    const selected = commercialByCompany[companyId];
    const subscription = selected?.status === 'ready' ? selected.data.subscription : undefined;
    const body = {
      plan_id: String(values.get('plan_id') ?? ''),
      state: String(values.get('state') ?? ''),
      ...(subscription?.revision !== undefined ? { expected_revision: subscription.revision } : {}),
    };
    await mutate(`/v1/provider/companies/${encodeURIComponent(companyId)}/subscription`, body, 'Suscripción actualizada.');
  }

  async function setModule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !companyId) return;
    const values = new FormData(event.currentTarget);
    const module = String(values.get('module') ?? '');
    const modules = commercialByCompany[companyId];
    const revision = modules?.status === 'ready' ? modules.data.modules[module]?.revision : undefined;
    const body = {
      state: String(values.get('state') ?? ''),
      ...(revision !== undefined ? { expected_revision: revision } : {}),
    };
    await mutate(`/v1/provider/companies/${encodeURIComponent(companyId)}/modules/${encodeURIComponent(module)}`, body, 'Estado del módulo actualizado.');
  }

  async function setQuotaException(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !companyId) return;
    const values = new FormData(event.currentTarget);
    const resource = String(values.get('resource') ?? '');
    const validUntil = String(values.get('valid_until') ?? '');
    const quotas = commercialByCompany[companyId];
    const exceptionRevision = quotas?.status === 'ready' ? quotas.data.quotas[resource]?.exceptionRevision : undefined;
    const body = {
      limit: Number(values.get('limit')),
      ...(validUntil ? { valid_until: new Date(validUntil).toISOString() } : {}),
      ...(exceptionRevision !== undefined ? { expected_revision: exceptionRevision } : {}),
    };
    await mutate(`/v1/provider/companies/${encodeURIComponent(companyId)}/quotas/${encodeURIComponent(resource)}/exception`, body, 'Excepción de cupo guardada.');
  }

  async function recordPayment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !companyId) return;
    const values = new FormData(event.currentTarget);
    const paidAt = String(values.get('paid_at') ?? '');
    const body = {
      idempotency_key: crypto.randomUUID(),
      amount_minor: Number(values.get('amount_minor')),
      currency: String(values.get('currency') ?? '').toUpperCase(),
      reference: String(values.get('reference') ?? ''),
      paid_at: paidAt ? new Date(paidAt).toISOString() : '',
    };
    await mutate(`/v1/provider/companies/${encodeURIComponent(companyId)}/payments`, body, 'Pago registrado.', 'POST');
  }

  async function mutate(path: string, body: unknown, successMessage: string, method: 'PUT' | 'POST' = 'PUT') {
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      if (method === 'POST') await api.post<unknown>(path, body);
      else await api.put<unknown>(path, body);
      setNotice(successMessage);
      setRefresh((value) => value + 1);
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.code : 'request_failed');
    } finally {
      setBusy(false);
    }
  }

  const selectedCommercial = companyId ? commercialByCompany[companyId] : undefined;
  const selectedData = selectedCommercial?.status === 'ready' ? selectedCommercial.data : undefined;
  const quotaResources = selectedData ? Object.keys(selectedData.quotas) : [];

  return (
    <section aria-labelledby="page-title">
      <h1 id="page-title">Comercial</h1>

      <Card heading="Estado por empresa">
        {companyState.status === 'loading' && <p className="nx-muted">Cargando…</p>}
        {companyState.status === 'forbidden' && <p>Sin permiso.</p>}
        {companyState.status === 'error' && <p role="status">{companyState.code}</p>}
        {companyState.status === 'ready' && (
          <Table
            headers={['Empresa', 'Suscripción', 'Módulos', 'Cuotas']}
            rows={companies}
            renderRow={(company) => {
              const commercial = commercialByCompany[company.id];
              if (!commercial || commercial.status !== 'ready') {
                const stateText = displayRemote(commercial);
                return [company.name, stateText, stateText, stateText];
              }
              return [
                company.name,
                commercial.data.subscription?.state ?? 'Sin suscripción',
                formatModules(commercial.data.modules),
                formatQuotas(commercial.data.quotas),
              ];
            }}
            empty="No hay empresas para este alcance."
          />
        )}
      </Card>

      {isOwner && (
        <Card heading="Crear plan">
          <form className="nx-grid" onSubmit={createPlan}>
            <Input label="Código" name="code" required maxLength={64} pattern="[a-z0-9][a-z0-9-]{1,62}" />
            <Input label="Nombre" name="name" required maxLength={120} />
            <Input label="Cupo de endpoints" name="endpoints" type="number" min={0} step={1} required />
            <label className="nx-field"><span><input name="vpn" type="checkbox" /> VPN</span></label>
            <label className="nx-field"><span><input name="support" type="checkbox" /> Soporte</span></label>
            <label className="nx-field"><span><input name="backup" type="checkbox" /> Backup</span></label>
            <Button type="submit" disabled={busy}>{busy ? 'Creando…' : 'Crear plan'}</Button>
          </form>
        </Card>
      )}

      <Card heading="Gestionar contrato y consumo">
        {companyState.status === 'loading' && <p className="nx-muted">Cargando empresas…</p>}
        {companyState.status === 'forbidden' && <p>Sin permiso.</p>}
        {companyState.status === 'error' && <p role="status">{companyState.code}</p>}
        {companyState.status === 'ready' && companies.length > 0 && (
          <label className="nx-field">
            <span>Empresa</span>
            <select className="nx-select" value={companyId} onChange={(event) => setCompanyId(event.target.value)}>
              {companies.map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}
            </select>
          </label>
        )}
        {selectedCommercial?.status === 'loading' && <p className="nx-muted">Cargando estado comercial…</p>}
        {selectedCommercial?.status === 'forbidden' && <p>Sin permiso.</p>}
        {selectedCommercial?.status === 'error' && <p role="status">{selectedCommercial.code}</p>}
        {selectedData && <div className="nx-table-wrap"><pre className="nx-pre">{JSON.stringify(selectedData, null, 2)}</pre></div>}

        {isOwner && companyId && (
          <div className="nx-grid">
            <Card heading="Suscripción">
              {plansState.status === 'loading' && <p className="nx-muted">Cargando planes…</p>}
              {plansState.status === 'forbidden' && <p>Sin permiso.</p>}
              {plansState.status === 'error' && <p role="status">{plansState.code}</p>}
              {plansState.status === 'ready' && (
                <form className="nx-grid" onSubmit={setSubscription}>
                  <label className="nx-field">
                    <span>Plan</span>
                    <select className="nx-select" name="plan_id" required defaultValue={selectedData?.subscription?.planId ?? ''}>
                      <option value="" disabled>Selecciona un plan</option>
                      {plans.map((plan) => <option key={plan.id} value={plan.id}>{plan.name}</option>)}
                    </select>
                  </label>
                  <label className="nx-field">
                    <span>Estado</span>
                    <select className="nx-select" name="state" defaultValue={selectedData?.subscription?.state ?? 'pending'}>
                      {['active', 'pending', 'grace', 'suspended', 'cancelled'].map((state) => <option key={state} value={state}>{state}</option>)}
                    </select>
                  </label>
                  <Button type="submit" disabled={busy || plans.length === 0}>{busy ? 'Guardando…' : 'Guardar suscripción'}</Button>
                </form>
              )}
            </Card>

            <Card heading="Servicio">
              <form className="nx-grid" onSubmit={setModule}>
                <label className="nx-field">
                  <span>Módulo</span>
                  <select className="nx-select" name="module">
                    {['vpn', 'support', 'backup'].map((module) => <option key={module} value={module}>{module}</option>)}
                  </select>
                </label>
                <label className="nx-field">
                  <span>Estado</span>
                  <select className="nx-select" name="state"><option value="active">active</option><option value="suspended">suspended</option></select>
                </label>
                <Button type="submit" disabled={busy || !selectedData}>{busy ? 'Guardando…' : 'Guardar servicio'}</Button>
              </form>
            </Card>

            <Card heading="Excepción de cupo">
              {selectedData && quotaResources.length === 0 && <p>No hay cupos definidos para esta empresa.</p>}
              <form className="nx-grid" onSubmit={setQuotaException}>
                <label className="nx-field">
                  <span>Recurso</span>
                  <select className="nx-select" name="resource" required disabled={quotaResources.length === 0}>
                    {quotaResources.map((resource) => <option key={resource} value={resource}>{resource}</option>)}
                  </select>
                </label>
                <Input label="Límite" name="limit" type="number" min={0} step={1} required />
                <Input label="Válida hasta (opcional)" name="valid_until" type="datetime-local" />
                <Button type="submit" disabled={busy || quotaResources.length === 0}>{busy ? 'Guardando…' : 'Guardar excepción'}</Button>
              </form>
            </Card>

            <Card heading="Pago manual">
              <form className="nx-grid" onSubmit={recordPayment}>
                <Input label="Importe en unidades menores" name="amount_minor" type="number" min={1} step={1} required />
                <Input label="Moneda ISO (3 letras)" name="currency" required minLength={3} maxLength={3} pattern="[A-Za-z]{3}" />
                <Input label="Referencia" name="reference" required maxLength={160} />
                <Input label="Fecha y hora del pago" name="paid_at" type="datetime-local" required />
                <Button type="submit" disabled={busy || !selectedData?.subscription}>{busy ? 'Registrando…' : 'Registrar pago'}</Button>
              </form>
              {!selectedData?.subscription && <p className="nx-muted">Se requiere una suscripción para registrar un pago.</p>}
            </Card>
          </div>
        )}
      </Card>

      <p className="nx-status" role="status" aria-live="polite">{error || notice}</p>
    </section>
  );
}
