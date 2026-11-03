import { useEffect, useState } from 'react';
import { ApiError, useApi } from '../../api';
import { Card, Table } from '../../components';

interface CompanySummary {
  sites: number;
  devices: number;
  users: number;
  activePolicies: number;
}

interface Site {
  id: string;
  code: string;
  name: string;
  status: string;
  networks: string[];
}

interface DeviceView {
  id: string;
  tenantId?: string;
  siteId?: string;
  name: string;
  platform?: string;
  deviceKind?: 'endpoint' | 'gateway';
  device_kind?: 'endpoint' | 'gateway';
  status: string;
  proofVerified?: boolean;
}

interface CompanyUser {
  userId: string;
  email: string;
  status: string;
  roles: string[];
}

interface ItemsResponse<T> {
  items: T[];
  total?: number;
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

function statusMessage<T>(state: LoadState<T>) {
  if (state.status === 'loading') return <p className="nx-muted">Cargando…</p>;
  if (state.status === 'forbidden') return <p>Sin permiso.</p>;
  if (state.status === 'error') return <p role="status">{state.code}</p>;
  return null;
}

export default function CompanySummaryPage() {
  const api = useApi();
  const [summary, setSummary] = useState<LoadState<CompanySummary>>({ status: 'loading' });
  const [sites, setSites] = useState<LoadState<ItemsResponse<Site>>>({ status: 'loading' });
  const [devices, setDevices] = useState<LoadState<ItemsResponse<DeviceView>>>({ status: 'loading' });
  const [users, setUsers] = useState<LoadState<ItemsResponse<CompanyUser>>>({ status: 'loading' });

  useEffect(() => {
    let current = true;
    void Promise.allSettled([
      api.get<CompanySummary>('/v1/company/summary'),
      api.get<ItemsResponse<Site>>('/v1/company/sites'),
      api.get<ItemsResponse<DeviceView>>('/v1/company/devices'),
      api.get<ItemsResponse<CompanyUser>>('/v1/company/users'),
    ]).then(([summaryResult, sitesResult, devicesResult, usersResult]) => {
      if (!current) return;
      setSummary(summaryResult.status === 'fulfilled' ? { status: 'ready', data: summaryResult.value } : failed(summaryResult.reason));
      setSites(sitesResult.status === 'fulfilled' ? { status: 'ready', data: sitesResult.value } : failed(sitesResult.reason));
      setDevices(devicesResult.status === 'fulfilled' ? { status: 'ready', data: devicesResult.value } : failed(devicesResult.reason));
      setUsers(usersResult.status === 'fulfilled' ? { status: 'ready', data: usersResult.value } : failed(usersResult.reason));
    });
    return () => { current = false; };
  }, [api]);

  const summaryMetrics: Array<{ title: string; value: keyof CompanySummary }> = [
    { title: 'Sedes', value: 'sites' },
    { title: 'Dispositivos', value: 'devices' },
    { title: 'Usuarios', value: 'users' },
    { title: 'Políticas activas', value: 'activePolicies' },
  ];

  return (
    <section aria-labelledby="page-title">
      <h1 id="page-title">Resumen de la empresa</h1>
      <p className="nx-lede">El registro no demuestra conectividad activa. Dispositivos, sedes y usuarios son dato declarado; su operatividad real requiere diagnóstico.</p>

      <div className="nx-grid">
        {summaryMetrics.map((metric) => {
          const state: LoadState<number> = summary.status === 'ready'
            ? { status: 'ready', data: summary.data[metric.value] }
            : summary;
          return (
            <Card heading={metric.title} key={metric.title}>
              {state.status === 'ready' && <h3>{state.data}</h3>}
              {statusMessage(state)}
            </Card>
          );
        })}
      </div>

      <Card heading="Sedes">
        {statusMessage(sites)}
        {sites.status === 'ready' && (
          <Table
            headers={['Nombre', 'Código', 'Estado', 'Redes']}
            rows={sites.data.items}
            renderRow={(site) => [site.name, site.code, site.status, site.networks.join(', ') || '—']}
            empty="No hay sedes declaradas."
          />
        )}
      </Card>

      <Card heading="Dispositivos (primeras 10 filas)">
        {statusMessage(devices)}
        {devices.status === 'ready' && (
          <>
            <Table
              headers={['Nombre', 'Plataforma', 'Tipo', 'Estado']}
              rows={devices.data.items.slice(0, 10)}
              renderRow={(device) => [device.name, device.platform ?? '—', device.deviceKind ?? device.device_kind ?? '—', device.status]}
              empty="No hay dispositivos declarados."
            />
            {devices.data.total !== undefined && <p className="nx-muted">Mostrando hasta 10 de {devices.data.total} dispositivos.</p>}
          </>
        )}
      </Card>
    </section>
  );
}
