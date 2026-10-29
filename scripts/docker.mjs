import { spawnSync } from 'node:child_process';
import { userInfo } from 'node:os';

// Solo CLI local. Nunca cambiar contexto ni conectar a un host remoto implícito.
export function docker(args, options = {}) {
  const host = process.env.DOCKER_HOST;
  if (host && !host.startsWith('unix://')) {
    throw new Error('F01 rechaza DOCKER_HOST remoto. Usar un motor local explícito.');
  }
  const config = { cwd: process.cwd(), encoding: 'utf8', timeout: 900_000, ...options };
  const context = spawnSync('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], {
    encoding: 'utf8', timeout: 10_000,
  });
  if (context.status !== 0) {
    throw new Error(`Docker CLI local no disponible: ${context.stderr || context.stdout || context.error || 'sin contexto'}`);
  }
  if (!context.stdout.trim().startsWith('unix://')) {
    throw new Error('F01 requiere un contexto local Unix; no se consulta un motor remoto.');
  }
  const probe = spawnSync('docker', ['version', '--format', '{{.Server.Os}}'], {
    encoding: 'utf8', timeout: 30_000,
  });
  if (probe.status === 0) {
    return spawnSync('docker', args, config);
  }
  if (process.env.WSL_DISTRO_NAME && /permission denied/.test(probe.stderr ?? '')) {
    return spawnSync('/mnt/c/Windows/System32/wsl.exe', [
      '--distribution', process.env.WSL_DISTRO_NAME, '--user', userInfo().username,
      '--cd', process.cwd(), '--exec', 'docker', ...args,
    ], config);
  }
  throw new Error(`Docker local no disponible: ${probe.stderr || probe.error || 'sin motor'}`);
}
