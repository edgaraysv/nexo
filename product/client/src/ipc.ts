import { invoke } from '@tauri-apps/api/core';

export type Action = 'status' | 'diagnostics' | 'enroll' | 'claim' | 'run_diagnostic' | 'revoke_vpn_credential' | 'connect_vpn' | 'disconnect_vpn' | 'rotate_wireguard_peer';

export interface VPNEnvironment {
  id: string;
  name: string;
  engine: 'openvpn' | 'wireguard';
  protocol: 'udp';
  listener_port: number;
  revision: number;
  wireguard_peer?: { peerId: string; tunnelIpv4: string; clientPublicKey: string; serverTunnelIpv4: string; serverPublicKey: string; listenerPort: number; allowedIps: string[]; persistentKeepaliveSeconds: 0 | 25 };
  wireguard_state?: 'pending_approval' | 'active' | 'awaiting_node_key' | 'unavailable';
  credential_state?: 'pending' | 'issued' | 'revocation_pending' | 'revoked' | 'failed';
  connection_state?: 'disconnected' | 'connecting' | 'configured' | 'connected' | 'error';
  connection_error?: string;
}

export interface CertificateStatus {
  serial?: string;
  not_after?: string;
  status: 'missing' | 'active' | 'expired' | 'not_yet_valid' | 'invalid';
}

export interface ClientStatus {
  service: 'running';
  device_id?: string;
  audience?: 'endpoint';
  enrollment: 'unregistered' | 'pending_approval' | 'approved';
  certificate: CertificateStatus;
  last_connection?: string;
  last_diagnostic?: string;
  last_error?: string;
  agent_version: string;
  operating_system: string;
  architecture: string;
  modules: Record<string, 'enabled' | 'unavailable' | 'not_integrated'>;
  vpn: { state: 'unavailable' | 'catalog_ready' | 'disconnected' | 'connecting' | 'configured' | 'connected' | 'error'; environments: VPNEnvironment[] };
}

interface ServiceResponse<T> {
  version: 1;
  id: string;
  ok: boolean;
  data?: T;
  error?: string;
}

export async function serviceRequest<T>(action: Action, payload?: Record<string, unknown>): Promise<T> {
  const id = `ui_${crypto.randomUUID().replaceAll('-', '')}`;
  const response = await invoke<ServiceResponse<T>>('service_request', {
    request: { version: 1, id, action, ...(payload ? { payload } : {}) }
  });
  if (!response.ok || !response.data) throw new Error(response.error ?? 'service_unavailable');
  return response.data;
}
