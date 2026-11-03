import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth/AuthContext';
import LoginPage from './auth/LoginPage';
import Shell from './layout/Shell';

function RequireAuth() {
  const { session } = useAuth();
  return session ? <Shell /> : <LoginPage />;
}

function AdminRedirect() {
  const { session } = useAuth();
  if (!session) return <LoginPage />;
  return (
    <Navigate
      to={session.surface === 'provider' ? '/admin/provider/summary' : '/admin/company/summary'}
      replace
    />
  );
}

function SurfacePage({ surface, title }: { surface: 'provider' | 'company'; title: string }) {
  const { session } = useAuth();
  if (!session) return <LoginPage />;
  if (session.surface !== surface) {
    return <Navigate to={session.surface === 'provider' ? '/admin/provider/summary' : '/admin/company/summary'} replace />;
  }
  return (
    <section aria-labelledby="page-title">
      <h1 id="page-title">{title}</h1>
      <p>(migración pendiente)</p>
    </section>
  );
}

function AccountPage() {
  return (
    <section aria-labelledby="page-title">
      <h1 id="page-title">Cuenta</h1>
      <p>(migración pendiente)</p>
    </section>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter basename="/portal">
        <Routes>
          <Route path="/admin" element={<RequireAuth />}>
            <Route index element={<AdminRedirect />} />
            <Route path="provider/summary" element={<SurfacePage surface="provider" title="Resumen del proveedor" />} />
            <Route path="provider/companies" element={<SurfacePage surface="provider" title="Empresas" />} />
            <Route path="provider/commercial" element={<SurfacePage surface="provider" title="Comercial" />} />
            <Route path="provider/infra" element={<SurfacePage surface="provider" title="Nodos y VPN" />} />
            <Route path="provider/reports" element={<SurfacePage surface="provider" title="Reportes" />} />
            <Route path="company/summary" element={<SurfacePage surface="company" title="Resumen de la empresa" />} />
            <Route path="company/people" element={<SurfacePage surface="company" title="Usuarios y equipos" />} />
            <Route path="company/networks" element={<SurfacePage surface="company" title="Redes y políticas" />} />
            <Route path="company/activity" element={<SurfacePage surface="company" title="Operaciones y auditoría" />} />
          </Route>
          <Route path="/account" element={<RequireAuth />}>
            <Route index element={<AccountPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/admin" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
