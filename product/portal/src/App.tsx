import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import type { ReactNode } from 'react';
import { AuthProvider, useAuth } from './auth/AuthContext';
import LoginPage from './auth/LoginPage';
import Shell from './layout/Shell';
import ProviderSummaryPage from './pages/provider/ProviderSummaryPage';
import ProviderCompaniesPage from './pages/provider/ProviderCompaniesPage';
import ProviderCommercialPage from './pages/provider/ProviderCommercialPage';
import ProviderInfraPage from './pages/provider/ProviderInfraPage';
import ProviderWireGuardPage from './pages/provider/ProviderWireGuardPage';
import ProviderReportsPage from './pages/provider/ProviderReportsPage';
import CompanySummaryPage from './pages/company/CompanySummaryPage';
import CompanyPeoplePage from './pages/company/CompanyPeoplePage';
import CompanyNetworksPage from './pages/company/CompanyNetworksPage';
import CompanyActivityPage from './pages/company/CompanyActivityPage';
import CompanySupportPage from './pages/company/CompanySupportPage';

function RequireAuth() {
  const { session, isRestoring } = useAuth();
  if (isRestoring) return <main role="status" aria-busy="true">Verificando sesión…</main>;
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

function AccountPage() {
  return (
    <section aria-labelledby="page-title">
      <h1 id="page-title">Cuenta</h1>
      <p>(migración pendiente)</p>
    </section>
  );
}

function RequireProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  if (!session) return <LoginPage />;
  if (session.surface !== 'provider') return <Navigate to="/admin/company/summary" replace />;
  return children;
}

function RequireCompany({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  if (!session) return <LoginPage />;
  if (session.surface !== 'company') return <Navigate to="/admin/provider/summary" replace />;
  return children;
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter basename="/portal">
        <Routes>
          <Route path="/admin" element={<RequireAuth />}>
            <Route index element={<AdminRedirect />} />
            <Route path="provider/summary" element={<RequireProvider><ProviderSummaryPage /></RequireProvider>} />
            <Route path="provider/companies" element={<RequireProvider><ProviderCompaniesPage /></RequireProvider>} />
            <Route path="provider/commercial" element={<RequireProvider><ProviderCommercialPage /></RequireProvider>} />
            <Route path="provider/infra" element={<RequireProvider><ProviderInfraPage /></RequireProvider>} />
            <Route path="provider/wireguard" element={<RequireProvider><ProviderWireGuardPage /></RequireProvider>} />
            <Route path="provider/reports" element={<RequireProvider><ProviderReportsPage /></RequireProvider>} />
            <Route path="company/summary" element={<RequireCompany><CompanySummaryPage /></RequireCompany>} />
            <Route path="company/people" element={<RequireCompany><CompanyPeoplePage /></RequireCompany>} />
            <Route path="company/networks" element={<RequireCompany><CompanyNetworksPage /></RequireCompany>} />
            <Route path="company/activity" element={<RequireCompany><CompanyActivityPage /></RequireCompany>} />
            <Route path="company/support" element={<RequireCompany><CompanySupportPage /></RequireCompany>} />
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
