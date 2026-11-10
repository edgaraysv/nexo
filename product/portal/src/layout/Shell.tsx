import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { Button } from '../components';

type Theme = 'light' | 'dark';

const themeStorageKey = 'nexo.portal.theme';

function initialTheme(): Theme {
  try {
    const stored = window.localStorage.getItem(themeStorageKey);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    // The portal remains usable when browser storage is disabled.
  }

  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export default function Shell() {
  const { session, logout } = useAuth();
  const location = useLocation();
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const mobileMenuRef = useRef<HTMLDialogElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const previousPath = useRef(location.pathname);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      window.localStorage.setItem(themeStorageKey, theme);
    } catch {
      // Theme is still applied for this session when storage is unavailable.
    }
  }, [theme]);

  useEffect(() => {
    if (previousPath.current !== location.pathname) {
      previousPath.current = location.pathname;
      mainRef.current?.focus();
    }
  }, [location.pathname]);

  if (!session) return null;

  const isProvider = session.surface === 'provider';
  const isOwner = session.surface === 'provider' && session.role === 'owner';
  const hasSupportPerm = !isProvider && session.permissions.includes('company.support.start');
  const providerLinks = [
    { label: 'Resumen', to: '/admin/provider/summary' },
    { label: 'Empresas', to: '/admin/provider/companies' },
    ...(isOwner ? [{ label: 'Comercial', to: '/admin/provider/commercial' }] : []),
    { label: 'Nodos y VPN', to: '/admin/provider/infra' },
    { label: 'WireGuard', to: '/admin/provider/wireguard' },
    { label: 'Reportes', to: '/admin/provider/reports' },
  ];
  const companyLinks = [
    { label: 'Resumen', to: '/admin/company/summary' },
    { label: 'Usuarios y equipos', to: '/admin/company/people' },
    { label: 'Redes y políticas', to: '/admin/company/networks' },
    { label: 'Operaciones y auditoría', to: '/admin/company/activity' },
    ...(hasSupportPerm ? [{ label: 'Soporte', to: '/admin/company/support' }] : []),
  ];
  const links = isProvider ? providerLinks : companyLinks;
  const surfaceName = isProvider ? 'Proveedor' : `Empresa: ${session.tenantName ?? session.tenantId ?? 'Sin empresa'}`;
  const role = session.role ? ` · ${session.role}` : '';
  const navigationLabel = isProvider ? 'Navegación del proveedor' : 'Navegación de la empresa';

  function openMobileMenu() {
    const dialog = mobileMenuRef.current;
    if (!dialog || dialog.open) return;
    dialog.showModal();
    setMobileMenuOpen(true);
    dialog.querySelector<HTMLAnchorElement>('a')?.focus();
  }

  function closeMobileMenu() {
    const dialog = mobileMenuRef.current;
    if (dialog?.open) dialog.close();
    setMobileMenuOpen(false);
    requestAnimationFrame(() => menuButtonRef.current?.focus());
  }

  function renderLinks(onNavigate?: () => void) {
    return links.map((link) => (
      <NavLink
        key={link.to}
        to={link.to}
        className="nx-nav-item"
        end
        onClick={onNavigate}
      >
        {link.label}
      </NavLink>
    ));
  }

  return (
    <>
      <a className="nx-skip" href="#main-content">Saltar a contenido</a>
      <div className="nx-shell">
        <header className="nx-topbar">
          <div className="nx-brand">
            <span className="nx-brand-m" role="img" aria-label="Placeholder de marca; no es el logotipo oficial">NX</span>
            <span className="nx-brand-copy">
              <span className="nx-brand-name">Nexo</span>
              <span className="nx-brand-tag">SYSMedia · BRING SMART SOLUTIONS</span>
            </span>
          </div>
          <div className="nx-topbar-user">
            <div className="nx-identity" title={`${session.email}${role}`}>
              {session.email}<span className="nx-identity-role">{role}</span>
            </div>
            <Button
              className="nx-theme-toggle"
              variant="secondary"
              size="sm"
              type="button"
              aria-label={`Cambiar a tema ${theme === 'dark' ? 'claro' : 'oscuro'}`}
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            >
              <span className="nx-theme-symbol" aria-hidden="true">{theme === 'dark' ? '☀' : '☾'}</span>
              <span className="nx-theme-label" aria-hidden="true">{theme === 'dark' ? 'Claro' : 'Oscuro'}</span>
            </Button>
            <Button
              ref={menuButtonRef}
              className="nx-mobile-menu-button"
              variant="secondary"
              size="sm"
              type="button"
              aria-controls="mobile-navigation"
              aria-expanded={mobileMenuOpen}
              onClick={openMobileMenu}
            >
              Menú
            </Button>
            <Button variant="secondary" size="sm" type="button" onClick={logout}>Salir</Button>
          </div>
        </header>

        <section className="nx-scope" aria-label="Alcance de la sesión">
          <strong>{surfaceName}</strong>
          <span className="nx-scope-meta">
            {isProvider
              ? `Alcance según rol y asignaciones del servidor${role}`
              : `${session.role ? `${session.role} · ` : ''}${session.permissions.length} permisos`}
          </span>
        </section>

        <nav className="nx-sidebar" aria-label={navigationLabel}>
          <span className="nx-nav-label">{isProvider ? 'Proveedor' : 'Empresa'}</span>
          {renderLinks()}
        </nav>

        <dialog
          ref={mobileMenuRef}
          id="mobile-navigation"
          className="nx-mobile-dialog"
          aria-labelledby="mobile-navigation-title"
          onClose={() => {
            setMobileMenuOpen(false);
            requestAnimationFrame(() => menuButtonRef.current?.focus());
          }}
          onClick={(event) => {
            if (event.target === event.currentTarget) closeMobileMenu();
          }}
        >
          <div className="nx-mobile-dialog-head">
            <h2 id="mobile-navigation-title">{isProvider ? 'Proveedor' : 'Empresa'}</h2>
            <Button variant="secondary" size="sm" type="button" onClick={closeMobileMenu}>Cerrar</Button>
          </div>
          <nav aria-label={navigationLabel}>
            {renderLinks(closeMobileMenu)}
          </nav>
        </dialog>

        <main ref={mainRef} id="main-content" className="nx-main" tabIndex={-1}>
          <Outlet />
        </main>
      </div>
    </>
  );
}
