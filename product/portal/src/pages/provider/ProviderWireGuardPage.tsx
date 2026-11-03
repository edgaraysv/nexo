import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, useApi } from '../../api';
import { useAuth } from '../../auth/AuthContext';
import { Button, Card, Input, Table } from '../../components';

interface Company {
  id: string;
  name: string;
  status: string;
}

interface NodeView {
  id: string;
  name: string;
  status: string;
  proofVerified: boolean;
}

interface VpnEnvironment {
  id: string;
  tenantId: string;
  tenantName?: string;
  nodeId: string;
  name: string;
  engine: 'openvpn' | 'wireguard';
  protocol: string;
  listenerPort: number;
  tunnelIpv4Cidr: string;
  desiredState: string;
  observedState: string;
  revision: number;
  wireguardServerPublicKey?: string;
}

interface WireGuardPeerPreview {
  id: string;
  environmentId: string;
  peerId: string;
  action: 'approve' | 'rotate' | 'revoke';
  expectedRevision: number;
  digest: string;
  expiresAt: string;
  summary: {
    allowedIps: string[];
    persistentKeepaliveSeconds: number;
    newKeyFingerprint?: string;
    oldKeyFingerprint?: string;
  };
}

interface WireGuardPeerView {
  id: string;
  deviceId: string;
  state: string;
  tunnelIpv4: string;
  revision: number;
  publicKeyFingerprint?: string;
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

function statusMessage(state: LoadState) {
  if (state.status === 'loading') return <p className="nx-muted">Cargando…</p>;
  if (state.status === 'forbidden') return <p>Sin permiso.</p>;
  if (state.status === 'error') return <p role="status">{state.code}</p>;
  return null;
}

export default function ProviderWireGuardPage() {
  const api = useApi();
  const { session } = useAuth();
  const isOwner = session?.role === 'owner';
  const [companies, setCompanies] = useState<Company[]>([]);
  const [nodes, setNodes] = useState<NodeView[]>([]);
  const [environments, setEnvironments] = useState<VpnEnvironment[]>([]);
  const [companiesState, setCompaniesState] = useState<LoadState>({ status: 'loading' });
  const [nodesState, setNodesState] = useState<LoadState>(isOwner ? { status: 'loading' } : { status: 'forbidden' });
  const [environmentsState, setEnvironmentsState] = useState<LoadState>({ status: 'loading' });
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [environmentId, setEnvironmentId] = useState('');
  const [preview, setPreview] = useState<WireGuardPeerPreview | null>(null);
  const [peerResult, setPeerResult] = useState<WireGuardPeerView | null>(null);
  const [confirmPending, setConfirmPending] = useState(false);
  const peerFormRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    let current = true;
    const nodesRequest = isOwner ? api.get<ItemsResponse<NodeView>>('/v1/provider/nodes') : Promise.resolve(undefined);
    void Promise.allSettled([
      api.get<ItemsResponse<Company>>('/v1/provider/companies'),
      nodesRequest,
      api.get<ItemsResponse<VpnEnvironment>>('/v1/provider/vpn-environments'),
    ]).then(([companiesResult, nodesResult, environmentsResult]) => {
      if (!current) return;
      if (companiesResult.status === 'fulfilled') {
        setCompanies(companiesResult.value.items);
        setCompaniesState({ status: 'ready' });
      } else {
        setCompaniesState(loadFailure(companiesResult.reason));
      }
      if (nodesResult.status === 'fulfilled') {
        if (nodesResult.value) {
          setNodes(nodesResult.value.items);
          setNodesState({ status: 'ready' });
        }
      } else {
        setNodesState(loadFailure(nodesResult.reason));
      }
      if (environmentsResult.status === 'fulfilled') {
        const wireguard = environmentsResult.value.items.filter((environment) => environment.engine === 'wireguard');
        setEnvironments(wireguard);
        setEnvironmentId((selected) => wireguard.some((environment) => environment.id === selected)
          ? selected
          : wireguard[0]?.id ?? '');
        setEnvironmentsState({ status: 'ready' });
      } else {
        setEnvironmentsState(loadFailure(environmentsResult.reason));
      }
    });
    return () => { current = false; };
  }, [api, isOwner, refresh]);

  async function createEnvironment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    const values = new FormData(form);
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const created = await api.post<VpnEnvironment>('/v1/provider/vpn-environments', {
        tenant_id: String(values.get('tenant_id') ?? ''),
        node_id: String(values.get('node_id') ?? ''),
        name: String(values.get('name') ?? ''),
        engine: 'wireguard',
        protocol: 'udp',
        listener_port: Number(values.get('listener_port')),
        tunnel_ipv4_cidr: String(values.get('tunnel_ipv4_cidr') ?? ''),
      });
      setNotice('Entorno WireGuard creado.');
      form.reset();
      setRefresh((value) => value + 1);
      setEnvironmentId(created.id);
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.code : 'request_failed');
    } finally {
      setBusy(false);
    }
  }

  async function changeEnvironmentState(environment: VpnEnvironment, desiredState: 'active' | 'suspended' | 'retired') {
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await api.put<VpnEnvironment>(`/v1/provider/vpn-environments/${encodeURIComponent(environment.id)}/state`, {
        desired_state: desiredState,
        expected_revision: environment.revision,
      });
      setNotice(`Estado deseado actualizado: ${desiredState}.`);
      setRefresh((value) => value + 1);
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.code : 'request_failed');
    } finally {
      setBusy(false);
    }
  }

  async function createPreview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !environmentId) return;
    const values = new FormData(event.currentTarget);
    const action = String(values.get('action') ?? 'approve');
    setBusy(true);
    setError('');
    setNotice('');
    setPreview(null);
    setPeerResult(null);
    setConfirmPending(false);
    try {
      const created = await api.post<WireGuardPeerPreview>(
        `/v1/provider/vpn-environments/${encodeURIComponent(environmentId)}/wireguard/previews`,
        {
          action,
          device_id: String(values.get('device_id') ?? ''),
          expected_revision: Number(values.get('expected_revision')),
        },
      );
      setPreview(created);
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.code : 'request_failed');
    } finally {
      setBusy(false);
    }
  }

  async function confirmPreview() {
    if (busy || !preview) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await api.post<WireGuardPeerView>(`/v1/provider/wireguard-previews/${encodeURIComponent(preview.id)}/confirm`, {
        digest: preview.digest,
      });
      setPeerResult(result);
      setPreview(null);
      setEnvironmentId('');
      peerFormRef.current?.reset();
      setConfirmPending(false);
      setNotice('Cambio WireGuard confirmado.');
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.code : 'request_failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="page-title">
      <h1 id="page-title">WireGuard</h1>

      <Card heading="Entornos WireGuard">
        {statusMessage(environmentsState)}
        {environmentsState.status === 'ready' && (
          <Table
            headers={['Nombre', 'Empresa', 'Estado deseado', 'Estado observado', 'Clave pública servidor', 'Revisión', ...(isOwner ? ['Acciones'] : [])]}
            rows={environments}
            renderRow={(environment) => [
              environment.name,
              environment.tenantName ?? companies.find((company) => company.id === environment.tenantId)?.name ?? environment.tenantId,
              environment.desiredState,
              environment.observedState,
              environment.wireguardServerPublicKey || '—',
              environment.revision,
              ...(isOwner ? [
                <div className="nx-row">
                  <Button key="active" type="button" size="sm" disabled={busy || environment.desiredState === 'retired'} onClick={() => void changeEnvironmentState(environment, 'active')}>
                    Activar/reiniciar
                  </Button>
                  <Button key="suspended" type="button" size="sm" variant="secondary" disabled={busy || environment.desiredState === 'retired'} onClick={() => void changeEnvironmentState(environment, 'suspended')}>
                    Suspender
                  </Button>
                  <Button key="retired" type="button" size="sm" variant="danger" disabled={busy || environment.desiredState === 'retired'} onClick={() => void changeEnvironmentState(environment, 'retired')}>
                    Retirar
                  </Button>
                </div>,
              ] : []),
            ]}
            empty="No hay entornos WireGuard."
          />
        )}
      </Card>

      {isOwner && (
        <Card heading="Crear entorno WireGuard">
          {companiesState.status === 'loading' && <p className="nx-muted">Cargando empresas…</p>}
          {companiesState.status === 'forbidden' && <p>Sin permiso.</p>}
          {companiesState.status === 'error' && <p role="status">{companiesState.code}</p>}
          {nodesState.status === 'loading' && <p className="nx-muted">Cargando nodos…</p>}
          {nodesState.status === 'forbidden' && <p>Sin permiso.</p>}
          {nodesState.status === 'error' && <p role="status">{nodesState.code}</p>}
          {companiesState.status === 'ready' && nodesState.status === 'ready' && (
            <form className="nx-grid" onSubmit={createEnvironment}>
              <label className="nx-field">
                <span>Empresa</span>
                <select className="nx-select" name="tenant_id" required defaultValue="">
                  <option value="" disabled>Selecciona una empresa</option>
                  {companies.map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}
                </select>
              </label>
              <label className="nx-field">
                <span>Nodo aprobado</span>
                <select className="nx-select" name="node_id" required defaultValue="">
                  <option value="" disabled>Selecciona un nodo</option>
                  {nodes.filter((node) => node.status === 'approved').map((node) => <option key={node.id} value={node.id}>{node.name}</option>)}
                </select>
              </label>
              <Input label="Nombre" name="name" required maxLength={120} />
              <label className="nx-field"><span>Motor</span><input className="nx-input" value="wireguard" readOnly /></label>
              <label className="nx-field"><span>Protocolo</span><input className="nx-input" value="udp" readOnly /></label>
              <Input label="Puerto" name="listener_port" type="number" min={1024} max={65535} step={1} required />
              <Input label="Pool VPN IPv4" name="tunnel_ipv4_cidr" placeholder="10.90.0.0/24" required maxLength={43} />
              <Button type="submit" disabled={busy || companies.length === 0 || !nodes.some((node) => node.status === 'approved')}>
                {busy ? 'Creando…' : 'Crear entorno'}
              </Button>
            </form>
          )}
          {nodesState.status === 'ready' && !nodes.some((node) => node.status === 'approved') && <p className="nx-muted">Se requiere un nodo aprobado para crear un entorno.</p>}
        </Card>
      )}

      <Card heading="Gestionar peer">
        {!isOwner && <p>Sin permiso.</p>}
        {isOwner && (
          <>
            <form className="nx-grid" ref={peerFormRef} onSubmit={createPreview}>
              <label className="nx-field">
                <span>Entorno WireGuard</span>
                <select className="nx-select" value={environmentId} onChange={(event) => {
                  setEnvironmentId(event.target.value);
                  setPreview(null);
                  setConfirmPending(false);
                }} required>
                  <option value="" disabled>Selecciona un entorno</option>
                  {environments.map((environment) => <option key={environment.id} value={environment.id}>{environment.name}</option>)}
                </select>
              </label>
              <Input label="Device ID (UUID)" name="device_id" required pattern="^[0-9a-f-]{36}$" minLength={36} maxLength={36} />
              <label className="nx-field">
                <span>Acción</span>
                <select className="nx-select" name="action" defaultValue="approve" onChange={() => { setPreview(null); setConfirmPending(false); }}>
                  <option value="approve">approve</option>
                  <option value="rotate">rotate</option>
                  <option value="revoke">revoke</option>
                </select>
              </label>
              <Input label="Revisión esperada" name="expected_revision" type="number" min={1} step={1} required />
              <Button type="submit" disabled={busy || environmentsState.status !== 'ready' || environments.length === 0}>
                {busy ? 'Generando preview…' : 'Crear preview'}
              </Button>
            </form>
            {environmentsState.status === 'loading' && <p className="nx-muted">Cargando entornos…</p>}
            {environmentsState.status === 'forbidden' && <p>Sin permiso.</p>}
            {environmentsState.status === 'error' && <p role="status">{environmentsState.code}</p>}
          </>
        )}

        {preview && (
          <Card heading="Resumen del preview">
            <p>Acción: {preview.action}</p>
            <p>Entorno: {environments.find((environment) => environment.id === preview.environmentId)?.name ?? preview.environmentId}</p>
            <p>Peer: {preview.peerId}</p>
            <p>Revisión esperada: {preview.expectedRevision}</p>
            <p>Vence: {preview.expiresAt}</p>
            <p>IPs permitidas: {preview.summary.allowedIps.join(', ') || '—'}</p>
            <p>Keepalive persistente: {preview.summary.persistentKeepaliveSeconds} segundos</p>
            <p>Fingerprint de clave nueva: {preview.summary.newKeyFingerprint ?? '—'}</p>
            <p>Fingerprint de clave anterior: {preview.summary.oldKeyFingerprint ?? '—'}</p>
            {preview.action === 'revoke' && !confirmPending && (
              <Button type="button" variant="secondary" onClick={() => setConfirmPending(true)}>
                Revisar: se revocará el peer {preview.peerId}; el dispositivo perderá acceso a este entorno.
              </Button>
            )}
            {preview.action === 'revoke' && confirmPending && (
              <>
                <p role="alert">Confirmación requerida: revocar el peer {preview.peerId} es una acción destructiva.</p>
                <Button type="button" variant="secondary" onClick={() => setConfirmPending(false)}>Cancelar confirmación de revocación</Button>
                <Button type="button" variant="danger" disabled={busy} onClick={() => void confirmPreview()}>
                  {busy ? 'Confirmando…' : 'Confirmar revocación WireGuard'}
                </Button>
              </>
            )}
            {preview.action !== 'revoke' && (
              <Button type="button" disabled={busy} onClick={() => void confirmPreview()}>
                {busy ? 'Confirmando…' : 'Confirmar preview WireGuard'}
              </Button>
            )}
          </Card>
        )}

        {peerResult && (
          <Card heading="Peer actualizado">
            <p>ID: {peerResult.id}</p>
            <p>Device ID: {peerResult.deviceId}</p>
            <p>Estado: {peerResult.state}</p>
            <p>IP del túnel: {peerResult.tunnelIpv4}</p>
            <p>Revisión: {peerResult.revision}</p>
            <p>Fingerprint de clave pública: {peerResult.publicKeyFingerprint ?? '—'}</p>
          </Card>
        )}
      </Card>

      <p className="nx-status" role="status" aria-live="polite">{error || notice}</p>
    </section>
  );
}
