(() => {
  'use strict';

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const params = new URLSearchParams(location.search);
  const uxId = (params.get('ux') || '').toUpperCase();
  const permissions = {
    admin: ['company.summary.read', 'company.site.read', 'company.site.create', 'company.device.read', 'company.device.create', 'company.user.read', 'company.user.invite', 'company.user.roles.manage', 'company.resource_grant.manage', 'company.policy.read', 'company.policy.manage', 'company.agent.read', 'company.agent.invite', 'company.agent.approve', 'company.agent.revoke', 'company.operation.read', 'company.operation.create', 'company.audit.read', 'company.support.start', 'company.network.read', 'company.network.manage', 'company.network.diagnose'],
    technician: ['company.summary.read', 'company.site.read', 'company.device.read', 'company.device.create', 'company.user.read', 'company.policy.read', 'company.agent.read', 'company.agent.invite', 'company.agent.approve', 'company.agent.revoke', 'company.operation.read', 'company.operation.create', 'company.support.start', 'company.network.read', 'company.network.manage', 'company.network.diagnose'],
    auditor: ['company.summary.read', 'company.site.read', 'company.device.read', 'company.user.read', 'company.policy.read', 'company.agent.read', 'company.operation.read', 'company.audit.read', 'company.network.read'],
    auditorExport: ['company.summary.read', 'company.site.read', 'company.device.read', 'company.user.read', 'company.policy.read', 'company.agent.read', 'company.operation.read', 'company.audit.read', 'company.network.read', 'company.report.export'],
  };
  const personas = {
    providerOwner: { id: 'providerOwner', label: 'Proveedor · propietario', surface: 'provider', role: 'owner', tenant: 'global', permissions: ['provider.owner'], pages: ['overview', 'companies', 'vpn', 'audit', 'services'] },
    providerOperator: { id: 'providerOperator', label: 'Proveedor · operador asignado', surface: 'provider', role: 'operator', tenant: 'a', permissions: ['provider.company.assigned.read'], pages: ['overview', 'companies', 'vpn', 'audit', 'services'] },
    providerAuditor: { id: 'providerAuditor', label: 'Proveedor · auditor asignado', surface: 'provider', role: 'auditor', tenant: 'a', permissions: ['provider.company.assigned.read'], pages: ['overview', 'companies', 'audit', 'services'] },
    companyAdmin: { id: 'companyAdmin', label: 'Empresa demo A · administrador', surface: 'company', role: 'company.admin', tenant: 'a', permissions: permissions.admin, pages: ['overview', 'devices', 'networks', 'policies', 'diagnostics', 'audit', 'services', 'preferences'] },
    technician: { id: 'technician', label: 'Empresa demo A · técnico delegado', surface: 'company', role: 'company.technician', tenant: 'a', permissions: permissions.technician, pages: ['overview', 'devices', 'networks', 'policies', 'diagnostics', 'audit', 'services'] },
    auditor: { id: 'auditor', label: 'Empresa demo A · auditor', surface: 'company', role: 'company.auditor', tenant: 'a', permissions: permissions.auditor, pages: ['overview', 'devices', 'networks', 'policies', 'audit', 'services'] },
    auditorExport: { id: 'auditorExport', label: 'Empresa demo A · auditor + grant exportación', surface: 'company', role: 'company.auditor', tenant: 'a', permissions: permissions.auditorExport, pages: ['overview', 'devices', 'networks', 'policies', 'audit', 'services'] },
    companyAdminB: { id: 'companyAdminB', label: 'Empresa demo B · administrador', surface: 'company', role: 'company.admin', tenant: 'b', permissions: permissions.admin, pages: ['overview', 'devices', 'networks', 'policies', 'diagnostics', 'audit', 'services', 'preferences'] },
    endpoint: { id: 'endpoint', label: 'Usuario endpoint · Windows', surface: 'endpoint', role: 'endpoint.user', tenant: 'a', permissions: ['device.session.self'], pages: ['endpoint'] },
  };
  const scenarios = {
    'UX-01': ['providerOwner', 'overview'], 'UX-02': ['companyAdmin', 'overview'], 'UX-03': ['companyAdmin', 'overview'],
    'UX-04': ['companyAdmin', 'preferences'], 'UX-05': ['companyAdmin', 'devices'], 'UX-06': ['companyAdmin', 'overview'],
    'UX-07': ['auditorExport', 'devices'], 'UX-08': ['technician', 'devices'], 'UX-09': ['technician', 'devices'],
    'UX-10': ['auditor', 'audit'], 'UX-11': ['providerOwner', 'vpn'], 'UX-12': ['endpoint', 'endpoint'],
    'UX-13': ['companyAdmin', 'preferences'], 'UX-14': ['companyAdmin', 'telemetry'],
  };
  const pages = {
    overview: ['Resumen', 'Empieza por lo que requiere atención. Cada señal muestra fuente, alcance y momento de observación.', '⌂'],
    companies: ['Empresas', 'El proveedor ve solo el alcance de su rol y asignaciones; la persona de prueba no autentica.', '▦'],
    devices: ['Dispositivos', 'Agente, túnel VPN y acceso al recurso son estados distintos.', '▣'],
    networks: ['Sucursales y redes', 'La configuración declarada no demuestra que el router externo esté configurado ni que el recurso responda.', '⌘'],
    policies: ['Políticas', 'Denegar por defecto. Una decisión de política no demuestra conectividad.', '◇'],
    diagnostics: ['Diagnóstico', 'Agente, túnel, ruta, DNS, política y respuesta de aplicación se presentan por separado.', '⌁'],
    vpn: ['VPN y revisiones', 'Estado deseado, aplicado y observado; nunca se muestran claves o tokens.', '↔'],
    audit: ['Actividad y auditoría', 'Quién, qué, cuándo y sobre qué entidad, dentro del alcance autorizado.', '◷'],
    services: ['Servicios', 'La conexión VPN no implica que asistencia remota o respaldos estén operativos.', '▤'],
    preferences: ['Preferencias', 'Tema local, movimiento reducido y notas de contraste del prototipo.', '⚙'],
    endpoint: ['Cliente endpoint', 'Estado local de VPN independiente de la conectividad con un recurso.', '▣'],
    telemetry: ['Revisión UX local', 'Eventos sintéticos por tarea y etapa; no se envían ni persisten.', '◷'],
  };
  const data = {
    a: {
      tenant: 'Empresa de demostración A',
      devices: [
        { id: 'a1', name: 'Equipo Demo A-01', kind: 'Usuario', site: 'Sede de ejemplo A', platform: 'Windows 11', agent: 'Señal reciente', vpn: 'Conectada · muestra', resource: 'No comprobado', seen: '18:32 CST · fixture', source: 'heartbeat fixture' },
        { id: 'a2', name: 'Servidor Demo A-02', kind: 'Servidor', site: 'Sede de ejemplo A', platform: 'Linux', agent: 'Señal reciente', vpn: 'Conectada · muestra', resource: 'No comprobado', seen: '18:28 CST · fixture', source: 'inventario fixture' },
        { id: 'a3', name: 'Gateway Demo A-01', kind: 'Gateway', site: 'Sucursal de ejemplo A', platform: 'Linux', agent: 'Señal reciente', vpn: 'Conectada · muestra', resource: 'Retorno pendiente', seen: '18:15 CST · fixture', source: 'perfil de red fixture' },
        { id: 'a4', name: 'Equipo Demo A-04', kind: 'Usuario', site: 'Sede de ejemplo A', platform: 'Windows 11', agent: 'Señal desactualizada', vpn: 'Desconectada · muestra', resource: 'No comprobado', seen: '16:20 CST · fixture', source: 'heartbeat fixture' },
        { id: 'a5', name: 'Gateway Demo A-05', kind: 'Gateway', site: 'Sucursal de ejemplo B', platform: 'Linux', agent: 'Señal reciente', vpn: 'Conectada · muestra', resource: 'Ruta no verificada', seen: '18:10 CST · fixture', source: 'perfil de red fixture' },
      ],
      branches: [
        { name: 'Sucursal de ejemplo A', cidr: '10.30.0.0/24', gateway: 'Gateway Demo A-01', desired: 'Activa · fixture', applied: 'Revisión 4 · fixture', observed: 'Retorno pendiente de verificación', next: 'Revisar ruta externa o documentar SNAT privado.' },
        { name: 'Sucursal de ejemplo B', cidr: '10.31.0.0/24', gateway: 'Gateway Demo A-05', desired: 'Activa · fixture', applied: 'Revisión 2 · fixture', observed: 'Lectura desactualizada', next: 'Solicitar nueva observación; probar el recurso por separado.' },
      ],
      policies: [
        { name: 'Comercial → ERP demo', source: 'Grupo de ejemplo Comercial', resource: 'ERP demo', service: 'TCP 443', effect: 'Permitir · fixture' },
        { name: 'Contabilidad → Archivos demo', source: 'Grupo de ejemplo Contabilidad', resource: 'Servidor de archivos demo', service: 'TCP 445', effect: 'Permitir · fixture' },
        { name: 'Todo lo demás', source: 'Origen no listado', resource: 'Recurso no listado', service: '—', effect: 'Denegar por defecto' },
      ],
      audit: [
        { createdAt: '18:32 CST · muestra', actorUserId: 'user-demo-01', action: 'policy.updated', resourceType: 'policy', resourceId: 'policy-demo-01' },
        { createdAt: '18:17 CST · muestra', actorUserId: null, action: 'network.profile.reported', resourceType: 'network_profile', resourceId: 'profile-demo-01' },
        { createdAt: '17:48 CST · muestra', actorUserId: 'user-demo-02', action: 'network.diagnostic.requested', resourceType: 'device_identity', resourceId: 'device-demo-04' },
      ],
    },
    b: {
      tenant: 'Empresa de demostración B',
      devices: [
        { id: 'b1', name: 'Equipo Demo B-01', kind: 'Usuario', site: 'Sede de ejemplo B', platform: 'Windows 11', agent: 'Señal reciente', vpn: 'Conectada · muestra', resource: 'No comprobado', seen: '18:26 CST · fixture', source: 'heartbeat fixture' },
        { id: 'b2', name: 'Servidor Demo B-02', kind: 'Servidor', site: 'Sede de ejemplo B', platform: 'Linux', agent: 'Sin observación', vpn: 'No observado', resource: 'No comprobado', seen: 'Sin datos', source: 'inventario fixture' },
        { id: 'b3', name: 'Gateway Demo B-01', kind: 'Gateway', site: 'Sucursal de ejemplo B', platform: 'Linux', agent: 'Señal desactualizada', vpn: 'Desconectada · muestra', resource: 'Retorno no verificado', seen: '15:42 CST · fixture', source: 'perfil de red fixture' },
      ],
      branches: [{ name: 'Sucursal de ejemplo B', cidr: '10.30.0.0/24', gateway: 'Gateway Demo B-01', desired: 'Activa · fixture', applied: 'Revisión 1 · fixture', observed: 'Sin respuesta reciente', next: 'Revisar evidencia únicamente en Empresa demo B.' }],
      policies: [{ name: 'Administración → servicio demo', source: 'Grupo de ejemplo Administración', resource: 'Servicio demo', service: 'TCP 443', effect: 'Permitir · fixture' }, { name: 'Todo lo demás', source: 'Origen no listado', resource: 'Recurso no listado', service: '—', effect: 'Denegar por defecto' }],
      audit: [{ createdAt: '18:26 CST · muestra', actorUserId: 'user-demo-b01', action: 'device.observed', resourceType: 'device_identity', resourceId: 'device-demo-b01' }],
    },
  };
  const auditEvents = {
    'UX-01': { persona: 'providerOwner', page: 'overview' },
    'UX-02': { persona: 'companyAdmin', page: 'overview' },
    'UX-03': { persona: 'companyAdmin', page: 'overview' },
    'UX-04': { persona: 'companyAdmin', page: 'preferences' },
    'UX-05': { persona: 'companyAdmin', page: 'devices' },
    'UX-06': { persona: 'companyAdmin', page: 'overview' },
    'UX-07': { persona: 'auditorExport', page: 'devices' },
    'UX-08': { persona: 'technician', page: 'devices' },
    'UX-09': { persona: 'technician', page: 'devices' },
    'UX-10': { persona: 'auditor', page: 'audit' },
    'UX-11': { persona: 'providerOwner', page: 'vpn' },
    'UX-12': { persona: 'endpoint', page: 'endpoint' },
    'UX-13': { persona: 'companyAdmin', page: 'preferences' },
    'UX-14': { persona: 'companyAdmin', page: 'telemetry' },
  };
  const ALLOWLIST = ['task_id', 'surface', 'outcome', 'duration_ms', 'step', 'reason_code'];
  const uxEvents = [
    { task_id: 'UX-09', surface: 'portal', outcome: 'completed', duration_ms: 74000, step: 'preview', reason_code: 'synthetic_fixture' },
    { task_id: 'UX-06', surface: 'portal', outcome: 'blocked', duration_ms: 51000, step: 'resource_proof', reason_code: 'connectivity_not_tested' },
    { task_id: 'UX-08', surface: 'portal', outcome: 'error', duration_ms: 38000, step: 'return_route', reason_code: 'route_return_pending' },
  ];
  const tenantNames = { global: 'Proveedor · alcance disponible', a: 'Empresa demo A · membership de ejemplo', b: 'Empresa demo B · membership de ejemplo' };
  let persona = personas[params.get('persona')] || personas[scenarios[uxId]?.[0]] || personas.companyAdmin;
  let tenant = params.get('tenant') || persona.tenant;
  let currentPage = params.get('view') || scenarios[uxId]?.[1] || persona.pages[0];
  let state = params.get('state') || 'normal';
  let search = params.get('q') || '';
  let kind = params.get('kind') || 'Todos';
  let auditSearch = '';
  let auditAction = 'Todas';
  let flow = '';
  let flowStep = 1;
  let flowDraft = {};
  let flowStarted = 0;
  let flowError = false;
  let endpointState = 'connected';
  let endpointTimer = null;
  let returnFocus = null;

  function esc(value) { return String(value ?? '').replace(/[&<>"']/gu, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]); }
  function fixture() {
    if (persona.surface === 'provider' && tenant === 'global') return { tenant: 'Alcance de proveedor · fixtures asignados', devices: [...data.a.devices.map(x => ({ ...x, company: 'Empresa demo A' })), ...data.b.devices.map(x => ({ ...x, company: 'Empresa demo B' }))], branches: data.a.branches, policies: data.a.policies, audit: [] };
    return data[tenant === 'b' ? 'b' : 'a'];
  }
  function allowed(permission) { return persona.permissions.includes(permission); }
  function canPage(page) { return persona.pages.includes(page) || page === 'telemetry' && (persona.id === 'companyAdmin' || persona.id === 'auditorExport' || uxId === 'UX-14'); }
  function providerOwner() { return persona.surface === 'provider' && persona.role === 'owner'; }
  function event(message) { const live = $('#live'); live.textContent = ''; requestAnimationFrame(() => { live.textContent = message; }); }
  function status(label, kind = 'info') { return `<span class="badge ${kind}">${esc(label)}</span>`; }
  function source(text, coverage) { return `<div class="freshness">Fuente: ${esc(text)} · corte fijo de fixture: 18:35 CST · cobertura: ${esc(coverage)} · no es telemetría en vivo</div>`; }
  function dataForPage() {
    let items = fixture().devices;
    if (tenant === 'global' && persona.surface === 'provider') items = items.map(item => ({ ...item, site: `${item.site}${item.company ? ` · ${item.company}` : ''}` }));
    return items.filter(item => (kind === 'Todos' || item.kind === kind) && [item.name, item.kind, item.site, item.platform, item.agent, item.vpn, item.resource, item.company].join(' ').toLocaleLowerCase('es').includes(search.trim().toLocaleLowerCase('es')));
  }
  function updateUrl() {
    const url = new URL(location.href);
    url.hash = currentPage;
    for (const key of ['persona', 'tenant', 'view', 'state', 'q', 'kind']) url.searchParams.delete(key);
    url.searchParams.set('persona', persona.id); url.searchParams.set('tenant', tenant); url.searchParams.set('state', state);
    if (search) url.searchParams.set('q', search);
    if (kind !== 'Todos') url.searchParams.set('kind', kind);
    history.replaceState(null, '', url);
  }
  function setPersona(nextId, nextTenant) {
    persona = personas[nextId] || personas.companyAdmin;
    tenant = nextTenant || persona.tenant;
    if (!(persona.surface === 'provider' && persona.role === 'owner') && tenant !== persona.tenant) tenant = persona.tenant;
    search = ''; kind = 'Todos'; auditSearch = ''; auditAction = 'Todas'; state = 'normal';
    currentPage = persona.pages[0];
    render(); event(`Persona de demostración: ${persona.label}. Filtros y selección borrados.`);
  }
  function tenantChoices() {
    if (providerOwner()) return [['global', 'Proveedor · asignaciones autorizadas'], ['a', 'Empresa demo A · asignada'], ['b', 'Empresa demo B · asignada']];
    if (persona.surface === 'provider') return [['a', 'Empresa demo A · asignada']];
    if (persona.surface === 'endpoint') return [['a', 'Empresa demo A · identidad endpoint']];
    return [[persona.tenant, tenantNames[persona.tenant]]];
  }
  function navHtml(targetId) {
    const nav = $(`#${targetId}`);
    const links = persona.pages.map(id => `<a class="nav-link" href="#${id}" data-page="${id}" ${id === currentPage ? 'aria-current="page"' : ''}><span class="nav-symbol" aria-hidden="true">${esc(pages[id]?.[2] || '•')}</span>${esc(pages[id]?.[0] || id)}</a>`);
    if (canPage('telemetry')) links.push(`<a class="nav-link" href="#telemetry" data-page="telemetry" ${currentPage === 'telemetry' ? 'aria-current="page"' : ''}><span class="nav-symbol" aria-hidden="true">◷</span>Revisión UX local</a>`);
    nav.innerHTML = links.join('');
  }
  function shell() {
    const personaSelect = $('#persona');
    personaSelect.replaceChildren(...Object.values(personas).map(item => new Option(item.label, item.id)));
    personaSelect.value = persona.id;
    const choices = tenantChoices();
    if (!choices.some(([value]) => value === tenant)) tenant = choices[0][0];
    $('#tenant').replaceChildren(...choices.map(([value, label]) => new Option(label, value)));
    $('#tenant').value = tenant;
    $('#tenant-wrap').hidden = choices.length === 1;
    $('#scope-note').textContent = providerOwner() ? 'El propietario puede seleccionar solo fixtures asignados; no autentica ni autoriza.' : 'El contexto fijo reproduce una sesión/tenant. Cambiar de persona limpia estado local.';
    $('#sidebar-role').textContent = persona.label;
    $('#mobile-menu-context').textContent = `${persona.label} · ${fixture().tenant}`;
    navHtml('desktop-nav'); navHtml('mobile-nav');
    const page = pages[currentPage] || pages.overview;
    $('#breadcrumb').textContent = `${persona.surface === 'provider' ? 'Proveedor' : persona.surface === 'endpoint' ? 'Endpoint' : 'Empresa'} / ${page[0]}`;
    $('#surface-label').textContent = `${persona.surface} · ${persona.role} · fixture sintético`;
    $('#page-title').textContent = page[0]; $('#page-lede').textContent = page[1];
    const dark = document.documentElement.dataset.theme === 'dark';
    $('#theme-button').textContent = dark ? 'Activar tema claro' : 'Activar tema oscuro';
    $('#theme-button').setAttribute('aria-pressed', String(dark));
    $('#theme-button').setAttribute('aria-label', dark ? 'Cambiar al tema claro' : 'Cambiar al tema oscuro');
    $('#state').value = state;
    pageActions();
  }
  function pageActions() {
    const host = $('#page-actions'); let html = '';
    if (currentPage === 'devices' && persona.surface === 'company') html = allowed('company.agent.invite') ? '<button class="button" type="button" data-action="open-flow" data-flow="direct">Invitar equipo · demo</button>' : status('Solo lectura', '');
    if (currentPage === 'networks' && allowed('company.network.manage')) html = '<button class="button" type="button" data-action="open-flow" data-flow="branch">Revisar alta de sucursal · demo</button>';
    if (currentPage === 'diagnostics' && allowed('company.network.diagnose')) html = '<button class="button" type="button" data-action="diagnostic">Ver resultado sintético</button>';
    if (currentPage === 'companies' && providerOwner()) html = '<button class="button" type="button" data-action="owner-boundary">Crear empresa · vista previa</button>';
    host.innerHTML = html;
  }
  function metric(title, value, explanation, coverage) {
    return `<article class="metric"><label>${esc(title)}</label><strong>${esc(value)}</strong><p>${esc(explanation)}</p><p class="source">Fuente: fixture local · corte 18:35 CST · cobertura: ${esc(coverage)}</p></article>`;
  }
  function overview() {
    const f = fixture(), devices = f.devices;
    const stale = devices.filter(x => /desactualizada|sin observación/iu.test(x.agent)).length;
    const offline = devices.filter(x => /desconectada/iu.test(x.vpn)).length;
    const attention = [...f.branches.filter(x => /pendiente|desactualizada|sin respuesta/iu.test(x.observed)).map(x => ({ name: x.name, detail: `${x.observed}. ${x.next}`, page: 'diagnostics' })), ...devices.filter(x => /desactualizada|sin observación/iu.test(x.agent)).map(x => ({ name: x.name, detail: `Agente: ${x.agent}; observado ${x.seen}.`, page: 'devices' }))];
    return `<section class="callout warn priority"><div><h2>Primero: resolver señales pendientes</h2><p>${attention.length} elementos del fixture requieren revisar evidencia. Un túnel no prueba que el recurso responda.</p></div><button class="button" type="button" data-page="${allowed('company.network.diagnose') ? 'diagnostics' : 'devices'}">Revisar evidencia</button></section>
      <section class="grid grid-4" style="margin-top:13px" aria-label="Indicadores derivados de datos sintéticos">${metric('Equipos en la muestra', String(devices.length), 'No es el total de producción.', `${devices.length} fixtures`)}${metric('Agente con señal reciente', `${devices.length - stale}/${devices.length}`, 'Antigüedad sintética; no equivale a disponibilidad.', 'heartbeat fixture')}${metric('Túneles observados conectados', `${devices.length - offline}/${devices.length}`, 'Separado de ruta, DNS y prueba de aplicación.', 'estado VPN fixture')}${metric('Pendientes de revisar', String(attention.length), 'Señales vencidas o retorno no verificado.', `${devices.length} equipos + ${f.branches.length} perfiles`)}</section>
      <div class="split"><section class="panel"><div class="panel-heading"><div><h2>Problemas y siguiente paso</h2><p>Orden por evidencia pendiente; no se calcula health score.</p></div>${status('Muestra sintética')}</div><ul class="priority-list">${attention.length ? attention.slice(0, 4).map(x => `<li class="priority-item"><div><strong>${esc(x.name)}</strong><p>${esc(x.detail)}</p></div><button class="button secondary" type="button" data-page="${esc(x.page)}">Ver paso siguiente</button></li>`).join('') : '<li class="empty"><h3>Sin pendientes en este fixture</h3><p>Esto no demuestra salud real.</p></li>'}</ul></section>
      <section class="panel"><h2>Capacidades independientes</h2><div class="service-row"><div><strong>VPN privada</strong><p>Estado observado de ejemplo.</p></div>${status('Fixture local')}</div><div class="service-row"><div><strong>Asistencia remota</strong><p>Transporte real no disponible.</p></div>${status('No operativa')}</div><div class="service-row"><div><strong>Respaldos de clientes</strong><p>Módulo posterior; no se presenta un flujo funcional.</p></div>${status('No disponible')}</div></section></div>
      <section class="panel" style="margin-top:14px"><div class="panel-heading"><div><h2>Recorridos habituales</h2><p>Vista previa local; no crea recursos.</p></div></div><div class="grid grid-3"><button class="choice" type="button" data-action="open-flow" data-flow="direct" ${allowed('company.agent.invite') ? '' : 'disabled'}><strong>Añadir equipo con agente</strong><span>Identidad propia; no publica toda la LAN. Requiere company.agent.invite.</span></button><button class="choice" type="button" data-action="open-flow" data-flow="branch" ${allowed('company.network.manage') ? '' : 'disabled'}><strong>Revisar alta de sucursal</strong><span>Gateway, retorno y verificación externa. Requiere company.network.manage.</span></button><button class="choice" type="button" data-page="diagnostics" ${allowed('company.network.diagnose') ? '' : 'disabled'}><strong>Diagnosticar recurso</strong><span>Política y conectividad son resultados diferentes.</span></button></div></section>${source('fixtures de inventario y perfil', `${devices.length} equipos de muestra`)}`;
  }
  function devices() {
    const rows = dataForPage(), all = fixture().devices, canExport = allowed('company.report.export');
    const roleNote = persona.surface === 'provider' ? '<div class="callout"><h3>Ámbito de proveedor asignado</h3><p>El operador/auditor usa solo el fixture asignado; la API real valida role, assignment y scope.</p></div>' : '';
    const exportButton = persona.surface === 'company' ? `<button id="export-devices" class="button secondary" type="button" data-action="export-devices" ${canExport ? '' : 'disabled aria-describedby="export-note"'}>Exportar CSV filtrado</button>` : status('Exportación de proveedor no identificada en este contrato');
    const empty = '<div class="empty"><h2>Sin equipos con estos filtros</h2><p>No se modificó el inventario. Ajusta la búsqueda o restablece.</p><button class="button secondary" type="button" data-action="reset-filters">Restablecer filtros</button></div>';
    return `${roleNote}<section class="panel"><div class="panel-heading"><div><h2>Inventario de la muestra</h2><p>Tabla, contador, URL local y CSV comparten el conjunto filtrado.</p></div>${status('Fixture sintético')}</div><div class="filters"><label class="search-filter">Buscar equipo, sede o estado<input id="device-search" type="search" value="${esc(search)}" placeholder="Ej.: Equipo Demo A-01"></label><label>Tipo<select id="device-kind">${['Todos', 'Usuario', 'Servidor', 'Gateway'].map(x => `<option ${kind === x ? 'selected' : ''}>${x}</option>`).join('')}</select></label><button class="button secondary" type="button" data-action="reset-filters">Restablecer</button>${exportButton}</div><p id="export-note" class="permission-note" ${canExport ? 'hidden' : ''}>Exportar requiere permiso efectivo ` + '<code>company.report.export</code>' + `; el rol no lo concede implícitamente. La UI no sustituye al servidor.</p><p id="device-count" class="result-count" aria-live="polite">${rows.length} de ${all.length} equipos sintéticos</p>
      <div class="table-wrap device-table"><table><caption class="sr-only">Inventario sintético según búsqueda y tipo seleccionados</caption><thead><tr><th scope="col">Equipo y sede</th><th scope="col">Tipo/plataforma</th><th scope="col">Agente</th><th scope="col">VPN</th><th scope="col">Recurso</th><th scope="col">Observación</th><th scope="col">Ficha</th></tr></thead><tbody id="device-rows">${rows.length ? rows.map(row).join('') : `<tr><td colspan="7">${empty}</td></tr>`}</tbody></table></div><div id="device-cards" class="device-cards">${rows.length ? rows.map(card).join('') : empty}</div>${source('agent/heartbeat/profile fixture', `${rows.length} visibles de ${all.length}`)}</section>`;
  }
  function row(item) { return `<tr><td><strong>${esc(item.name)}</strong><br><span class="small">${esc(item.site)}</span></td><td>${esc(item.kind)} · ${esc(item.platform)}</td><td>${status(item.agent, /reciente/iu.test(item.agent) ? 'good' : 'warn')}</td><td>${status(item.vpn, /conectada/iu.test(item.vpn) ? 'info' : 'warn')}</td><td>${status(item.resource, /no comprobado|pendiente|no verificada/iu.test(item.resource) ? 'warn' : '')}</td><td>${esc(item.seen)}</td><td><button class="button secondary" type="button" data-action="device" data-id="${esc(item.id)}">Ver ficha</button></td></tr>`; }
  function card(item) { return `<article class="device-card"><div class="row"><h3>${esc(item.name)}</h3><button class="button secondary" type="button" data-action="device" data-id="${esc(item.id)}">Ver ficha</button></div><p class="small">${esc(item.kind)} · ${esc(item.platform)} · ${esc(item.site)}</p><dl><dt>Agente</dt><dd>${status(item.agent, /reciente/iu.test(item.agent) ? 'good' : 'warn')}</dd><dt>Túnel</dt><dd>${status(item.vpn, /conectada/iu.test(item.vpn) ? 'info' : 'warn')}</dd><dt>Recurso</dt><dd>${status(item.resource, 'warn')}</dd><dt>Observación</dt><dd>${esc(item.seen)}</dd></dl></article>`; }
  function networks() {
    if (!allowed('company.network.read')) return forbidden('Requiere company.network.read.');
    return `<section class="panel"><div class="panel-heading"><div><h2>Perfiles de red sintéticos</h2><p>Deseado, aplicado y observado separados. Nexo no configura routers externos.</p></div>${allowed('company.network.manage') ? '<button class="button" type="button" data-action="open-flow" data-flow="branch">Revisar sucursal · demo</button>' : status('Solo lectura')}</div><div class="grid">${fixture().branches.map(x => `<article class="fixture-card"><div class="panel-heading"><h3>${esc(x.name)}</h3>${status(x.observed, 'warn')}</div><dl class="detail-list"><dt>Red</dt><dd><code>${esc(x.cidr)}</code></dd><dt>Gateway</dt><dd>${esc(x.gateway)}</dd><dt>Deseado</dt><dd>${esc(x.desired)}</dd><dt>Aplicado</dt><dd>${esc(x.applied)}</dd><dt>Observado</dt><dd>${esc(x.observed)}</dd><dt>Recurso</dt><dd>No probado</dd></dl><p class="muted">Siguiente paso: ${esc(x.next)}</p></article>`).join('')}</div><div class="callout warn" style="margin-top:12px"><h3>Retorno de ruta</h3><p>La ruta explícita requiere configuración externa. SNAT privado cambia la IP origen visible para el recurso. Ninguna opción demuestra que una aplicación responda.</p></div><p class="permission-note">Contrato: company.network.manage, <code>POST /v1/company/network-profiles</code>; el servicio valida tenant, sede, gateway, CIDR y campos permitidos. No se envía solicitud desde este prototipo.</p></section>`;
  }
  function policiesView() {
    if (!allowed('company.policy.read')) return forbidden('Requiere company.policy.read.');
    return `<section class="panel"><div class="panel-heading"><div><h2>Reglas de ejemplo</h2><p>Origen → recurso → protocolo/puerto → vigencia.</p></div>${allowed('company.policy.manage') ? '<button class="button" type="button" data-action="open-flow" data-flow="policy">Revisar política · demo</button>' : status('Solo lectura')}</div><div class="grid">${fixture().policies.map(x => `<article class="fixture-card"><div class="panel-heading"><h3>${esc(x.name)}</h3>${status(x.effect, /denegar/iu.test(x.effect) ? 'warn' : 'info')}</div><dl class="detail-list"><dt>Origen</dt><dd>${esc(x.source)}</dd><dt>Destino</dt><dd>${esc(x.resource)}</dd><dt>Servicio</dt><dd>${esc(x.service)}</dd><dt>Vigencia</dt><dd>Fixture, no efectivo</dd></dl></article>`).join('')}</div><p class="permission-note">Mutaciones reales requieren company.policy.manage y control de revisión. La regla de acceso no es prueba de conectividad.</p></section>`;
  }
  function diagnosticSteps() { return [['Identidad y agente', 'Señal del agente según fixture.', 'Señal de ejemplo', 'info'], ['Túnel VPN', 'Estado de transporte separado de la aplicación.', 'Conectada · muestra', 'info'], ['Ruta y retorno', 'El fixture contiene evidencia incompleta.', 'Pendiente', 'warn'], ['DNS privado', 'No se ejecuta consulta DNS.', 'No probado', ''], ['Política', 'Decisión de acceso independiente de la ruta.', 'Decisión sintética', 'warn'], ['Puerto y aplicación', 'El contrato actual informa connectivity: not_tested.', 'No comprobado', '']]; }
  function diagnostics() {
    if (!allowed('company.network.diagnose')) return forbidden('Requiere company.network.diagnose y grant vigente del recurso.');
    return `<section class="panel"><div class="panel-heading"><div><h2>Desglose de diagnóstico</h2><p>No se emite una petición de red desde esta pantalla.</p></div><button class="button secondary" type="button" data-action="diagnostic">Mostrar respuesta sintética</button></div><ol class="step-list">${diagnosticSteps().map(([title, text, badge, color], index) => `<li class="step"><span class="step-num" aria-hidden="true">${index + 1}</span><div><strong>${esc(title)}</strong><p>${esc(text)}</p></div>${status(badge, color)}</li>`).join('')}</ol><div id="diagnostic-result" class="callout"><h3>Resultado de muestra aún no abierto</h3><p>Solo se mostrará un fixture; no se prueban ping, puerto ni aplicación.</p></div><pre id="diagnostic-json" class="freshness" hidden></pre><p class="permission-note">Contrato real: <code>POST /v1/company/network-diagnostics</code>, permiso company.network.diagnose y resource grant. Respuesta tipada: decision/reason/revision/path/return/DNS; <code>connectivity</code> es literalmente <code>not_tested</code>.</p></section>`;
  }
  function auditView() {
    if (persona.surface === 'company' && !allowed('company.audit.read')) return forbidden('Requiere company.audit.read.');
    if (persona.surface === 'provider' && persona.role !== 'owner') return `<section class="panel"><h2>Auditoría asignada</h2><p>El fixture de proveedor no contiene eventos globales autorizados. No se expande el alcance por seleccionar otro menú.</p>${status('Sin eventos sintéticos asignados')}</section>`;
    const items = fixture().audit.filter(x => (auditAction === 'Todas' || x.action === auditAction) && (!auditSearch || `${x.actorUserId || 'Agente/sistema'} ${x.action} ${x.resourceType} ${x.resourceId || ''}`.toLocaleLowerCase('es').includes(auditSearch.toLocaleLowerCase('es'))));
    const canExport = allowed('company.report.export');
    return `<section class="panel"><div class="panel-heading"><div><h2>Eventos de auditoría sintéticos</h2><p>Solo campos presentes en el contrato actual; no se inventan diff, resultado o correlación.</p></div>${status('No es audit log real')}</div><div class="filters"><label class="search-filter">Buscar actor, acción o entidad<input id="audit-search" type="search" value="${esc(auditSearch)}"></label><label>Acción<select id="audit-action"><option>Todas</option>${[...new Set(fixture().audit.map(x => x.action))].map(x => `<option ${x === auditAction ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></label><button class="button secondary" type="button" data-action="export-audit" ${canExport ? '' : 'disabled aria-describedby="audit-permission"'}>Exportar CSV filtrado</button></div><p id="audit-permission" class="permission-note" ${canExport ? 'hidden' : ''}>company.report.export es un permiso separado; no viene por defecto con company.auditor ni company.admin.</p><p id="audit-count" class="result-count" aria-live="polite">${items.length} eventos visibles</p><div class="table-wrap"><table><caption class="sr-only">Campos sintéticos de auditoría visibles para el fixture</caption><thead><tr><th scope="col">Fecha</th><th scope="col">Actor</th><th scope="col">Acción</th><th scope="col">Recurso</th><th scope="col">Identificador</th></tr></thead><tbody id="audit-rows">${auditRows(items)}</tbody></table></div>${source('provider_audit_events/company audit fixtures', `${items.length} eventos visibles`)}<div class="callout warn" style="margin-top:12px"><h3>Faltan contratos para una auditoría enriquecida</h3><p>El modelo actual no aporta operation_id/correlation_id, diff saneado, resultado ni actor origin detallado. Esos campos requieren contrato y política antes de diseñar filtros o afirmarlos.</p></div></section>`;
  }
  function auditRows(items) { return items.length ? items.map(x => `<tr><td>${esc(x.createdAt)}</td><td>${esc(x.actorUserId || 'Agente/sistema')}</td><td><code>${esc(x.action)}</code></td><td>${esc(x.resourceType)}</td><td><code>${esc(x.resourceId || '—')}</code></td></tr>`).join('') : '<tr><td colspan="5">Sin eventos para estos filtros.</td></tr>'; }
  function vpnView() {
    if (persona.surface !== 'provider') return forbidden('Centro de entornos del proveedor; no pertenece al portal empresarial.');
    const rows = tenant === 'global' ? [['Entorno VPN demo A', 'Empresa demo A', 'active · r4', 'r4 · fixture', 'pendiente · recurso no verificado'], ['Entorno VPN demo B', 'Empresa demo B', 'active · r2', 'r1 · fixture', 'observación antigua']] : tenant === 'b' ? [['Entorno VPN demo B', 'Empresa demo B', 'active · r2', 'r1 · fixture', 'observación antigua']] : [['Entorno VPN demo A', 'Empresa demo A', 'active · r4', 'r4 · fixture', 'pendiente · recurso no verificado']];
    return `<section class="panel"><div class="panel-heading"><div><h2>Entornos VPN de muestra</h2><p>Estado deseado, aplicado y observado se mantienen separados.</p></div>${providerOwner() ? status('Acciones owner-only no se ejecutan') : status('Solo lectura · asignación')}</div><div class="table-wrap"><table><caption class="sr-only">Estados y revisiones VPN sintéticas sin material secreto</caption><thead><tr><th scope="col">Entorno</th><th scope="col">Empresa</th><th scope="col">Deseado</th><th scope="col">Aplicado</th><th scope="col">Observado</th><th scope="col">Certificado</th></tr></thead><tbody>${rows.map(x => `<tr>${x.map(value => `<td>${esc(value)}</td>`).join('')}<td>Metadatos no sensibles · fixture</td></tr>`).join('')}</tbody></table></div><div class="callout" style="margin-top:12px"><h3>Sin material criptográfico en UI</h3><p>No se muestran claves privadas, PEM ni tokens. El shell real restringe crear/actualizar estado a provider owner.</p></div><p class="permission-note">Contratos encontrados: GET/POST /v1/provider/vpn-environments y PUT /v1/provider/vpn-environments/:id/state. Este concepto no los invoca.</p></section>`;
  }
  function companiesView() {
    const list = tenant === 'global' ? [['Empresa demo A', 'tenant-a'], ['Empresa demo B', 'tenant-b']] : [[fixture().tenant, `tenant-${tenant}`]];
    return `<section class="panel"><div class="panel-heading"><div><h2>Empresas de demostración</h2><p>Alcance visible dentro de los fixtures autorizados.</p></div>${status(providerOwner() ? 'Propietario · fixture' : 'Asignación · lectura')}</div><div class="grid grid-2">${list.map(([name, id]) => `<article class="fixture-card"><h3>${esc(name)}</h3><p class="muted">Identificador sintético: <code>${esc(id)}</code></p><p>No son clientes reales ni cambia la autorización.</p></article>`).join('')}</div><div class="callout" style="margin-top:12px"><h3>Crear y asignar son owner-only</h3><p>La API verifica providerRole=owner. Este botón de prueba no ejecuta POST.</p></div>${providerOwner() ? '<p><button class="button secondary" type="button" data-action="owner-boundary">Ver límite de autorización</button></p>' : ''}</section>`;
  }
  function servicesView() {
    return `<section class="grid grid-3"><article class="fixture-card"><h3>VPN privada</h3><p>Fixture no conectado; no valida recurso.</p>${status('Estado de ejemplo')}</article><article class="fixture-card"><h3>Asistencia remota</h3><p>Permiso company.support.start no implica transporte desplegado. El server normal puede responder 503 support_transport_disabled.</p>${status('No operativa', 'warn')}</article><article class="fixture-card"><h3>Respaldos de clientes</h3><p>No se identifica un flujo operativo de copia/restauración; un flag de entitlement no confirma operación disponible.</p>${status('Sin acciones operativas', 'warn')}</article></section>`;
  }
  function preferencesView() {
    const dark = document.documentElement.dataset.theme === 'dark';
    return `<section class="grid grid-2"><article class="panel"><h2>Tema de visualización</h2><p>Preferencia local del navegador, no configuración de cuenta.</p><p>Actual: <strong>${dark ? 'oscuro' : 'claro'}</strong></p><button class="button secondary" type="button" data-action="theme">Cambiar tema</button></article><article class="panel"><h2>Foco y movimiento</h2><p>Existe foco visible y se respeta prefers-reduced-motion. Sin auditoría NVDA/VoiceOver en este corte.</p></article><article class="panel"><h2>Marca</h2><p>SYSMedia institucional y Nexo producto; el placeholder no es logo aprobado. Fuente del sistema local.</p></article><article class="panel"><h2>Persistencia</h2><p>Solo tema. Búsquedas y persona de muestra no se guardan en almacenamiento; parámetros de URL son locales y no deben compartirse con datos reales.</p><button class="button ghost" type="button" data-action="clear-theme">Borrar preferencia local</button></article></section>`;
  }
  function endpointView() {
    const states = { connected: ['Conectada · demo', '10.66.4.18 · fixture', '01 h 24 min · fijo'], disconnected: ['Desconectada · demo', '—', '—'], connecting: ['Conectando · demo', '—', '—'], error: ['Error recuperable · demo', '—', '—'] };
    const [label, ip, elapsed] = states[endpointState];
    return `<section class="panel"><div class="panel-heading"><div><h2>Estado local de VPN</h2><p>Máquina de estado única para copy, botón, IP y duración. No controla túnel real.</p></div>${status('Windows · fixture')}</div><div class="callout ${endpointState === 'error' ? 'error' : endpointState === 'connected' ? '' : 'warn'}"><h3>${esc(label)}</h3><p>La simulación no llama a un agente ni a la red.</p></div><dl class="detail-list"><dt>Dirección</dt><dd>${esc(ip)}</dd><dt>Duración</dt><dd>${esc(elapsed)}</dd><dt>Agente</dt><dd>Estado independiente</dd><dt>Acceso al recurso</dt><dd>No comprobado</dd><dt>Internet general</dt><dd>Usa la conexión local · no se configura full-tunnel</dd></dl><button class="button" type="button" data-action="endpoint" ${endpointState === 'connecting' ? 'disabled aria-busy="true"' : ''}>${endpointState === 'connecting' ? '<span class="spinner" aria-hidden="true"></span> Conectando…' : endpointState === 'connected' ? 'Simular desconexión' : 'Simular conexión'}</button>${endpointState === 'error' ? '<div class="error-box" role="alert"><strong>No cambió ningún estado real</strong><p>Fallo sintético; se conservó la pantalla. Puedes reintentar la simulación.</p><button class="button secondary" type="button" data-action="endpoint-retry">Reintentar simulación</button></div>' : ''}</section><section class="grid grid-2" style="margin-top:14px"><article class="fixture-card"><h3>Asistencia remota</h3><p>Sin control para iniciar/aceptar sesión: transporte no está habilitado.</p>${status('No disponible')}</article><article class="fixture-card"><h3>Respaldos</h3><p>Sin acciones de copia o restauración.</p>${status('Módulo posterior')}</article></section>`;
  }
  function telemetryView() {
    const counts = uxEvents.reduce((result, x) => { result[x.outcome] = (result[x.outcome] || 0) + 1; return result; }, {});
    return `<div class="callout"><h2>Instrumentación propuesta · runtime local</h2><p>Los eventos se conservan solo en memoria durante esta pestaña. No hay fetch ni datos de usuario, tenant, equipo, IP, formulario o secretos.</p></div><section class="grid grid-3" style="margin-top:13px">${metric('Eventos en memoria', String(uxEvents.length), 'Fixtures e interacciones sintéticas.', 'sesión local')}${metric('Tareas completadas', String(counts.completed || 0), 'No es una tasa estadística.', 'fixtures UX')}${metric('Bloqueos y errores', String((counts.blocked || 0) + (counts.error || 0)), 'Etapa y razón para investigar.', 'fixtures UX')}</section><section class="panel" style="margin-top:14px"><div class="panel-heading"><div><h2>Resultado por tarea y etapa</h2><p>Ayuda a priorizar fricción sin clasificar personas.</p></div><button class="button secondary" type="button" data-action="add-event">Añadir evento sintético</button></div><div class="table-wrap"><table><caption class="sr-only">Eventos UX sintéticos en la memoria de esta pestaña</caption><thead><tr><th scope="col">Tarea</th><th scope="col">Superficie</th><th scope="col">Resultado</th><th scope="col">Duración</th><th scope="col">Etapa</th><th scope="col">Razón</th></tr></thead><tbody>${uxEvents.map(x => `<tr><td><code>${esc(x.task_id)}</code></td><td>${esc(x.surface)}</td><td>${status(x.outcome, x.outcome === 'completed' ? 'good' : 'warn')}</td><td>${esc(x.duration_ms)} ms</td><td>${esc(x.step)}</td><td><code>${esc(x.reason_code)}</code></td></tr>`).join('')}</tbody></table></div><p class="permission-note">Allowlist: ${ALLOWLIST.map(x => `<code>${x}</code>`).join(', ')}. Producción requiere propósito, privacidad/base legal, retención, muestreo y control de acceso acordados.</p></section>`;
  }
  function forbidden(message = 'Esta persona no puede ver esta vista.') { return `<section class="empty" role="status"><h2>Sin permiso para mostrar esta vista</h2><p>${esc(message)}</p><p>La UI no revela datos fuera del contexto; el servidor debe revalidar cada petición.</p></section>`; }
  function pageContent() {
    if (!canPage(currentPage)) return forbidden();
    switch (currentPage) {
      case 'overview': return overview(); case 'companies': return companiesView(); case 'devices': return devices(); case 'networks': return networks(); case 'policies': return policiesView(); case 'diagnostics': return diagnostics(); case 'vpn': return vpnView(); case 'audit': return auditView(); case 'services': return servicesView(); case 'preferences': return preferencesView(); case 'endpoint': return endpointView(); case 'telemetry': return telemetryView(); default: return forbidden();
    }
  }
  function renderState() {
    const region = $('#state-region'), content = $('#content');
    if (state === 'forbidden') { region.innerHTML = ''; content.innerHTML = '<section class="empty" role="status"><h2>Sin permiso para mostrar los datos</h2><p>403 forbidden · estado ilustrativo, no respuesta del servidor.</p><p>La solicitud real debe comprobar permiso, tenant, recurso y resource grant vigentes.</p></section>'; return; }
    if (state === 'loading') { region.innerHTML = '<div class="panel" role="status" aria-busy="true"><span class="spinner" aria-hidden="true"></span> Cargando fixture…</div>'; content.innerHTML = '<div class="panel" aria-hidden="true"><span class="small">Cargando la muestra</span></div>'; return; }
    if (state === 'empty') { region.innerHTML = ''; content.innerHTML = `<section class="empty"><h2>Sin registros en el estado seleccionado</h2><p>${allowed('company.agent.invite') ? 'El rol puede abrir una vista previa; ningún registro se crea.' : 'No se inventa una acción permitida para esta persona.'}</p>${allowed('company.agent.invite') ? '<button class="button" type="button" data-action="open-flow" data-flow="direct">Revisar alta · demo</button>' : ''}</section>`; return; }
    content.innerHTML = pageContent();
    if (state === 'error') region.innerHTML = '<div class="callout error" role="alert"><h2>No se pudo actualizar la vista sintética</h2><p>No se envió ningún cambio. Se conserva el fixture y los filtros; puedes volver a renderizar localmente.</p><button class="button secondary" type="button" data-action="retry">Reintentar vista local</button></div>';
    else if (state === 'stale') region.innerHTML = '<div class="callout warn" role="status"><h2>Observación vencida · estado de revisión</h2><p>No trates el fixture como dato actual. El producto debe mostrar fuente, corte, alcance y regla de frescura; el estado no se interpreta como verde.</p></div>';
    else region.innerHTML = '';
  }
  function render() {
    if (!canPage(currentPage)) currentPage = persona.pages[0];
    shell(); renderState(); updateUrl();
  }
  function navigate(page, trigger) {
    if (!canPage(page)) { $('#content').innerHTML = forbidden(); $('#state-region').innerHTML = ''; event('Sin permiso para mostrar esta vista.'); return; }
    currentPage = page; render();
    if (trigger && matchMedia('(max-width: 860px)').matches) { returnFocus = $('#main'); $('#mobile-menu').close(); }
    $('#main').focus({ preventScroll: false }); event(`${pages[page]?.[0] || page} cargada para ${persona.label}.`);
  }
  function filteredAudit() {
    return fixture().audit.filter(x => (auditAction === 'Todas' || x.action === auditAction) && (!auditSearch || `${x.actorUserId || 'Agente/sistema'} ${x.action} ${x.resourceType} ${x.resourceId || ''}`.toLocaleLowerCase('es').includes(auditSearch.toLocaleLowerCase('es'))));
  }
  function updateFilters() {
    search = $('#device-search')?.value || ''; kind = $('#device-kind')?.value || 'Todos';
    const items = dataForPage(); const body = $('#device-rows'), cards = $('#device-cards');
    const empty = '<div class="empty"><h2>Sin equipos con estos filtros</h2><p>El inventario no se modificó.</p><button class="button secondary" type="button" data-action="reset-filters">Restablecer filtros</button></div>';
    if (body) body.innerHTML = items.length ? items.map(row).join('') : `<tr><td colspan="7">${empty}</td></tr>`;
    if (cards) cards.innerHTML = items.length ? items.map(card).join('') : empty;
    if ($('#device-count')) $('#device-count').textContent = `${items.length} de ${fixture().devices.length} equipos sintéticos`;
    updateUrl(); event(`${items.length} equipos sintéticos visibles.`);
  }
  function csvCell(value) { let text = String(value ?? ''); if (/^[=+\-@\t\r]/u.test(text)) text = `'${text}`; return `"${text.replace(/"/gu, '""')}"`; }
  function csv(filename, headings, rows) {
    const text = '\ufeff' + [headings, ...rows].map(line => line.map(csvCell).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function exportDevices() {
    if (!allowed('company.report.export')) { event('Exportación denegada por permisos del fixture.'); return; }
    const visible = dataForPage(); csv('nexo-fixture-dispositivos-filtrados.csv', ['Equipo', 'Tipo', 'Sede', 'Agente', 'VPN', 'Recurso', 'Observado'], visible.map(x => [x.name, x.kind, x.site, x.agent, x.vpn, x.resource, x.seen]));
    event(`CSV local con ${visible.length} filas sintéticas y filtros actuales.`);
  }
  function exportAudit() {
    if (!allowed('company.report.export') || !allowed('company.audit.read')) { event('Exportación denegada para este fixture.'); return; }
    csv('nexo-fixture-auditoria-filtrada.csv', ['Fecha', 'Actor', 'Acción', 'Recurso', 'Identificador'], filteredAudit().map(x => [x.createdAt, x.actorUserId || 'Agente/sistema', x.action, x.resourceType, x.resourceId || '']));
    event(`CSV local con ${filteredAudit().length} eventos sintéticos.`);
  }
  function openDialog(id, trigger) {
    const dialog = $(`#${id}`); if (!dialog || dialog.open) return;
    const usableTrigger = trigger instanceof HTMLElement && trigger.matches('button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    returnFocus = usableTrigger ? trigger : document.activeElement;
    dialog.showModal();
    ($('button:not([disabled]), input:not([disabled]), select:not([disabled]), a[href]', dialog) || dialog).focus();
  }
  function openDevice(id, trigger) {
    const device = fixture().devices.find(x => x.id === id); if (!device || !allowed('company.device.read') && persona.surface === 'company') return;
    $('#device-title').textContent = device.name; $('#device-subtitle').textContent = `${device.kind} · ${device.site} · ${fixture().tenant}`;
    $('#device-detail').innerHTML = `<dl class="detail-list"><dt>Plataforma</dt><dd>${esc(device.platform)}</dd><dt>Agente</dt><dd>${status(device.agent, /reciente/iu.test(device.agent) ? 'good' : 'warn')}</dd><dt>Fuente</dt><dd>${esc(device.source)}</dd><dt>Última observación</dt><dd>${esc(device.seen)}</dd><dt>Túnel VPN</dt><dd>${status(device.vpn)}</dd><dt>Ruta/retorno</dt><dd>${esc(device.resource)}</dd><dt>Aplicación</dt><dd>No comprobada</dd><dt>Tenant</dt><dd>${esc(fixture().tenant)}</dd></dl><div class="callout warn"><h3>No inferir disponibilidad</h3><p>VPN observada no significa que el recurso responda. El diagnóstico devuelve <code>connectivity: not_tested</code>.</p></div><p>${allowed('company.network.diagnose') ? '<button class="button" type="button" data-action="device-diagnostic">Abrir desglose sintético</button>' : '<span class="badge">Diagnóstico no concedido</span>'}</p>`;
    openDialog('device-dialog', trigger);
  }
  function openFlow(type, trigger) {
    if ((type === 'direct' && !allowed('company.agent.invite')) || (type === 'branch' && !allowed('company.network.manage')) || (type === 'policy' && !allowed('company.policy.manage'))) { event('Permiso insuficiente; no se inició el flujo.'); return; }
    flow = type; flowStep = 1; flowDraft = {}; flowError = false; flowStarted = performance.now();
    openDialog('flow-dialog', trigger); renderFlow();
  }
  function flowTitle() { return flow === 'branch' ? 'Conectar una sucursal · demo' : flow === 'policy' ? 'Definir política · demo' : 'Añadir equipo directo · demo'; }
  function readFlow() {
    const root = $('#flow-content');
    return Object.fromEntries(['name', 'site', 'uses', 'environment', 'gateway', 'returnMode', 'dnsMode', 'source', 'resource', 'protocol', 'portStart', 'portEnd', 'effect', 'policyStatus'].map(key => [key, $(`[name="${key}"]`, root)?.value || '']));
  }
  function renderFlow() {
    $('#flow-title').textContent = flowTitle();
    $('#flow-lede').textContent = flow === 'branch'
      ? 'El gateway atiende recursos LAN. Este prototipo muestra el perfil; el alta de sede/red es otra operación.'
      : flow === 'policy'
        ? 'Origen, recurso, protocolo, puerto y estado tipado; denegar por defecto.'
        : 'Invitación endpoint con alcance y usos; nombre e identidad se completan durante enrollment.';
    const labels = ['Datos de alcance', 'Revisión previa', 'Resultado de la simulación'];
    $('#flow-progress').textContent = `Paso ${Math.min(flowStep, 3)} de 3 · ${labels[Math.min(flowStep - 1, 2)]}`;
    const root = $('#flow-content');
    if (flowStep === 1) {
      const fields = flow === 'branch' ? `
        <label class="field">Sede ya declarada<select name="site" required><option value="site-demo-a">Sucursal demo A · 10.30.0.0/24</option><option value="site-demo-b">Sucursal demo B · 10.31.0.0/24</option></select></label>
        <label class="field">Entorno VPN autorizado<input name="environment" required value="vpn-environment-demo"></label>
        <label class="field">Nombre del perfil<input name="name" maxlength="120" required value="Perfil de sucursal demo"></label>
        <label class="field">Gateway aprobado en la sede<select name="gateway" required><option value="gateway-demo-a">Gateway Demo A-01</option><option value="gateway-demo-b">Gateway Demo B-01</option></select></label>
        <label class="field">Retorno<select name="returnMode"><option value="routed">Ruta explícita en router externo</option><option value="snat">SNAT privado</option></select></label>
        <label class="field">DNS<select name="dnsMode"><option value="split">Split DNS</option><option value="local">DNS local</option></select></label>
        <div id="return-note" class="callout warn"><h3>Ruta externa</h3><p>La ruta se configura fuera de Nexo; no está aplicada. El CIDR se declara en la sede.</p></div>`
        : flow === 'policy' ? `
        <label class="field">Nombre de regla<input name="name" maxlength="120" required value="Regla de acceso demo"></label>
        <label class="field">Origen<select name="source"><option value="device">Endpoint aprobado específico</option><option value="any_endpoint">Cualquier endpoint · revisar alcance</option></select></label>
        <label class="field">Recurso privado<select name="resource"><option value="resource-demo-erp">ERP demo</option><option value="resource-demo-files">Archivos demo</option></select></label>
        <label class="field">Protocolo<select name="protocol"><option value="tcp">TCP</option><option value="udp">UDP</option></select></label>
        <label class="field">Puerto inicial<input name="portStart" type="number" min="1" max="65535" required value="443"></label>
        <label class="field">Puerto final<input name="portEnd" type="number" min="1" max="65535" required value="443"></label>
        <label class="field">Efecto<select name="effect"><option value="allow">Permitir</option><option value="deny">Denegar</option></select></label>
        <label class="field">Estado<select name="policyStatus"><option value="draft">Borrador</option><option value="active">Activo</option><option value="retired">Retirado</option></select></label>
        <div class="callout warn"><h3>Denegar por defecto</h3><p>El API valida tenant/recurso, origen y endpoint aprobado. Estado activo no equivale a una expiración.</p></div>`
        : `
        <label class="field">Sede de la invitación<select name="site" required><option value="site-demo-a">Sede de ejemplo A</option><option value="site-demo-b">Sucursal de ejemplo B</option></select></label>
        <label class="field">Usos máximos<input name="uses" type="number" min="1" max="100" required value="1"><span class="small">El endpoint devuelve un token de invitación; vence en 15 minutos. Nunca se registra en telemetría.</span></label>
        <div class="callout"><h3>Enrollment ocurre en el equipo</h3><p>El endpoint entrega su nombre y clave pública; luego queda pending_approval. Este prototipo no crea ni muestra token.</p></div>`;
      root.innerHTML = `<div class="grid">${fields}${flowError ? '<div class="error-box" role="alert"><strong>Error sintético</strong><p>No se envió nada; los valores se conservan. Reconciliar cualquier resultado antes de reintentar en un flujo real.</p></div>' : ''}</div><div class="dialog-actions"><button class="button ghost" type="button" data-action="cancel-flow">Cancelar sin aplicar</button><div class="right"><button class="button" type="button" data-action="flow-next">Revisar alcance</button></div></div>`;
      for (const [key, value] of Object.entries(flowDraft)) { const input = $(`[name="${key}"]`, root); if (input) input.value = value; }
      if (flow === 'branch' && flowDraft.returnMode === 'snat') $('#return-note').innerHTML = '<h3>SNAT privado</h3><p>El recurso verá la IP del gateway. Esto no indica que se haya aplicado.</p>';
    } else if (flowStep === 2) {
      const values = flowDraft;
      const pairs = flow === 'branch'
        ? [['Sede existente', values.site], ['Entorno VPN', values.environment], ['Perfil', values.name], ['Gateway', values.gateway], ['Retorno', values.returnMode === 'snat' ? 'SNAT: el recurso ve IP del gateway' : 'Ruta en router externo'], ['DNS', values.dnsMode], ['Red privada', 'Declarada en la sede, no en este perfil'], ['Conectividad', 'No probada']]
        : flow === 'policy'
          ? [['Regla', values.name], ['Origen', values.source], ['Recurso', values.resource], ['Protocolo', values.protocol], ['Puertos', `${values.portStart}–${values.portEnd}`], ['Efecto/estado', `${values.effect} / ${values.policyStatus}`]]
          : [['Tipo de invitación', 'endpoint'], ['Sede', values.site], ['Usos', `${values.uses || 1} · máximo 100`], ['Caducidad', '15 minutos según contrato'], ['Nombre/clave', 'Se suministran durante enrollment; sin token en esta pantalla']];
      root.innerHTML = `<div class="callout warn"><h3>Revisión previa · nada se ha enviado</h3><p>Confirma el alcance y sus consecuencias antes de cualquier operación real.</p></div><dl class="detail-list">${pairs.map(([key, value]) => `<dt>${esc(key)}</dt><dd>${esc(value || '—')}</dd>`).join('')}</dl><div class="callout"><h3>Contrato de seguridad</h3><p>Permiso efectivo, tenant y recurso, validación server-side. No se inventa operation ID ni garantía de idempotencia.</p></div>${flowError ? '<div class="error-box" role="alert"><strong>Respuesta no disponible · simulada</strong><p>Se conservaron valores; reintentar no crea una operación.</p><button class="button secondary" type="button" data-action="flow-retry">Volver a editar</button></div>' : ''}<div class="dialog-actions"><button class="button ghost" type="button" data-action="flow-back">Volver a editar</button><div class="right"><button class="button secondary" type="button" data-action="flow-error">Ver recuperación de error</button><button class="button" type="button" data-action="flow-complete">Finalizar simulación</button></div></div>`;
    } else {
      root.innerHTML = `<div class="callout"><h3>Vista previa terminada · sin cambios</h3><p>No se creó endpoint, invitación, perfil o política. No hubo petición al servidor.</p></div><p class="permission-note">Antes de integrar: autorización por recurso, validación del servidor, y reconciliación/idempotencia según el endpoint. Sin identificador de operación fabricado.</p><div class="dialog-actions"><button class="button secondary" type="button" data-action="flow-back">Ver resumen</button><div class="right"><button class="button" type="button" data-action="flow-close">Cerrar sin aplicar</button></div></div>`;
    }
  }
  function logUx(task, outcome, step, duration, reason = 'prototype_interaction') {
    const item = { task_id: task, surface: persona.surface, outcome, duration_ms: Math.max(0, Math.round(duration)), step, reason_code: reason };
    if (Object.keys(item).every(key => ALLOWLIST.includes(key))) uxEvents.unshift(item);
    if (uxEvents.length > 40) uxEvents.pop();
  }
  function diagnosticResult() {
    const result = $('#diagnostic-result'), json = $('#diagnostic-json');
    if (result) result.innerHTML = '<h3>Respuesta sintética del endpoint</h3><p>decision: deny · reason: configuration_pending · revision: 4. <strong>connectivity: not_tested.</strong> No se probaron DNS, puerto, recurso ni aplicación.</p>';
    if (json) { json.hidden = false; json.textContent = JSON.stringify({ decision: 'deny', reason: 'configuration_pending', connectivity: 'not_tested', profileRevision: 4, pathMode: 'gateway', returnMode: 'routed', dnsMode: 'split' }, null, 2); }
    logUx('UX-06', 'blocked', 'resource_proof', performance.now() - flowStarted, 'connectivity_not_tested'); event('Conectividad no probada. Resultado solo sintético.');
  }
  function actions(eventObject) {
    const button = eventObject.target.closest('[data-action]'); if (!button) return;
    const action = button.dataset.action;
    if (action === 'open-flow') openFlow(button.dataset.flow, button);
    else if (action === 'device') openDevice(button.dataset.id, button);
    else if (action === 'reset-filters') { search = ''; kind = 'Todos'; render(); event('Filtros locales restablecidos.'); }
    else if (action === 'export-devices') exportDevices();
    else if (action === 'export-audit') exportAudit();
    else if (action === 'diagnostic') diagnosticResult();
    else if (action === 'device-diagnostic') { $('#device-dialog').close(); currentPage = 'diagnostics'; render(); diagnosticResult(); }
    else if (action === 'theme') toggleTheme();
    else if (action === 'clear-theme') { try { localStorage.removeItem('nexo-prototype-theme'); } catch {} document.documentElement.dataset.theme = 'light'; render(); }
    else if (action === 'retry') { state = 'normal'; render(); event('Vista local restaurada; no se consultó servicio.'); }
    else if (action === 'owner-boundary') { $('#content').insertAdjacentHTML('afterbegin', '<div class="callout warn" role="status"><h2>Acción no enviada</h2><p>provider owner es requisito real. El prototipo no invoca POST ni altera datos.</p></div>'); }
    else if (action === 'flow-error') { if (flowStep === 1) flowDraft = readFlow(); flowError = true; renderFlow(); event('Error sintético; los campos siguen en memoria.'); }
    else if (action === 'flow-retry') { flowError = false; flowStep = 1; renderFlow(); }
    else if (action === 'flow-next') {
      const inputs = $$('input[required], select[required]', $('#flow-content'));
      if (!inputs.every(input => input.reportValidity())) return;
      if (flow === 'branch' && ($('#flow-content [name="site"]').value.endsWith('-a') !== $('#flow-content [name="gateway"]').value.endsWith('-a'))) { event('El gateway seleccionado no pertenece a la sede del fixture.'); return; }
      if (flow === 'policy' && Number($('#flow-content [name="portEnd"]').value) < Number($('#flow-content [name="portStart"]').value)) { const end = $('#flow-content [name="portEnd"]'); end.setCustomValidity('El puerto final debe ser igual o mayor al inicial.'); end.reportValidity(); end.setCustomValidity(''); return; }
      flowDraft = readFlow(); flowStep = 2; flowError = false; renderFlow();
    }
    else if (action === 'flow-back') { flowStep = Math.max(1, flowStep - 1); flowError = false; renderFlow(); }
    else if (action === 'flow-complete') { flowStep = 3; flowError = false; logUx('UX-09', 'completed', 'preview', performance.now() - flowStarted, 'prototype_only'); renderFlow(); event('Simulación terminada sin operación real.'); }
    else if (action === 'flow-close') $('#flow-dialog').close();
    else if (action === 'cancel-flow') { logUx('UX-09', 'cancelled', `step_${flowStep}`, performance.now() - flowStarted, 'cancelled_before_submit'); $('#flow-dialog').close(); event('Cancelado sin cambios.'); }
    else if (action === 'endpoint') endpointTransition();
    else if (action === 'endpoint-retry') { endpointState = 'disconnected'; render(); }
    else if (action === 'add-event') { logUx('UX-14', 'completed', 'prototype_interaction', 1200, 'synthetic_fixture'); render(); event('Evento guardado solo en memoria local.'); }
  }
  function endpointTransition() {
    if (endpointTimer) clearTimeout(endpointTimer);
    endpointState = 'connecting'; render();
    endpointTimer = setTimeout(() => { endpointState = params.get('demoEndpointError') === '1' ? 'error' : 'connected'; render(); logUx('UX-12', endpointState === 'error' ? 'error' : 'completed', 'vpn_state', 450, 'synthetic_transition'); event(`Estado de ejemplo: ${endpointState}.`); }, 450);
  }
  function toggleTheme() {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('nexo-prototype-theme', next); } catch { /* storage may be disabled */ }
    render(); event(`Tema ${next} seleccionado.`);
  }
  function navClick(eventObject) {
    const link = eventObject.target.closest('[data-page]'); if (!link) return;
    eventObject.preventDefault(); navigate(link.dataset.page, link);
  }
  $('#persona').addEventListener('change', eventObject => setPersona(eventObject.target.value, personas[eventObject.target.value].tenant));
  $('#tenant').addEventListener('change', eventObject => { if (providerOwner()) { tenant = eventObject.target.value; search = ''; kind = 'Todos'; currentPage = 'overview'; render(); event('Contexto cambiado; búsqueda, selección y contenido del ámbito anterior descartados.'); } });
  $('#state').addEventListener('change', eventObject => { state = eventObject.target.value; render(); event(`Estado de revisión: ${state}.`); });
  $('#theme-button').addEventListener('click', toggleTheme);
  $('#desktop-nav').addEventListener('click', navClick); $('#mobile-nav').addEventListener('click', navClick);
  $('#content').addEventListener('click', eventObject => { const page = eventObject.target.closest('[data-page]'); if (page) { eventObject.preventDefault(); navigate(page.dataset.page, page); return; } actions(eventObject); });
  $('#content').addEventListener('input', eventObject => {
    if (eventObject.target.id === 'device-search') updateFilters();
    if (eventObject.target.id === 'audit-search') { auditSearch = eventObject.target.value; const items = filteredAudit(); $('#audit-rows').innerHTML = auditRows(items); $('#audit-count').textContent = `${items.length} eventos visibles`; }
  });
  $('#content').addEventListener('change', eventObject => {
    if (eventObject.target.id === 'device-kind') updateFilters();
    if (eventObject.target.id === 'audit-action') { auditAction = eventObject.target.value; render(); }
  });
  $('#flow-content').addEventListener('input', eventObject => {
    if (eventObject.target.name === 'returnMode') { const note = $('#return-note'); if (note) note.innerHTML = eventObject.target.value === 'snat' ? '<h3>SNAT privado</h3><p>El recurso verá la IP del gateway. Esto no indica que se haya aplicado.</p>' : '<h3>Ruta externa</h3><p>La ruta se configura fuera de Nexo; no se declara aplicada.</p>'; }
  });
  $('#flow-content').addEventListener('change', eventObject => {
    if (flow === 'branch' && eventObject.target.name === 'site') { const gateway = $('[name="gateway"]', $('#flow-content')); gateway.value = eventObject.target.value.endsWith('-b') ? 'gateway-demo-b' : 'gateway-demo-a'; }
  });
  $('#flow-content').addEventListener('click', actions);
  $('#menu-button').addEventListener('click', eventObject => { $('#menu-button').setAttribute('aria-expanded', 'true'); openDialog('mobile-menu', eventObject.currentTarget); });
  for (const dialog of $$('dialog')) {
    dialog.addEventListener('click', eventObject => { if (eventObject.target === dialog) dialog.close(); const close = eventObject.target.closest('[data-close]'); if (close) dialog.close(); });
    dialog.addEventListener('close', () => { if (dialog.id === 'mobile-menu') $('#menu-button').setAttribute('aria-expanded', 'false'); if (returnFocus?.isConnected) returnFocus.focus(); returnFocus = null; });
  }
  function maybeOpenScenario() {
    const [scenarioPersona, scenarioPage] = scenarios[uxId] || [];
    if (scenarioPersona && !params.has('persona')) persona = personas[scenarioPersona];
    tenant = params.get('tenant') || persona.tenant;
    currentPage = params.get('view') || scenarioPage || persona.pages[0];
    const dark = params.get('theme') || (() => { try { return localStorage.getItem('nexo-prototype-theme'); } catch { return null; } })() || 'light';
    document.documentElement.dataset.theme = dark;
    state = params.get('state') || 'normal'; search = params.get('q') || ''; kind = params.get('kind') || 'Todos';
    render();
    if (uxId === 'UX-02' && matchMedia('(max-width: 860px)').matches) requestAnimationFrame(() => $('#menu-button').click());
    if (uxId === 'UX-05' || uxId === 'UX-08') requestAnimationFrame(() => {
      const id = tenant === 'b' ? 'b1' : 'a1';
      const triggerSelector = matchMedia('(max-width: 860px)').matches ? `#device-cards [data-id="${id}"]` : `.device-table [data-id="${id}"]`;
      openDevice(id, $(triggerSelector));
    });
    if (uxId === 'UX-09') requestAnimationFrame(() => openFlow('direct', $('#page-actions button')));
  }
  maybeOpenScenario();
})();
