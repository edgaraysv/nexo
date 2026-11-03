import { useEffect, useState, type FormEvent } from 'react';
import { ApiError, useApi } from '../../api';
import { useAuth } from '../../auth/AuthContext';
import { Button, Card, Input } from '../../components';

const SUPPORT_CAPABILITIES = ['terminal', 'file_transfer', 'screen_view'] as const;
type SupportCapability = typeof SUPPORT_CAPABILITIES[number];

const API_CAPABILITY: Record<SupportCapability, string> = {
  terminal: 'terminal',
  file_transfer: 'files',
  screen_view: 'screen',
};

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

interface SupportConsent {
  status: 'pending' | 'accepted' | 'rejected' | 'cancelled';
  requested_at: string;
  expires_at: string;
  accepted_at?: string;
  decided_at?: string;
  decision_origin?: string;
  revision: number;
}

interface SupportSessionView {
  id: string;
  device_id: string;
  mode: 'assisted';
  capabilities: string[];
  status: string;
  requested_at: string;
  consent_expires_at: string;
  expires_at: string;
  open_attempts: number;
  termination_status: string;
  revision: number;
  consent: SupportConsent;
}

interface ItemsResponse<T> {
  items: T[];
}

type LoadState<T> =
  | { status: 'loading' }
  | { status: 'ready'; data: T }
  | { status: 'forbidden' }
  | { status: 'error'; code: string };

type BusyAction = 'create' | 'refresh' | 'authorize' | 'open' | 'revoke' | null;

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

function normalizeAgents(items: AgentWire[]): Agent[] {
  return items.map((agent) => ({
    id: agent.id,
    name: agent.name,
    status: agent.status,
    deviceKind: agent.deviceKind ?? agent.device_kind,
  }));
}

function isTerminalSession(status: string): boolean {
  return ['rejected', 'expired', 'revoked', 'closed'].includes(status);
}

export default function CompanySupportPage() {
  const api = useApi();
  const { session } = useAuth();
  const canStart = session?.permissions.includes('company.support.start') === true;
  const [agents, setAgents] = useState<LoadState<Agent[]>>(canStart ? { status: 'loading' } : { status: 'forbidden' });
  const [supportSession, setSupportSession] = useState<SupportSessionView | null>(null);
  const [selectedCapabilities, setSelectedCapabilities] = useState<SupportCapability[]>(['terminal']);
  const [authorized, setAuthorized] = useState(false);
  const [authorizationResult, setAuthorizationResult] = useState<unknown>(null);
  const [openResult, setOpenResult] = useState<unknown>(null);
  const [busyAction, setBusyAction] = useState<BusyAction>(null);
  const [confirmPending, setConfirmPending] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    if (!canStart) return;
    let current = true;
    void api.get<ItemsResponse<AgentWire>>('/v1/company/agents?page_size=100')
      .then((response) => {
        if (current) setAgents({ status: 'ready', data: normalizeAgents(response.items) });
      })
      .catch((reason: unknown) => {
        if (current) setAgents(failed(reason));
      });
    return () => { current = false; };
  }, [api, canStart]);

  const approvedEndpoints = agents.status === 'ready'
    ? agents.data.filter((agent) => agent.deviceKind === 'endpoint' && agent.status === 'approved')
    : [];
  const currentSessionIsActive = supportSession !== null && !isTerminalSession(supportSession.status);
  const canCreateSession = !currentSessionIsActive;

  function toggleCapability(capability: SupportCapability, checked: boolean) {
    setSelectedCapabilities((current) => checked
      ? [...new Set([...current, capability])]
      : current.filter((item) => item !== capability));
  }

  async function requestSupport(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busyAction || !canCreateSession) return;
    if (selectedCapabilities.length === 0) {
      setError('select_capability_required');
      return;
    }
    const form = event.currentTarget;
    const values = new FormData(form);
    setBusyAction('create');
    setError('');
    setNotice('');
    setAuthorized(false);
    setAuthorizationResult(null);
    setOpenResult(null);
    setConfirmPending(false);
    try {
      const created = await api.post<SupportSessionView>('/v1/company/support/sessions', {
        device_id: String(values.get('device_id') ?? ''),
        mode: 'assisted',
        capabilities: selectedCapabilities.map((capability) => API_CAPABILITY[capability]),
        consent_timeout_seconds: Number(values.get('consent_timeout_seconds')),
      });
      setSupportSession(created);
      setNotice('Solicitud de soporte creada; está pendiente la decisión de consentimiento del dispositivo.');
      form.reset();
      setSelectedCapabilities(['terminal']);
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.code : 'request_failed');
    } finally {
      setBusyAction(null);
    }
  }

  async function refreshConsent() {
    if (!supportSession || busyAction) return;
    setBusyAction('refresh');
    setError('');
    setNotice('');
    try {
      const updated = await api.get<SupportSessionView>(`/v1/company/support/sessions/${encodeURIComponent(supportSession.id)}`);
      setSupportSession(updated);
      setNotice(`Estado de consentimiento actualizado: ${updated.consent.status}.`);
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.code : 'request_failed');
    } finally {
      setBusyAction(null);
    }
  }

  async function authorizeTransport() {
    if (!supportSession || busyAction || supportSession.consent.status !== 'accepted') return;
    setBusyAction('authorize');
    setError('');
    setNotice('');
    try {
      const response = await api.post<{ authorized: boolean; transport_started: boolean; session: SupportSessionView }>(
        `/v1/company/support/sessions/${encodeURIComponent(supportSession.id)}/transport-authorization`,
        {},
      );
      setAuthorizationResult(response);
      setSupportSession(response.session);
      setAuthorized(response.authorized === true);
      setNotice(response.authorized ? 'Autorización verificada; el motor de transporte aún no se inicia.' : 'La autorización no está disponible.');
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.code : 'request_failed');
    } finally {
      setBusyAction(null);
    }
  }

  async function openSupport() {
    if (!supportSession || !authorized || busyAction) return;
    setBusyAction('open');
    setError('');
    setNotice('');
    try {
      const response = await api.post<{ status: string; session: SupportSessionView }>(
        `/v1/company/support/sessions/${encodeURIComponent(supportSession.id)}/open`,
        {},
      );
      setOpenResult(response);
      setSupportSession(response.session);
      setNotice(`Respuesta del servicio: ${response.status}.`);
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.code : 'request_failed');
    } finally {
      setBusyAction(null);
    }
  }

  async function revokeSupport() {
    if (!supportSession || busyAction || !confirmPending) return;
    setBusyAction('revoke');
    setError('');
    setNotice('');
    try {
      await api.del<void>(`/v1/company/support/sessions/${encodeURIComponent(supportSession.id)}`);
      setSupportSession(null);
      setAuthorized(false);
      setAuthorizationResult(null);
      setOpenResult(null);
      setConfirmPending(false);
      setNotice('Sesión de soporte revocada.');
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.code : 'request_failed');
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <section aria-labelledby="page-title">
      <h1 id="page-title">Soporte</h1>

      <Card heading="Sesiones de soporte">
        {!currentSessionIsActive && <p>Sin sesiones de soporte activas.</p>}
        {currentSessionIsActive && supportSession && (
          <>
            <p>Solicitud local de esta sesión del portal: {supportSession.id}</p>
            <p>Dispositivo: {approvedEndpoints.find((agent) => agent.id === supportSession.device_id)?.name ?? supportSession.device_id}</p>
            <p>Estado: {supportSession.status}</p>
            <p>Consentimiento: {supportSession.consent.status} (vence {supportSession.consent_expires_at})</p>
            <p>Capacidades: {supportSession.capabilities.join(', ')}</p>
            <Button type="button" variant="secondary" disabled={busyAction !== null} onClick={() => void refreshConsent()}>
              {busyAction === 'refresh' ? 'Actualizando…' : 'Actualizar consentimiento'}
            </Button>
            <pre className="nx-pre">{JSON.stringify(supportSession, null, 2)}</pre>
          </>
        )}
      </Card>

      <Card heading="Solicitar sesión de soporte remoto">
        {!canStart && <p>Sin permiso para iniciar sesiones de soporte.</p>}
        {canStart && (
          <>
            {statusMessage(agents, 'Cargando endpoints aprobados…')}
            {agents.status === 'ready' && (
              <form className="nx-grid" onSubmit={requestSupport}>
                <label className="nx-field">
                  <span>Dispositivo</span>
                  <select className="nx-select" name="device_id" required defaultValue="">
                    <option value="" disabled>Selecciona un endpoint aprobado</option>
                    {approvedEndpoints.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
                  </select>
                </label>
                <label className="nx-field">
                  <span>Modo</span>
                  <input className="nx-input" value="assisted" readOnly />
                </label>
                <fieldset className="nx-field">
                  <legend>Capacidades solicitadas</legend>
                  {SUPPORT_CAPABILITIES.map((capability) => (
                    <label className="nx-field" key={capability}>
                      <span>
                        <input
                          type="checkbox"
                          value={capability}
                          checked={selectedCapabilities.includes(capability)}
                          onChange={(event) => toggleCapability(capability, event.target.checked)}
                        />{' '}
                        {capability === 'file_transfer' ? 'Transferencia de archivos' : capability === 'screen_view' ? 'Vista de pantalla' : 'Terminal'}
                      </span>
                    </label>
                  ))}
                </fieldset>
                <Input label="Tiempo de consentimiento (segundos, máximo actual 120)" name="consent_timeout_seconds" type="number" min={60} max={120} step={1} defaultValue={60} required />
                <p className="nx-muted">El API actual admite hasta 120 segundos de consentimiento.</p>
                <Button type="submit" disabled={busyAction !== null || !canCreateSession || approvedEndpoints.length === 0 || selectedCapabilities.length === 0}>
                  {busyAction === 'create' ? 'Solicitando…' : currentSessionIsActive ? 'Ya hay una solicitud activa' : 'Crear solicitud'}
                </Button>
                {approvedEndpoints.length === 0 && <p className="nx-muted">No hay endpoints aprobados disponibles.</p>}
              </form>
            )}
          </>
        )}
      </Card>

      {canStart && currentSessionIsActive && supportSession && (
        <Card heading="Consentimiento y autorización">
          <p>Paso 2: la autorización de transporte está habilitada sólo después de recibir consentimiento del dispositivo.</p>
          <Button
            type="button"
            disabled={busyAction !== null || supportSession.consent.status !== 'accepted' || authorized}
            onClick={() => void authorizeTransport()}
          >
            {busyAction === 'authorize' ? 'Verificando…' : authorized ? 'Transporte autorizado' : 'Autorizar transporte'}
          </Button>
          {supportSession.consent.status !== 'accepted' && <p className="nx-muted">Consentimiento aún no aceptado; actualiza el estado después de la decisión en el dispositivo.</p>}
          {authorizationResult !== null && <pre className="nx-pre">{JSON.stringify(authorizationResult, null, 2)}</pre>}
        </Card>
      )}

      {canStart && currentSessionIsActive && supportSession && (
        <Card heading="Abrir sesión">
          <p>Paso 3: abrir solicita el inicio de la sesión después de verificar la autorización.</p>
          <Button type="button" disabled={busyAction !== null || !authorized} onClick={() => void openSupport()}>
            {busyAction === 'open' ? 'Abriendo…' : 'Abrir sesión'}
          </Button>
          {openResult !== null && <pre className="nx-pre">{JSON.stringify(openResult, null, 2)}</pre>}
        </Card>
      )}

      {canStart && currentSessionIsActive && supportSession && (
        <Card heading="Revocar sesión activa">
          {!confirmPending && (
            <Button type="button" variant="secondary" onClick={() => setConfirmPending(true)}>
              Revisar: se revocará la sesión de soporte {supportSession.id}.
            </Button>
          )}
          {confirmPending && (
            <>
              <p role="alert">Confirmación requerida: revocar esta sesión de soporte remoto.</p>
              <Button type="button" variant="secondary" onClick={() => setConfirmPending(false)}>Cancelar revocación</Button>
              <Button type="button" variant="danger" disabled={busyAction !== null} onClick={() => void revokeSupport()}>
                {busyAction === 'revoke' ? 'Revocando…' : 'Confirmar revocación'}
              </Button>
            </>
          )}
        </Card>
      )}

      <p className="nx-alert">El motor de transporte real de soporte aún no está integrado (Fase E — C9 pendiente). Esta UI demuestra el flujo de consentimiento y autorización; la sesión remota real requiere la integración del motor.</p>
      <p className="nx-status" role="status" aria-live="polite">{error || notice}</p>
    </section>
  );
}
