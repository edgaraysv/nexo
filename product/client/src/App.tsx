import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { ClientStatus, serviceRequest } from './ipc';

const labels: Record<string, string> = { control: 'Canal de control', vpn: 'VPN', support: 'Soporte remoto', backup: 'Respaldo' };
const enrollmentLabels = { unregistered: 'Sin registrar', pending_approval: 'Pendiente de aprobación', approved: 'Aprobado' };
const vpnConnectionLabels = { disconnected: 'Desconectada', connecting: 'Conectando…', configured: 'Configuración aplicada; handshake sin verificar', connected: 'Conectada', error: 'Error de conexión' };

function formatDate(value?: string) {
  if (!value) return 'Sin observación';
  return new Intl.DateTimeFormat('es', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

export default function App() {
  const [status, setStatus] = useState<ClientStatus>();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const actionInFlight = useRef(false);

  const refresh = useCallback(async () => {
    try { setStatus(await serviceRequest<ClientStatus>('status')); setError(''); }
    catch { setError('No se pudo conectar con el servicio NEXO. La interfaz puede cerrarse sin detenerlo.'); }
  }, []);

  useEffect(() => { void refresh(); const timer = window.setInterval(refresh, 15_000); return () => window.clearInterval(timer); }, [refresh]);

  async function perform(action: 'claim' | 'run_diagnostic') {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    setBusy(true); setError('');
    try { setStatus(await serviceRequest<ClientStatus>(action)); }
    catch { setError(action === 'claim' ? 'La aprobación aún no está disponible.' : 'No fue posible completar el diagnóstico.'); }
    finally { actionInFlight.current = false; setBusy(false); }
  }

  async function enroll(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (actionInFlight.current) return;
    actionInFlight.current = true;
    const form = event.currentTarget, data = new FormData(form), token = String(data.get('token') ?? ''), name = String(data.get('name') ?? '');
    setBusy(true); setError('');
    try { setStatus(await serviceRequest<ClientStatus>('enroll', { token, name })); form.reset(); }
    catch { setError('No se pudo registrar el equipo. Revisa la invitación y vuelve a intentarlo.'); }
    finally { actionInFlight.current = false; setBusy(false); }
  }

  async function performVPN(action: 'connect_vpn' | 'disconnect_vpn' | 'rotate_wireguard_peer', environmentId: string) {
    if (actionInFlight.current) return;
    actionInFlight.current = true; setBusy(true); setError(''); setNotice('');
    try {
      setStatus(await serviceRequest<ClientStatus>(action, { environment_id: environmentId }));
      setNotice(action === 'connect_vpn' ? 'Solicitud de conexión enviada.' : action === 'disconnect_vpn' ? 'VPN desconectada.' : 'Clave nueva preparada. El proveedor debe aprobar la rotación.');
    } catch {
      setError(action === 'connect_vpn' ? 'No fue posible iniciar la VPN autorizada.' : action === 'disconnect_vpn' ? 'No fue posible detener la VPN.' : 'No fue posible preparar la rotación de clave.');
    } finally { actionInFlight.current = false; setBusy(false); }
  }

  async function exportDiagnostics() {
    if (actionInFlight.current) return;
    actionInFlight.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const diagnostic = await serviceRequest<ClientStatus>('diagnostics');
      const blob = new Blob([JSON.stringify({ schema: 'nexo.endpoint-diagnostics.v1', generated_at: new Date().toISOString(), ...diagnostic }, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob), link = document.createElement('a');
      link.href = url; link.download = 'nexo-diagnostics.json'; link.click(); URL.revokeObjectURL(url);
      setNotice('Diagnóstico exportado sin claves, tokens ni contraseña humana.');
    } catch { setError('No fue posible exportar el diagnóstico.'); }
    finally { actionInFlight.current = false; setBusy(false); }
  }

  return <main>
    <header className="topbar">
      <div className="brand"><span className="mark" aria-hidden="true">N</span><div><strong>NEXO</strong><span>Endpoint para Windows</span></div></div>
      <span className={`service ${status ? 'online' : 'offline'}`}><i aria-hidden="true" />{status ? 'Servicio activo' : 'Servicio sin conexión'}</span>
    </header>

    {error && <div className="alert" role="alert"><strong>Atención</strong><span>{error}</span><button type="button" onClick={refresh}>Reintentar</button></div>}
    <p className="sr-status" aria-live="polite">{notice}</p>

    <section className="hero" aria-labelledby="device-title">
      <div><p className="eyebrow">Identidad del dispositivo</p><h1 id="device-title">{status?.device_id ? 'Este equipo está vinculado' : 'Configura este equipo'}</h1><p>{status?.device_id ?? 'Usa una invitación emitida por el administrador de tu empresa.'}</p></div>
      <span className={`badge ${status?.enrollment === 'approved' ? 'success' : 'pending'}`}>{status ? enrollmentLabels[status.enrollment] : 'Desconocido'}</span>
    </section>

    {!status?.device_id && <section className="panel enroll" aria-labelledby="enroll-title"><div><p className="eyebrow">Registro seguro</p><h2 id="enroll-title">Vincular endpoint</h2><p>La clave se genera en el servicio y nunca se entrega a esta interfaz.</p></div><form onSubmit={enroll}><label>Nombre del equipo<input name="name" required maxLength={160} autoComplete="off" /></label><label>Invitación<input name="token" required minLength={20} maxLength={512} type="password" autoComplete="off" /></label><button disabled={busy}>{busy ? 'Procesando…' : 'Registrar equipo'}</button></form></section>}

    {status?.device_id && <div className="grid">
      <section className="panel" aria-labelledby="identity-title"><p className="eyebrow">Credencial</p><h2 id="identity-title">Identidad</h2><dl><div><dt>Audiencia</dt><dd>{status.audience}</dd></div><div><dt>Certificado</dt><dd>{status.certificate.status}</dd></div><div><dt>Vence</dt><dd>{formatDate(status.certificate.not_after)}</dd></div><div><dt>Serie</dt><dd className="mono">{status.certificate.serial ?? 'Pendiente'}</dd></div></dl>{status.enrollment === 'pending_approval' && <button disabled={busy} onClick={() => perform('claim')}>Comprobar aprobación</button>}</section>
      <section className="panel" aria-labelledby="activity-title"><p className="eyebrow">Actividad</p><h2 id="activity-title">Últimas observaciones</h2><dl><div><dt>Conexión</dt><dd>{formatDate(status.last_connection)}</dd></div><div><dt>Diagnóstico</dt><dd>{formatDate(status.last_diagnostic)}</dd></div><div><dt>Agente</dt><dd>{status.agent_version}</dd></div><div><dt>Runtime</dt><dd>{status.operating_system} · {status.architecture}</dd></div></dl><div className="actions"><button disabled={busy || status.enrollment !== 'approved'} onClick={() => perform('run_diagnostic')}>{busy ? 'Ejecutando…' : 'Ejecutar diagnóstico'}</button><button className="secondary" disabled={busy} onClick={exportDiagnostics}>Exportar</button></div></section>
    </div>}

    <section className="panel modules" aria-labelledby="modules-title"><div><p className="eyebrow">Capacidades</p><h2 id="modules-title">Módulos</h2></div><ul>{Object.entries(status?.modules ?? { control: 'enabled', vpn: 'not_integrated', support: 'not_integrated', backup: 'not_integrated' }).map(([key, value]) => <li key={key}><span>{labels[key] ?? key}</span><strong className={value === 'enabled' ? 'available' : ''}>{value === 'enabled' ? 'Disponible' : value === 'unavailable' ? 'No disponible' : 'No integrado'}</strong></li>)}</ul></section>
    {status?.modules.vpn === 'enabled' && <section className="panel" aria-labelledby="vpn-title"><p className="eyebrow">VPN empresarial</p><h2 id="vpn-title">Entornos autorizados</h2>{status.vpn.environments.length === 0 ? <p>No hay un entorno VPN operativo para esta empresa.</p> : <ul>{status.vpn.environments.map(environment => { const connecting = environment.connection_state === 'connecting', active = environment.connection_state === 'connected' || environment.connection_state === 'configured'; const canConnect = environment.engine === 'wireguard' ? Boolean(environment.wireguard_peer) : environment.credential_state === 'issued'; const statusText = environment.connection_state ? vpnConnectionLabels[environment.connection_state] : environment.engine === 'wireguard' ? environment.wireguard_state === 'pending_approval' ? 'Peer registrado; espera aprobación del proveedor.' : environment.wireguard_state === 'active' ? 'Peer WireGuard autorizado.' : environment.wireguard_state === 'unavailable' ? 'No fue posible registrar el peer; se reintentará.' : 'Esperando la clave pública del nodo.' : environment.credential_state === 'issued' ? 'Credencial lista.' : environment.credential_state === 'pending' ? 'Emisión de credencial pendiente en el nodo.' : environment.credential_state === 'revoked' ? 'Credencial revocada.' : environment.credential_state === 'failed' ? 'No se pudo emitir la credencial.' : 'Preparando credencial VPN.'; return <li key={environment.id}><strong>{environment.name}</strong><span>{environment.engine === 'wireguard' ? 'WireGuard' : 'OpenVPN'} UDP · puerto {environment.listener_port} · revisión {environment.revision}</span><small>{statusText}</small><div className="actions">{canConnect && !active && !connecting && <button disabled={busy} onClick={() => performVPN('connect_vpn', environment.id)}>Conectar</button>}{(active || connecting) && <button className="secondary" disabled={busy} onClick={() => performVPN('disconnect_vpn', environment.id)}>Desconectar</button>}{environment.engine === 'wireguard' && environment.wireguard_state === 'active' && <button className="secondary" disabled={busy} onClick={() => performVPN('rotate_wireguard_peer', environment.id)}>Preparar rotación de clave</button>}</div></li>; })}</ul>}</section>}
    <footer>La contraseña humana y la clave privada no se almacenan ni se muestran en esta interfaz.</footer>
  </main>;
}
