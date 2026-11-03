import { useEffect, useState } from 'react';
import { Card } from '../../components';
import { ApiError, useApi } from '../../api';

interface ItemsResponse {
  items: unknown[];
}

type MetricState =
  | { status: 'loading' }
  | { status: 'ready'; count: number }
  | { status: 'forbidden' }
  | { status: 'error'; code: string };

interface Metric {
  title: string;
  state: MetricState;
}

const endpoints = [
  { title: 'Empresas', path: '/v1/provider/companies' },
  { title: 'Nodos', path: '/v1/provider/nodes' },
  { title: 'Entornos VPN', path: '/v1/provider/vpn-environments' },
  { title: 'Operaciones de nodo', path: '/v1/provider/node-operations' },
] as const;

function failureState(error: unknown): MetricState {
  if (error instanceof ApiError && error.status === 403) return { status: 'forbidden' };
  return { status: 'error', code: error instanceof ApiError ? error.code : 'request_failed' };
}

export default function ProviderSummaryPage() {
  const api = useApi();
  const [metrics, setMetrics] = useState<Metric[]>(() =>
    endpoints.map(({ title }) => ({ title, state: { status: 'loading' } })),
  );

  useEffect(() => {
    let current = true;
    void Promise.allSettled(endpoints.map(({ path }) => api.get<ItemsResponse>(path))).then((results) => {
      if (!current) return;
      setMetrics(endpoints.map(({ title }, index) => {
        const result = results[index];
        if (!result) return { title, state: { status: 'error', code: 'request_failed' } };
        if (result.status === 'fulfilled') return { title, state: { status: 'ready', count: result.value.items.length } };
        return { title, state: failureState(result.reason) };
      }));
    });
    return () => { current = false; };
  }, [api]);

  return (
    <section aria-labelledby="page-title">
      <h1 id="page-title">Resumen del proveedor</h1>
      <p className="nx-lede">El alcance depende del rol y las asignaciones del servidor. Registro, configuración y conectividad son señales distintas.</p>
      <div className="nx-grid">
        {metrics.map((metric) => (
          <Card heading={metric.title} key={metric.title}>
            {metric.state.status === 'loading' && <p className="nx-muted">Cargando…</p>}
            {metric.state.status === 'ready' && <h3>{metric.state.count}</h3>}
            {metric.state.status === 'forbidden' && <p>Sin permiso.</p>}
            {metric.state.status === 'error' && <p role="status">{metric.state.code}</p>}
            <p className="nx-muted">El registro no demuestra conectividad.</p>
          </Card>
        ))}
      </div>
    </section>
  );
}
