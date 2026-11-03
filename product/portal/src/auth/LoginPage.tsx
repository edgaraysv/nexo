import { useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth, type MfaResult } from './AuthContext';
import { Button, Card, Input } from '../components';

type Step = 'login' | 'mfa' | 'surface';

export default function LoginPage() {
  const { login, verifyMfa, selectProvider, selectCompany } = useAuth();
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>('login');
  const [challenge, setChallenge] = useState('');
  const [mfaResult, setMfaResult] = useState<MfaResult | null>(null);
  const [tenantId, setTenantId] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const inFlight = useRef(false);

  async function submitLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;
    const values = new FormData(event.currentTarget);
    inFlight.current = true;
    setPending(true);
    setError('');
    try {
      const result = await login(String(values.get('email') ?? ''), String(values.get('password') ?? ''));
      setChallenge(result.challenge);
      setStep('mfa');
    } catch {
      setError('No fue posible iniciar sesión. Revisa tus datos o intenta más tarde.');
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  async function submitMfa(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;
    const values = new FormData(event.currentTarget);
    inFlight.current = true;
    setPending(true);
    setError('');
    try {
      const result = await verifyMfa(challenge, String(values.get('code') ?? ''));
      setMfaResult(result);
      setTenantId(result.memberships[0]?.tenant_id ?? '');
      setStep('surface');
    } catch {
      setError('No fue posible validar el código MFA. Inténtalo de nuevo.');
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  async function enterProvider() {
    if (!mfaResult || inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError('');
    try {
      await selectProvider(mfaResult.selection);
      navigate('/admin/provider/summary', { replace: true });
    } catch {
      setError('No fue posible abrir el panel del proveedor.');
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  async function enterCompany(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!mfaResult || !tenantId || inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError('');
    try {
      await selectCompany(mfaResult.selection, tenantId);
      navigate('/admin/company/summary', { replace: true });
    } catch {
      setError('No fue posible abrir la empresa seleccionada.');
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  return (
    <main className="nx-auth-page">
      <div className="nx-auth-content">
        <div className="nx-auth-brand" aria-label="Nexo">
          <span className="nx-brand-m" role="img" aria-label="Placeholder de marca; no es el logotipo oficial">NX</span>
          <span className="nx-brand-name">Nexo</span>
        </div>
        <Card className="nx-auth-card" heading={step === 'login' ? 'Acceso' : step === 'mfa' ? 'Verificación MFA' : 'Selecciona una superficie'}>
          {step === 'login' && (
            <form className="nx-auth-form" onSubmit={submitLogin}>
              <Input label="Correo" name="email" type="email" autoComplete="username" maxLength={320} required />
              <Input label="Contraseña" name="password" type="password" autoComplete="current-password" maxLength={1024} required />
              <Button type="submit" disabled={pending}>{pending ? 'Continuando…' : 'Continuar'}</Button>
            </form>
          )}

          {step === 'mfa' && (
            <form className="nx-auth-form" onSubmit={submitMfa}>
              <p className="nx-muted">Introduce el código de tu segundo factor.</p>
              <Input label="Código MFA" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required autoFocus />
              <Button type="submit" disabled={pending}>{pending ? 'Verificando…' : 'Verificar'}</Button>
            </form>
          )}

          {step === 'surface' && mfaResult && (
            <div className="nx-auth-form">
              <p className="nx-muted">Elige la superficie y el alcance de esta sesión.</p>
              {mfaResult.provider && (
                <Button type="button" disabled={pending} onClick={() => void enterProvider()}>
                  {pending ? 'Abriendo…' : `Panel del proveedor · ${mfaResult.provider.role}`}
                </Button>
              )}
              {mfaResult.memberships.length > 0 && (
                <form className="nx-auth-form" onSubmit={enterCompany}>
                  <label className="nx-field">
                    <span>Empresa</span>
                    <select className="nx-select" value={tenantId} onChange={(event) => setTenantId(event.target.value)} required>
                      {mfaResult.memberships.map((membership) => (
                        <option key={membership.tenant_id} value={membership.tenant_id}>{membership.name}</option>
                      ))}
                    </select>
                  </label>
                  <Button type="submit" disabled={pending || !tenantId}>{pending ? 'Abriendo…' : 'Entrar al portal'}</Button>
                </form>
              )}
              {!mfaResult.provider && mfaResult.memberships.length === 0 && (
                <p className="nx-muted">Esta cuenta no tiene una superficie disponible.</p>
              )}
            </div>
          )}

          <p className="nx-status" role="status" aria-live="polite">{error}</p>
        </Card>
      </div>
    </main>
  );
}
