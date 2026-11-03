import { useEffect, useState, type FormEvent } from 'react';
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
  name: string;
  engine: 'openvpn' | 'wireguard';
  protocol: string;
  listenerPort: number;
  tunnelIpv4Cidr: string;
  desiredState: string;
  observedState: string;
  revision: number;
}

interface NodeOperation {
  type: string;
  status: string;
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

function statusMessage(state: LoadState) {
  if (state.status === 'loading') return <p className="nx-muted">Cargando…</p>;
  if (state.status === 'forbidden') return <p>Sin permiso.</p>;
  if (state.status === 'error') return <p role="status">{state.code}</p>;
  return null;
}

export default function ProviderInfraPage() {
  const api = useApi();
  const { session } = useAuth();
  const isOwner = session?.role === 'owner';
  const [companies, setCompanies] = useState<Company[]>([]);
  const [nodes, setNodes] = useState<NodeView[]>([]);
  const [environments, setEnvironments] = useState<VpnEnvironment[]>([]);
  const [operations, setOperations] = useState<NodeOperation[]>([]);
  const [companiesState, setCompaniesState] = useState<LoadState>({ status: 'loading' });
  const [nodesState, setNodesState] = useState<LoadState>(isOwner ? { status: 'loading' } : { status: 'forbidden' });
  const [environmentsState, setEnvironmentsState] = useState<LoadState>({ status: 'loading' });
  const [operationsState, setOperationsState] = useState<LoadState>(isOwner ? { status: 'loading' } : { status: 'forbidden' });
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let current = true;
    const nodesRequest = isOwner ? api.get<ItemsResponse<NodeView>>('/v1/provider/nodes') : Promise.resolve(undefined);
    const operationsRequest = isOwner ? api.get<ItemsResponse<NodeOperation>>('/v1/provider/node-operations') : Promise.resolve(undefined);
    void Promise.allSettled([
      api.get<ItemsResponse<Company>>('/v1/provider/companies'),
      nodesRequest,
      api.get<ItemsResponse<VpnEnvironment>>('/v1/provider/vpn-environments'),
      operationsRequest,
    ]).then(([companiesResult, nodesResult, environmentsResult, operationsResult]) => {
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
        setEnvironments(environmentsResult.value.items.filter((environment) => environment.engine !== 'wireguard'));
        setEnvironmentsState({ status: 'ready' });
      } else {
        setEnvironmentsState(loadFailure(environmentsResult.reason));
      }
      if (operationsResult.status === 'fulfilled') {
        if (operationsResult.value) {
          setOperations(operationsResult.value.items);
          setOperationsState({ status: 'ready' });
        }
      } else {
        setOperationsState(loadFailure(operationsResult.reason));
      }
    });
    return () => { current = false; };
  }, [api, isOwner, refresh]);

  async function approveNode(nodeId: string) {
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await api.post<void>(`/v1/provider/nodes/${encodeURIComponent(nodeId)}/approve`, {});
      setNotice('Nodo aprobado.');
      setRefresh((value) => value + 1);
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

  async function createEnvironment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    const values = new FormData(form);
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await api.post<VpnEnvironment>('/v1/provider/vpn-environments', {
        tenant_id: String(values.get('tenant_id') ?? ''),
        node_id: String(values.get('node_id') ?? ''),
        name: String(values.get('name') ?? ''),
        engine: 'openvpn',
        protocol: 'udp',
        listener_port: Number(values.get('listener_port')),
        tunnel_ipv4_cidr: String(values.get('tunnel_ipv4_cidr') ?? ''),
      });
      setNotice('Entorno OpenVPN creado.');
      form.reset();
      setRefresh((value) => value + 1);
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.code : 'request_failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="page-title">
      <h1 id="page-title">Nodos y VPN</h1>

      <Card heading="Nodos">
        {statusMessage(nodesState)}
        {isOwner && nodesState.status === 'ready' && (
          <Table
            headers={['Nombre', 'Estado', 'Prueba', 'Acción']}
            rows={nodes}
            renderRow={(node) => [
              node.name,
              node.status,
              node.proofVerified ? 'Verificada' : 'Pendiente',
              node.status !== 'approved'
                ? <Button type="button" disabled={busy} onClick={() => void approveNode(node.id)}>Aprobar</Button>
                : '—',
            ]}
            empty="No hay nodos registrados."
          />
        )}
      </Card>

      <Card heading="Entornos OpenVPN">
        {statusMessage(environmentsState)}
        {environmentsState.status === 'ready' && (
          <Table
            headers={['Nombre', 'Empresa', 'Estado deseado', 'Estado observado', 'Revisión', ...(isOwner ? ['Acciones'] : [])]}
            rows={environments}
            renderRow={(environment) => [
              environment.name,
              environment.tenantName ?? companies.find((company) => company.id === environment.tenantId)?.name ?? environment.tenantId,
              environment.desiredState,
              environment.observedState,
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
            empty="No hay entornos OpenVPN."
          />
        )}
      </Card>

      {isOwner && (
        <Card heading="Crear entorno OpenVPN">
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
              <label className="nx-field"><span>Motor</span><input className="nx-input" value="openvpn" readOnly /></label>
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

      <Card heading="Operaciones de nodo">
        {statusMessage(operationsState)}
        {isOwner && operationsState.status === 'ready' && (
          <Table
            headers={['Tipo', 'Estado', 'Revisión']}
            rows={operations}
            renderRow={(operation) => [operation.type, operation.status, operation.revision]}
            empty="No hay operaciones de nodo."
          />
        )}
      </Card>

      <p className="nx-status" role="status" aria-live="polite">{error || notice}</p>
    </section>
  );
}
