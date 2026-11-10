import { useEffect, useState, type FormEvent } from 'react';
import { ApiError, useApi } from '../../api';
import { useAuth } from '../../auth/AuthContext';
import { Button, Card, Input, Table } from '../../components';

interface Site {
  id: string;
  code: string;
  name: string;
  status: string;
  networks: string[];
}

interface ApiAgent {
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

interface NetworkProfile {
  id: string;
  tenantId: string;
  siteId: string;
  vpnEnvironmentId: string;
  name: string;
  siteNetworks: string[];
  pathMode: 'direct' | 'gateway';
  gatewayDeviceId?: string;
  returnMode: 'routed' | 'snat';
  dnsMode: 'local' | 'split';
  dnsServers: string[];
  dnsSuffixes: string[];
  desiredState: string;
  observedState: string;
  revision: number;
  appliedRevision?: number;
}

interface PrivateResource {
  id: string;
  profileId: string;
  name: string;
  kind: 'ipv4' | 'hostname';
  address: string;
  status: string;
  revision: number;
}

interface NetworkPolicy {
  id: string;
  profileId: string;
  name: string;
  effect: 'allow' | 'deny';
  sourceKind: 'any_endpoint' | 'device';
  sourceDeviceId?: string;
  resourceId: string;
  protocol: 'tcp' | 'udp' | 'icmp';
  portStart?: number;
  portEnd?: number;
  icmpType?: number;
  icmpCode?: number;
  status: 'draft' | 'active' | 'retired';
  revision: number;
}

interface NetworkDiagnostic {
  decision: 'deny' | 'allow';
  reason: 'default_deny' | 'explicit_deny' | 'configuration_pending' | 'policy_allows';
  connectivity: 'not_tested';
  profileRevision: number;
  appliedRevision?: number;
  pathMode: 'direct' | 'gateway';
  returnMode: 'routed' | 'snat';
  dnsMode: 'local' | 'split';
}

interface ItemsResponse<T> {
  items: T[];
}

type LoadState<T> =
  | { status: 'loading' }
  | { status: 'ready'; data: T }
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

function splitCsv(value: string): string[] {
  return value.split(',').map((entry) => entry.trim()).filter(Boolean);
}

function normalizeAgents(items: ApiAgent[]): Agent[] {
  return items.map((agent) => ({
    id: agent.id,
    name: agent.name,
    status: agent.status,
    deviceKind: agent.deviceKind ?? agent.device_kind,
  }));
}

export default function CompanyNetworksPage() {
  const api = useApi();
  const { session } = useAuth();
  const permissions = session?.permissions ?? [];
  const canManageNetwork = permissions.includes('company.network.manage');
  const canDiagnoseNetwork = permissions.includes('company.network.diagnose');
  const [profiles, setProfiles] = useState<LoadState<NetworkProfile[]>>({ status: 'loading' });
  const [resources, setResources] = useState<LoadState<PrivateResource[]>>({ status: 'loading' });
  const [policies, setPolicies] = useState<LoadState<NetworkPolicy[]>>({ status: 'loading' });
  const [sites, setSites] = useState<LoadState<Site[]>>({ status: 'loading' });
  const [agents, setAgents] = useState<LoadState<Agent[]>>({ status: 'loading' });
  const [selectedSiteId, setSelectedSiteId] = useState('');
  const [pathMode, setPathMode] = useState<'direct' | 'gateway'>('direct');
  const [gatewayDeviceId, setGatewayDeviceId] = useState('');
  const [returnMode, setReturnMode] = useState<'routed' | 'snat'>('routed');
  const [dnsMode, setDnsMode] = useState<'local' | 'split'>('local');
  const [dnsServersText, setDnsServersText] = useState('');
  const [dnsSuffixesText, setDnsSuffixesText] = useState('');
  const [policySourceKind, setPolicySourceKind] = useState<'any_endpoint' | 'device'>('any_endpoint');
  const [policyProtocol, setPolicyProtocol] = useState<'tcp' | 'udp' | 'icmp'>('tcp');
  const [diagnosticProtocol, setDiagnosticProtocol] = useState<'tcp' | 'udp' | 'icmp'>('tcp');
  const [policyProfileId, setPolicyProfileId] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [diagnosticResult, setDiagnosticResult] = useState<NetworkDiagnostic | null>(null);

  useEffect(() => {
    let current = true;
    void Promise.allSettled([
      api.get<ItemsResponse<NetworkProfile>>('/v1/company/network-profiles'),
      api.get<ItemsResponse<PrivateResource>>('/v1/company/private-resources'),
      api.get<ItemsResponse<NetworkPolicy>>('/v1/company/network-policies'),
      api.get<ItemsResponse<Site>>('/v1/company/sites'),
      api.get<ItemsResponse<ApiAgent>>('/v1/company/agents'),
    ]).then(([profilesResult, resourcesResult, policiesResult, sitesResult, agentsResult]) => {
      if (!current) return;
      if (profilesResult.status === 'fulfilled') {
        setProfiles({ status: 'ready', data: profilesResult.value.items });
        setPolicyProfileId((selected) => profilesResult.value.items.some((profile) => profile.id === selected)
          ? selected
          : profilesResult.value.items[0]?.id ?? '');
      } else setProfiles(failed(profilesResult.reason));
      if (resourcesResult.status === 'fulfilled') setResources({ status: 'ready', data: resourcesResult.value.items });
      else setResources(failed(resourcesResult.reason));
      if (policiesResult.status === 'fulfilled') setPolicies({ status: 'ready', data: policiesResult.value.items });
      else setPolicies(failed(policiesResult.reason));
      if (sitesResult.status === 'fulfilled') {
        setSites({ status: 'ready', data: sitesResult.value.items });
        setSelectedSiteId((selected) => sitesResult.value.items.some((site) => site.id === selected)
          ? selected
          : sitesResult.value.items[0]?.id ?? '');
      } else setSites(failed(sitesResult.reason));
      if (agentsResult.status === 'fulfilled') setAgents({ status: 'ready', data: normalizeAgents(agentsResult.value.items) });
      else setAgents(failed(agentsResult.reason));
    });
    return () => { current = false; };
  }, [api, refresh]);

  const profileItems = profiles.status === 'ready' ? profiles.data : [];
  const resourceItems = resources.status === 'ready' ? resources.data : [];
  const siteItems = sites.status === 'ready' ? sites.data : [];
  const agentItems = agents.status === 'ready' ? agents.data : [];
  const approvedGateways = agentItems.filter((agent) => agent.deviceKind === 'gateway' && agent.status === 'approved');
  const approvedEndpoints = agentItems.filter((agent) => agent.deviceKind === 'endpoint' && agent.status === 'approved');
  const selectedSite = siteItems.find((site) => site.id === selectedSiteId);
  const selectedProfile = profileItems.find((profile) => profile.id === policyProfileId);
  const policyResources = resourceItems.filter((resource) => !selectedProfile || resource.profileId === selectedProfile.id);
  const profileNames = new Map(profileItems.map((profile) => [profile.id, profile.name]));
  const endpointNames = new Map(agentItems.map((agent) => [agent.id, agent.name]));
  const resourceNames = new Map(resourceItems.map((resource) => [resource.id, resource.name]));

  async function createProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    const values = new FormData(form);
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await api.post<NetworkProfile>('/v1/company/network-profiles', {
        site_id: selectedSiteId,
        vpn_environment_id: String(values.get('vpn_environment_id') ?? '').trim(),
        name: String(values.get('name') ?? '').trim(),
        path_mode: pathMode,
        ...(pathMode === 'gateway' ? { gateway_device_id: gatewayDeviceId } : {}),
        return_mode: pathMode === 'direct' ? 'routed' : returnMode,
        dns_mode: dnsMode,
        dns_servers: dnsMode === 'split' ? splitCsv(dnsServersText) : [],
        dns_suffixes: dnsMode === 'split' ? splitCsv(dnsSuffixesText) : [],
        // The API derives site_networks from site_id and rejects a site_networks request field.
      });
      setNotice('Perfil creado; la aplicación y conectividad aún no están demostradas.');
      form.reset();
      setPathMode('direct');
      setGatewayDeviceId('');
      setReturnMode('routed');
      setDnsMode('local');
      setDnsServersText('');
      setDnsSuffixesText('');
      setRefresh((value) => value + 1);
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.code : 'request_failed');
    } finally {
      setBusy(false);
    }
  }

  async function createResource(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    const values = new FormData(form);
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await api.post<PrivateResource>('/v1/company/private-resources', {
        profile_id: String(values.get('profile_id') ?? ''),
        name: String(values.get('name') ?? '').trim(),
        kind: String(values.get('kind') ?? 'ipv4'),
        address: String(values.get('address') ?? '').trim(),
      });
      setNotice('Recurso privado creado.');
      form.reset();
      setRefresh((value) => value + 1);
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.code : 'request_failed');
    } finally {
      setBusy(false);
    }
  }

  async function createPolicy(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    const values = new FormData(form);
    const sourceDeviceId = policySourceKind === 'device' ? String(values.get('source_device_id') ?? '') : '';
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await api.post<NetworkPolicy>('/v1/company/network-policies', {
        profile_id: String(values.get('profile_id') ?? ''),
        name: String(values.get('name') ?? '').trim(),
        effect: String(values.get('effect') ?? 'deny'),
        source_kind: policySourceKind,
        ...(sourceDeviceId ? { source_device_id: sourceDeviceId } : {}),
        resource_id: String(values.get('resource_id') ?? ''),
        protocol: policyProtocol,
        ...(policyProtocol === 'icmp'
          ? { icmp_type: 8, icmp_code: 0 }
          : { port_start: Number(values.get('port_start')), port_end: Number(values.get('port_end')) }),
        status: String(values.get('status') ?? 'draft'),
      });
      setNotice('Política de red creada.');
      form.reset();
      setPolicySourceKind('any_endpoint');
      setPolicyProtocol('tcp');
      setRefresh((value) => value + 1);
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.code : 'request_failed');
    } finally {
      setBusy(false);
    }
  }

  async function runDiagnostic(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const values = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    setNotice('');
    setDiagnosticResult(null);
    try {
      const result = await api.post<NetworkDiagnostic>('/v1/company/network-diagnostics', {
        source_device_id: String(values.get('source_device_id') ?? ''),
        resource_id: String(values.get('resource_id') ?? ''),
        protocol: diagnosticProtocol,
        ...(diagnosticProtocol === 'icmp' ? {} : { port: Number(values.get('port')) }),
      });
      setDiagnosticResult(result);
      setNotice('Evaluación de política completada; la conectividad real no fue probada.');
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.code : 'request_failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="page-title">
      <h1 id="page-title">Redes y políticas</h1>
      <p className="nx-alert">Una VPN conectada no demuestra acceso al recurso. La conectividad requiere un diagnóstico independiente.</p>

      <Card heading="Perfiles de red">
        {statusMessage(profiles)}
        {profiles.status === 'ready' && (
          <Table
            headers={['Nombre', 'Sede', 'Trayecto', 'Retorno', 'DNS', 'Revisión', 'Aplicado', 'Observado']}
            rows={profiles.data}
            renderRow={(profile) => [
              profile.name,
              siteItems.find((site) => site.id === profile.siteId)?.name ?? profile.siteId,
              profile.pathMode,
              profile.returnMode,
              `${profile.dnsMode}${profile.dnsServers.length ? ` · ${profile.dnsServers.join(', ')}` : ''}`,
              profile.revision,
              profile.appliedRevision ?? 'Pendiente',
              profile.observedState,
            ]}
            empty="No hay perfiles de red."
          />
        )}
      </Card>

      {canManageNetwork && (
        <Card heading="Crear perfil de red">
          {statusMessage(sites, 'Cargando sedes…')}
          {sites.status === 'ready' && (
            <form className="nx-grid" onSubmit={createProfile}>
              <label className="nx-field">
                <span>Sede</span>
                <select className="nx-select" value={selectedSiteId} onChange={(event) => setSelectedSiteId(event.target.value)} required>
                  <option value="" disabled>Selecciona una sede</option>
                  {siteItems.map((site) => <option key={site.id} value={site.id}>{site.name}</option>)}
                </select>
              </label>
              <Input label="ID del entorno VPN" name="vpn_environment_id" required maxLength={64} />
              <Input label="Nombre" name="name" required maxLength={120} />
              <label className="nx-field">
                <span>Trayecto</span>
                <select className="nx-select" value={pathMode} onChange={(event) => {
                  const next = event.target.value === 'gateway' ? 'gateway' : 'direct';
                  setPathMode(next);
                  if (next === 'direct') {
                    setGatewayDeviceId('');
                    setReturnMode('routed');
                  }
                }}>
                  <option value="direct">Endpoint directo</option>
                  <option value="gateway">Gateway</option>
                </select>
              </label>
              {pathMode === 'gateway' && (
                <label className="nx-field">
                  <span>Gateway aprobado</span>
                  <select className="nx-select" value={gatewayDeviceId} onChange={(event) => setGatewayDeviceId(event.target.value)} required>
                    <option value="" disabled>Selecciona un gateway</option>
                    {approvedGateways.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
                  </select>
                </label>
              )}
              <label className="nx-field">
                <span>Modo de retorno</span>
                <select className="nx-select" value={pathMode === 'direct' ? 'routed' : returnMode} disabled={pathMode === 'direct'} onChange={(event) => setReturnMode(event.target.value === 'snat' ? 'snat' : 'routed')}>
                  <option value="routed">routed</option>
                  <option value="snat">snat</option>
                </select>
              </label>
              <label className="nx-field">
                <span>DNS</span>
                <select className="nx-select" value={dnsMode} onChange={(event) => {
                  const next = event.target.value === 'split' ? 'split' : 'local';
                  setDnsMode(next);
                  if (next === 'local') {
                    setDnsServersText('');
                    setDnsSuffixesText('');
                  }
                }}>
                  <option value="local">local</option>
                  <option value="split">split</option>
                </select>
              </label>
              <Input label="DNS servers (coma-separado)" value={dnsServersText} onChange={(event) => setDnsServersText(event.target.value)} disabled={dnsMode === 'local'} required={dnsMode === 'split'} placeholder="10.20.0.53" />
              <Input label="DNS suffixes (coma-separado)" value={dnsSuffixesText} onChange={(event) => setDnsSuffixesText(event.target.value)} disabled={dnsMode === 'local'} required={dnsMode === 'split'} placeholder="corp.example" />
              <Input label="Redes de sede (derivadas de la sede seleccionada)" value={selectedSite?.networks.join(', ') ?? ''} readOnly />
              {pathMode === 'gateway' && agents.status !== 'ready' && statusMessage(agents, 'Cargando gateways aprobados…')}
              {pathMode === 'gateway' && agents.status === 'ready' && approvedGateways.length === 0 && <p className="nx-muted">No hay gateways aprobados disponibles.</p>}
              <Button type="submit" disabled={busy || !selectedSiteId || !selectedSite?.networks.length || (pathMode === 'gateway' && !gatewayDeviceId)}>
                {busy ? 'Creando…' : 'Crear perfil'}
              </Button>
            </form>
          )}
        </Card>
      )}

      <Card heading="Recursos privados">
        {statusMessage(resources)}
        {resources.status === 'ready' && (
          <Table
            headers={['Nombre', 'Perfil', 'Tipo', 'Destino', 'Estado', 'Revisión']}
            rows={resources.data}
            renderRow={(resource) => [resource.name, profileNames.get(resource.profileId) ?? resource.profileId, resource.kind, resource.address, resource.status, resource.revision]}
            empty="No hay recursos privados."
          />
        )}
        {canManageNetwork && profiles.status === 'loading' && <p className="nx-muted">Cargando perfiles para el formulario…</p>}
        {canManageNetwork && profiles.status === 'forbidden' && <p>Sin permiso para crear recursos sin perfiles disponibles.</p>}
        {canManageNetwork && profiles.status === 'error' && <p role="status">{profiles.code}</p>}
        {canManageNetwork && profiles.status === 'ready' && (
          <form className="nx-row" onSubmit={createResource}>
            <label className="nx-field">
              <span>Perfil</span>
              <select className="nx-select" name="profile_id" required defaultValue="">
                <option value="" disabled>Selecciona un perfil</option>
                {profileItems.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
              </select>
            </label>
            <Input label="Nombre" name="name" required maxLength={120} />
            <label className="nx-field">
              <span>Tipo</span>
              <select className="nx-select" name="kind" defaultValue="ipv4">
                <option value="ipv4">IPv4</option>
                <option value="hostname">Hostname</option>
              </select>
            </label>
            <Input label="Dirección" name="address" required maxLength={253} placeholder="10.20.0.10" />
            <Button type="submit" disabled={busy || profileItems.length === 0}>{busy ? 'Creando…' : 'Crear recurso'}</Button>
          </form>
        )}
      </Card>

      <Card heading="Políticas de red">
        {statusMessage(policies)}
        {policies.status === 'ready' && (
          <Table
            headers={['Nombre', 'Efecto', 'Origen', 'Recurso', 'Protocolo', 'Puerto o tipo', 'Estado']}
            rows={policies.data}
            renderRow={(policy) => [
              policy.name,
              policy.effect,
              policy.sourceKind === 'any_endpoint' ? 'Cualquier endpoint' : endpointNames.get(policy.sourceDeviceId ?? '') ?? policy.sourceDeviceId ?? 'Endpoint',
              resourceNames.get(policy.resourceId) ?? policy.resourceId,
              policy.protocol,
              policy.protocol === 'icmp' ? 'Echo request · tipo 8/código 0' : `${policy.portStart}–${policy.portEnd}`,
              policy.status,
            ]}
            empty="No hay políticas de red."
          />
        )}
        {canManageNetwork && profiles.status === 'loading' && <p className="nx-muted">Cargando perfiles…</p>}
        {canManageNetwork && profiles.status === 'forbidden' && <p>Sin permiso.</p>}
        {canManageNetwork && profiles.status === 'error' && <p role="status">{profiles.code}</p>}
        {canManageNetwork && resources.status === 'loading' && <p className="nx-muted">Cargando recursos…</p>}
        {canManageNetwork && resources.status === 'forbidden' && <p>Sin permiso.</p>}
        {canManageNetwork && resources.status === 'error' && <p role="status">{resources.code}</p>}
        {canManageNetwork && profiles.status === 'ready' && resources.status === 'ready' && (
          <form className="nx-grid" onSubmit={createPolicy}>
            <label className="nx-field">
              <span>Perfil</span>
              <select className="nx-select" name="profile_id" value={policyProfileId} onChange={(event) => setPolicyProfileId(event.target.value)} required>
                <option value="" disabled>Selecciona un perfil</option>
                {profileItems.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
              </select>
            </label>
            <Input label="Nombre" name="name" required maxLength={120} />
            <label className="nx-field">
              <span>Efecto</span>
              <select className="nx-select" name="effect" defaultValue="deny">
                <option value="allow">allow</option>
                <option value="deny">deny</option>
              </select>
            </label>
            <label className="nx-field">
              <span>Origen</span>
              <select className="nx-select" value={policySourceKind} onChange={(event) => setPolicySourceKind(event.target.value === 'device' ? 'device' : 'any_endpoint')}>
                <option value="any_endpoint">Cualquier endpoint</option>
                <option value="device">Endpoint específico</option>
              </select>
            </label>
            {policySourceKind === 'device' && (
              <label className="nx-field">
                <span>Endpoint origen</span>
                <select className="nx-select" name="source_device_id" required defaultValue="">
                  <option value="" disabled>Selecciona un endpoint</option>
                  {approvedEndpoints.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
                </select>
              </label>
            )}
            {policySourceKind === 'device' && agents.status === 'loading' && <p className="nx-muted">Cargando endpoints aprobados…</p>}
            {policySourceKind === 'device' && agents.status === 'forbidden' && <p>Sin permiso para listar endpoints.</p>}
            {policySourceKind === 'device' && agents.status === 'error' && <p role="status">{agents.code}</p>}
            {policySourceKind === 'device' && agents.status === 'ready' && approvedEndpoints.length === 0 && <p className="nx-muted">No hay endpoints aprobados.</p>}
            <label className="nx-field">
              <span>Recurso</span>
              <select className="nx-select" name="resource_id" required defaultValue="">
                <option value="" disabled>Selecciona un recurso</option>
                {policyResources.map((resource) => <option key={resource.id} value={resource.id}>{resource.name} · {resource.address}</option>)}
              </select>
            </label>
            <label className="nx-field">
              <span>Protocolo</span>
                <select className="nx-select" name="protocol" value={policyProtocol} onChange={(event) => setPolicyProtocol(event.target.value as 'tcp' | 'udp' | 'icmp')}>
                  <option value="tcp">tcp</option>
                  <option value="udp">udp</option>
                  <option value="icmp">icmp · solo echo request</option>
                </select>
              </label>
            {policyProtocol === 'icmp' ? (
              <p className="nx-muted">La política ICMP solo permite echo request (tipo 8, código 0); no habilita otros tipos ICMP.</p>
            ) : (
              <>
                <Input label="Puerto inicio" name="port_start" type="number" min={1} max={65535} step={1} required />
                <Input label="Puerto fin" name="port_end" type="number" min={1} max={65535} step={1} required />
              </>
            )}
            <label className="nx-field">
              <span>Estado inicial</span>
              <select className="nx-select" name="status" defaultValue="draft">
                <option value="draft">draft</option>
                <option value="active">active</option>
              </select>
            </label>
            <Button type="submit" disabled={busy || profileItems.length === 0 || policyResources.length === 0 || (policySourceKind === 'device' && approvedEndpoints.length === 0)}>
              {busy ? 'Creando…' : 'Crear política'}
            </Button>
          </form>
        )}
      </Card>

      {canDiagnoseNetwork && (
        <Card heading="Diagnóstico">
          {agents.status !== 'ready' && statusMessage(agents, 'Cargando endpoints aprobados…')}
          {resources.status !== 'ready' && statusMessage(resources, 'Cargando recursos privados…')}
          {agents.status === 'ready' && resources.status === 'ready' && (
            <form className="nx-grid" onSubmit={runDiagnostic}>
              <label className="nx-field">
                <span>Endpoint origen</span>
                <select className="nx-select" name="source_device_id" required defaultValue="">
                  <option value="" disabled>Selecciona un endpoint aprobado</option>
                  {approvedEndpoints.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
                </select>
              </label>
              <label className="nx-field">
                <span>Recurso privado</span>
                <select className="nx-select" name="resource_id" required defaultValue="">
                  <option value="" disabled>Selecciona un recurso</option>
                  {resourceItems.map((resource) => <option key={resource.id} value={resource.id}>{resource.name} · {resource.address}</option>)}
                </select>
              </label>
              <label className="nx-field">
                <span>Protocolo</span>
                <select className="nx-select" name="protocol" value={diagnosticProtocol} onChange={(event) => setDiagnosticProtocol(event.target.value as 'tcp' | 'udp' | 'icmp')}>
                  <option value="tcp">TCP</option>
                  <option value="udp">UDP</option>
                  <option value="icmp">ICMP · echo request</option>
                </select>
              </label>
              {diagnosticProtocol !== 'icmp' && <Input label="Puerto" name="port" type="number" min={1} max={65535} step={1} required />}
              <Button type="submit" disabled={busy || approvedEndpoints.length === 0 || resourceItems.length === 0}>
                {busy ? 'Evaluando…' : 'Evaluar política y configuración'}
              </Button>
              {approvedEndpoints.length === 0 && <p className="nx-muted">No hay endpoints aprobados disponibles.</p>}
              {resourceItems.length === 0 && <p className="nx-muted">No hay recursos privados disponibles.</p>}
            </form>
          )}
          {diagnosticResult && <pre className="nx-pre">{JSON.stringify(diagnosticResult, null, 2)}</pre>}
        </Card>
      )}

      <p className="nx-status" role="status" aria-live="polite">{error || notice}</p>
    </section>
  );
}
