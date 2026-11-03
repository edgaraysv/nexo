import { useEffect, useState, type FormEvent } from 'react';
import { ApiError, useApi } from '../../api';
import { useAuth } from '../../auth/AuthContext';
import { Button, Card, Table } from '../../components';

interface OperationView {
  id: string;
  targetDeviceId: string;
  type: 'endpoint.runtime_info.v1';
  status: string;
  revision: number;
  expiresAt: string;
  deliveryAttempts: number;
  result?: Record<string, unknown>;
  observedAt?: string;
  errorCode?: string;
}

interface HeartbeatRecord {
  deviceId: string;
  observedAt: string;
  receivedAt: string;
  agentVersion: string;
}

interface HeartbeatWire {
  device_id?: string;
  deviceId?: string;
  observed_at?: string;
  observedAt?: string;
  received_at?: string;
  receivedAt?: string;
  agent_version?: string;
  agentVersion?: string;
}

interface CompanyAuditEvent {
  id: string;
  actorUserId?: string;
  action: string;
  resourceType: string;
  resourceId?: string;
  createdAt: string;
}

interface AgentWire {
  id: string;
  name: string;
  status: string;
  deviceKind?: 'endpoint' | 'gateway';
  device_kind?: 'endpoint' | 'gateway';
}

interface Agent {
  id: string;
  name: string;
  status: string;
  deviceKind: 'endpoint' | 'gateway' | undefined;
}

interface ItemsResponse<T> {
  items: T[];
  total?: number;
}

type LoadState<T> =
  | { status: 'loading' }
  | { status: 'ready'; data: ItemsResponse<T> }
  | { status: 'forbidden' }
  | { status: 'error'; code: string };

function failed<T>(error: unknown): LoadState<T> {
  if (error instanceof ApiError && error.status === 403) return { status: 'forbidden' };
  return { status: 'error', code: error instanceof ApiError ? error.code : 'request_failed' };
}

function statusMessage<T>(state: LoadState<T>, loading = 'Cargando…') {
  if (state.status === 'loading') return <p className="nx-muted">{loading}</p>;
  if (state.status === 'forbidden') return <p>Sin permiso.</p>;
  if (state.status === 'error') return <p role="status">{state.code}</p>;
  return null;
}

function normalizeHeartbeats(items: HeartbeatWire[]): HeartbeatRecord[] {
  return items.map((item) => ({
    deviceId: item.deviceId ?? item.device_id ?? '',
    observedAt: item.observedAt ?? item.observed_at ?? '—',
    receivedAt: item.receivedAt ?? item.received_at ?? '—',
    agentVersion: item.agentVersion ?? item.agent_version ?? '—',
  }));
}

function normalizeAgents(items: AgentWire[]): Agent[] {
  return items.map((agent) => ({
    id: agent.id,
    name: agent.name,
    status: agent.status,
    deviceKind: agent.deviceKind ?? agent.device_kind,
  }));
}

function errorCodeFromPayload(payload: unknown): string {
  if (typeof payload === 'object' && payload !== null && 'error' in payload && typeof payload.error === 'string') {
    return payload.error;
  }
  return 'request_failed';
}

export default function CompanyActivityPage() {
  const api = useApi();
  const { session } = useAuth();
  const permissions = session?.permissions ?? [];
  const canCreateOperation = permissions.includes('company.operation.create');
  const canReadAudit = permissions.includes('company.audit.read');
  const canExport = permissions.includes('company.report.export');
  const canExportSummary = canExport && permissions.includes('company.summary.read');
  const canExportAudit = canExport && permissions.includes('company.audit.read');
  const [operations, setOperations] = useState<LoadState<OperationView>>({ status: 'loading' });
  const [heartbeats, setHeartbeats] = useState<LoadState<HeartbeatRecord>>({ status: 'loading' });
  const [audit, setAudit] = useState<LoadState<CompanyAuditEvent>>(canReadAudit ? { status: 'loading' } : { status: 'forbidden' });
  const [agents, setAgents] = useState<LoadState<Agent>>({ status: 'loading' });
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let current = true;
    const auditRequest = canReadAudit
      ? api.get<ItemsResponse<CompanyAuditEvent>>('/v1/company/audit?page_size=50')
      : Promise.resolve(undefined);
    void Promise.allSettled([
      api.get<ItemsResponse<OperationView>>('/v1/company/operations?page_size=50'),
      api.get<ItemsResponse<HeartbeatWire>>('/v1/company/heartbeats?page_size=50'),
      auditRequest,
      api.get<ItemsResponse<AgentWire>>('/v1/company/agents?page_size=100'),
    ]).then(([operationsResult, heartbeatsResult, auditResult, agentsResult]) => {
      if (!current) return;
      if (operationsResult.status === 'fulfilled') setOperations({ status: 'ready', data: operationsResult.value });
      else setOperations(failed(operationsResult.reason));
      if (heartbeatsResult.status === 'fulfilled') {
        setHeartbeats({ status: 'ready', data: { ...heartbeatsResult.value, items: normalizeHeartbeats(heartbeatsResult.value.items) } });
      } else setHeartbeats(failed(heartbeatsResult.reason));
      if (auditResult.status === 'fulfilled') {
        if (auditResult.value) setAudit({ status: 'ready', data: auditResult.value });
        else setAudit({ status: 'forbidden' });
      } else setAudit(failed(auditResult.reason));
      if (agentsResult.status === 'fulfilled') {
        setAgents({ status: 'ready', data: { ...agentsResult.value, items: normalizeAgents(agentsResult.value.items) } });
      } else setAgents(failed(agentsResult.reason));
    });
    return () => { current = false; };
  }, [api, canReadAudit, refresh]);

  const operationItems = operations.status === 'ready' ? operations.data.items : [];
  const approvedAgents = agents.status === 'ready'
    ? agents.data.items.filter((agent) => agent.deviceKind === 'endpoint' && agent.status === 'approved')
    : [];
  const agentNames = new Map((agents.status === 'ready' ? agents.data.items : []).map((agent) => [agent.id, agent.name]));

  async function requestDiagnostic(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    const values = new FormData(form);
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await api.post<OperationView>('/v1/company/operations', {
        target_device_id: String(values.get('target_device_id') ?? ''),
        type: 'endpoint.runtime_info.v1',
        arguments: {},
        idempotency_key: crypto.randomUUID(),
        expires_in: 300,
      });
      setNotice('Diagnóstico solicitado. La operación puede tardar en ser entregada.');
      setRefresh((value) => value + 1);
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.code : 'request_failed');
    } finally {
      setBusy(false);
    }
  }

  async function exportCsv(dataset: 'summary' | 'audit') {
    if (!session) return;
    setError('');
    setNotice('');
    try {
      const query = new URLSearchParams({ dataset });
      const response = await fetch(`/v1/company/report/export.csv?${query.toString()}`, {
        headers: { authorization: `Bearer ${session.token}` },
      });
      if (!response.ok) {
        let payload: unknown;
        try {
          payload = await response.json();
        } catch {
          payload = undefined;
        }
        throw new ApiError(response.status, errorCodeFromPayload(payload));
      }
      const text = await response.text();
      const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const filenameHeader = response.headers.get('content-disposition') ?? '';
      const filenameMatch = /filename="([^"]+)"/u.exec(filenameHeader);
      const link = Object.assign(document.createElement('a'), {
        href: url,
        download: filenameMatch?.[1] ?? `nexo-company-${dataset}.csv`,
      });
      document.body.appendChild(link);
      link.click();
      window.setTimeout(() => {
        URL.revokeObjectURL(url);
        link.remove();
      }, 1000);
      setNotice('CSV descargado desde el alcance autorizado.');
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.code : 'request_failed');
    }
  }

  return (
    <section aria-labelledby="page-title">
      <h1 id="page-title">Operaciones y auditoría</h1>
      <p className="nx-lede">Los datos muestran fuente, cobertura y momento de lectura. Un heartbeat no demuestra conectividad a una aplicación.</p>

      {canCreateOperation && (
        <Card heading="Solicitar diagnóstico">
          {statusMessage(agents, 'Cargando dispositivos aprobados…')}
          {agents.status === 'ready' && (
            <form className="nx-row" onSubmit={requestDiagnostic}>
              <label className="nx-field">
                <span>Dispositivo</span>
                <select className="nx-select" name="target_device_id" required defaultValue="">
                  <option value="" disabled>Selecciona un endpoint aprobado</option>
                  {approvedAgents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
                </select>
              </label>
              <label className="nx-field">
                <span>Diagnóstico</span>
                <input className="nx-input" value="endpoint.runtime_info.v1" readOnly />
              </label>
              <Button type="submit" disabled={busy || approvedAgents.length === 0}>
                {busy ? 'Solicitando…' : 'Solicitar diagnóstico'}
              </Button>
              {approvedAgents.length === 0 && <p className="nx-muted">No hay endpoints aprobados disponibles.</p>}
            </form>
          )}
        </Card>
      )}

      <Card heading="Operaciones">
        {statusMessage(operations)}
        {operations.status === 'ready' && (
          <Table
            headers={['Dispositivo', 'Tipo', 'Estado', 'Revisión', 'Entregas', 'Observado', 'Error']}
            rows={operationItems}
            renderRow={(operation) => [
              agentNames.get(operation.targetDeviceId) ?? operation.targetDeviceId,
              operation.type,
              operation.status,
              operation.revision,
              operation.deliveryAttempts,
              operation.observedAt ?? '—',
              operation.errorCode ?? '—',
            ]}
            empty="No hay operaciones para los dispositivos visibles en esta sesión."
          />
        )}
      </Card>

      <Card heading="Heartbeats">
        {statusMessage(heartbeats)}
        {heartbeats.status === 'ready' && (
          <Table
            headers={['Dispositivo', 'Observado', 'Recibido', 'Versión agente']}
            rows={heartbeats.data.items}
            renderRow={(heartbeat) => [agentNames.get(heartbeat.deviceId) ?? heartbeat.deviceId, heartbeat.observedAt, heartbeat.receivedAt, heartbeat.agentVersion]}
            empty="No hay heartbeats registrados."
          />
        )}
      </Card>

      <Card heading="Auditoría">
        {!canReadAudit && <p className="nx-muted">Sin permiso para ver eventos de auditoría.</p>}
        {canReadAudit && statusMessage(audit)}
        {canReadAudit && audit.status === 'ready' && (
          <Table
            headers={['Actor', 'Acción', 'Tipo de recurso', 'ID de recurso', 'Fecha']}
            rows={audit.data.items}
            renderRow={(event) => [event.actorUserId ?? 'Agente/sistema', event.action, event.resourceType, event.resourceId ?? '—', event.createdAt]}
            empty="No hay eventos de auditoría."
          />
        )}
      </Card>

      <Card heading="Exportación CSV">
        {!canExport && <p>Sin permiso para exportar datos.</p>}
        {canExport && (
          <div className="nx-row">
            <Button type="button" disabled={!canExportSummary} onClick={() => void exportCsv('summary')}>Exportar resumen</Button>
            <Button type="button" variant="secondary" disabled={!canExportAudit} onClick={() => void exportCsv('audit')}>Exportar auditoría</Button>
            {!canExportSummary && <p className="nx-muted">Falta permiso de lectura del resumen para exportarlo.</p>}
            {!canExportAudit && <p className="nx-muted">Falta permiso de auditoría para exportarla.</p>}
          </div>
        )}
      </Card>

      <p className="nx-status" role="status" aria-live="polite">{error || notice}</p>
    </section>
  );
}
