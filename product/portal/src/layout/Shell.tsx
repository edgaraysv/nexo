import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { Button } from '../components';

const providerLinks = [
  { label: 'Resumen', to: '/admin/provider/summary' },
  { label: 'Empresas', to: '/admin/provider/companies' },
  { label: 'Comercial', to: '/admin/provider/commercial' },
  { label: 'Nodos y VPN', to: '/admin/provider/infra' },
  { label: 'Reportes', to: '/admin/provider/reports' },
];

const companyLinks = [
  { label: 'Resumen', to: '/admin/company/summary' },
  { label: 'Usuarios y equipos', to: '/admin/company/people' },
  { label: 'Redes y políticas', to: '/admin/company/networks' },
  { label: 'Operaciones y auditoría', to: '/admin/company/activity' },
];

export default function Shell() {
  const { session, logout } = useAuth();
  if (!session) return null;

  const isProvider = session.surface === 'provider';
  const links = isProvider ? providerLinks : companyLinks;
  const surfaceName = isProvider ? 'Proveedor' : `Empresa: ${session.tenantName ?? session.tenantId ?? 'Sin empresa'}`;
  const role = session.role ? ` · ${session.role}` : '';

  return (
    <>
      <a className="nx-skip" href="#main-content">Saltar a contenido</a>
      <div className="nx-shell">
        <header className="nx-topbar">
          <div className="nx-brand">
            <span className="nx-brand-m" role="img" aria-label="Placeholder de marca; no es el logotipo oficial">NX</span>
            <span className="nx-brand-copy">
              <span className="nx-brand-name">Nexo</span>
              <span className="nx-brand-tag">BRING SMART SOLUTIONS</span>
            </span>
          </div>
          <div className="nx-topbar-user">
            <div className="nx-identity" title={`${session.email}${role}`}>
              {session.email}<span className="nx-identity-role">{role}</span>
            </div>
            <Button variant="secondary" size="sm" type="button" onClick={logout}>Salir</Button>
          </div>
        </header>

        <section className="nx-scope" aria-label="Alcance de la sesión">
          <strong>{surfaceName}</strong>
          <span className="nx-scope-meta">
            {isProvider
              ? `Alcance según rol y asignaciones del servidor${role}`
              : `${session.permissions.length} permisos devueltos por el servidor`}
          </span>
        </section>

        <nav className="nx-sidebar" aria-label={isProvider ? 'Navegación del proveedor' : 'Navegación de la empresa'}>
          <span className="nx-nav-label">{isProvider ? 'Proveedor' : 'Empresa'}</span>
          {links.map((link) => (
            <NavLink
              key={link.to}
              to={link.to}
              className="nx-nav-item"
              end
            >
              {link.label}
            </NavLink>
          ))}
        </nav>

        <main id="main-content" className="nx-main" tabIndex={-1}>
          <Outlet />
        </main>
      </div>
    </>
  );
}
