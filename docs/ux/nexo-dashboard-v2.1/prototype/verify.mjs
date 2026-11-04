import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../..');
const indexUrl = pathToFileURL(join(here, 'index.html')).href;
const output = join(root, 'docs/ux/nexo-dashboard-v2.1/screenshots/after');
const widthCases = [320, 768, 1440];
const taskIds = Array.from({ length: 14 }, (_, index) => `UX-${String(index + 1).padStart(2, '0')}`);
const profile = mkdtempSync(join(tmpdir(), 'nexo-ux-v21-chrome-'));
const executable = process.env.CHROMIUM || 'chromium';
const browser = spawn(executable, [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', '--remote-allow-origins=*',
  `--user-data-dir=${profile}`, 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });

const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));
const assertions = [];
const runtimeExceptions = [];
const externalRequests = [];
let socket;
let nextCommandId = 0;
const pending = new Map();
let browserLog = '';

function check(name, pass, detail = '') {
  assertions.push({ name, result: pass ? 'PASS' : 'FAIL', ...(detail ? { detail } : {}) });
  if (!pass) console.error(`FAIL ${name}${detail ? `: ${detail}` : ''}`);
}

function skip(name, reason) {
  assertions.push({ name, result: 'SKIP', detail: reason });
  console.warn(`SKIP ${name}: ${reason}`);
}

async function keyPress(key, code, windowsVirtualKeyCode) {
  const type = key === 'Enter' ? 'rawKeyDown' : 'keyDown';
  await send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode });
  if (key === 'Enter') await send('Input.dispatchKeyEvent', { type: 'char', key, code, text: '\r', unmodifiedText: '\r', windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode });
}

async function openDevTools() {
  let port;
  const listening = new Promise(resolveListening => {
    browser.stderr.on('data', chunk => {
      browserLog += chunk.toString();
      const match = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//u.exec(browserLog);
      if (match) resolveListening(Number(match[1]));
    });
  });
  port = await Promise.race([listening, delay(12000).then(() => undefined)]);
  if (!port) throw new Error(`Chromium no abrió DevTools dentro del timeout. ${browserLog.slice(-500)}`);
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json());
  const target = targets.find(item => item.type === 'page');
  if (!target?.webSocketDebuggerUrl) throw new Error('No se encontró la pestaña Chromium.');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolveOpen, rejectOpen) => {
    socket.addEventListener('open', resolveOpen, { once: true });
    socket.addEventListener('error', rejectOpen, { once: true });
  });
  socket.addEventListener('message', eventMessage => {
    const message = JSON.parse(eventMessage.data);
    if (message.id) {
      const waiter = pending.get(message.id);
      if (waiter) {
        pending.delete(message.id);
        if (message.error) waiter.reject(new Error(message.error.message));
        else waiter.resolve(message.result || {});
      }
    } else if (message.method === 'Runtime.exceptionThrown') {
      runtimeExceptions.push(message.params.exceptionDetails?.text || 'JavaScript exception');
    } else if (message.method === 'Network.requestWillBeSent' && /^https?:/u.test(message.params.request.url)) {
      externalRequests.push(message.params.request.url);
    }
  });
  return port;
}

function send(method, params = {}) {
  const id = ++nextCommandId;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolveResult, rejectResult) => pending.set(id, { resolve: resolveResult, reject: rejectResult }));
}

async function evaluate(expression) {
  const response = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.text || 'Runtime.evaluate failed');
  return response.result?.value;
}

async function setViewport(width, height = 1024) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width <= 560 });
}

async function navigate(url, width = 1440) {
  await setViewport(width);
  await send('Page.navigate', { url });
  for (let attempt = 0; attempt < 30; attempt++) {
    await delay(100);
    const ready = await evaluate('document.readyState === "complete" && Boolean(document.querySelector("#page-title")?.textContent)');
    if (ready) break;
  }
  await delay(100);
}

async function capture(taskId, width, theme) {
  const url = `${indexUrl}?ux=${taskId}&theme=${theme}`;
  await navigate(url, width);
  const state = await evaluate(`(() => ({
    title: document.querySelector('#page-title')?.textContent,
    width: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    menuOpen: document.querySelector('#mobile-menu').open,
    menuExpanded: document.querySelector('#menu-button').getAttribute('aria-expanded'),
    deviceOpen: document.querySelector('#device-dialog').open,
    flowOpen: document.querySelector('#flow-dialog').open,
    mobileLinks: document.querySelectorAll('#mobile-nav [data-page]').length,
    mobileActiveColor: getComputedStyle(document.querySelector('#mobile-nav [aria-current="page"]') || document.querySelector('#mobile-nav a')).color,
    contextOverlap: (() => {
      const nodes = [document.querySelector('#persona').closest('.field'), document.querySelector('#tenant-wrap'), document.querySelector('#scope-note')]
        .filter(node => node && !node.hidden && node.getClientRects().length)
        .map(node => { const rect = node.getBoundingClientRect(); return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }; });
      return nodes.some((a, index) => nodes.slice(index + 1).some(b => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom));
    })(),
    theme: document.documentElement.dataset.theme
  }))()`);
  check(`${taskId} ${width}px ${theme}: rendered heading`, Boolean(state.title), JSON.stringify(state));
  check(`${taskId} ${width}px ${theme}: no page horizontal overflow`, state.scrollWidth <= width, `scrollWidth=${state.scrollWidth}; viewport=${width}`);
  check(`${taskId} ${width}px ${theme}: scope controls and context note do not overlap`, !state.contextOverlap);
  check(`${taskId} ${width}px ${theme}: expected theme`, state.theme === theme, state.theme);
  if (taskId === 'UX-02' && width <= 860) {
    check(`${taskId} ${width}px ${theme}: mobile menu opens`, state.menuOpen && state.menuExpanded === 'true');
    check(`${taskId} ${width}px ${theme}: mobile links have visible contrast color`, state.mobileLinks > 1 && state.mobileActiveColor !== 'rgb(255, 255, 255)', JSON.stringify({ links: state.mobileLinks, color: state.mobileActiveColor }));
  }
  if (['UX-05', 'UX-08'].includes(taskId)) check(`${taskId} ${width}px ${theme}: device dialog opens`, state.deviceOpen);
  if (taskId === 'UX-09') check(`${taskId} ${width}px ${theme}: enrollment wizard opens`, state.flowOpen);
  const image = await send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
  const filename = `${taskId}-${width}-${theme}.png`;
  writeFileSync(join(output, filename), Buffer.from(image.data, 'base64'));
}

async function keyboardAndContracts() {
  await navigate(`${indexUrl}?ux=UX-03&theme=light`, 1440);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
  const skipFocus = await evaluate('({className:document.activeElement.className,text:document.activeElement.textContent.trim()})');
  check('Keyboard: first Tab exposes skip link', skipFocus.className.includes('skip-link') && skipFocus.text === 'Saltar al contenido principal', JSON.stringify(skipFocus));

  await navigate(`${indexUrl}?ux=UX-02&theme=light`, 320);
  let menu = await evaluate('({open:document.querySelector("#mobile-menu").open,focusInDialog:Boolean(document.activeElement.closest("#mobile-menu")),expanded:document.querySelector("#menu-button").getAttribute("aria-expanded")})');
  check('Keyboard: mobile menu opens modally and focuses inside', menu.open && menu.focusInDialog && menu.expanded === 'true', JSON.stringify(menu));
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await delay(120);
  menu = await evaluate('({open:document.querySelector("#mobile-menu").open,focus:document.activeElement.id,expanded:document.querySelector("#menu-button").getAttribute("aria-expanded")})');
  check('Keyboard: Escape closes mobile menu and restores trigger focus', !menu.open && menu.focus === 'menu-button' && menu.expanded === 'false', JSON.stringify(menu));
  await keyPress('Enter', 'Enter', 13);
  menu = await evaluate('({open:document.querySelector("#mobile-menu").open,expanded:document.querySelector("#menu-button").getAttribute("aria-expanded")})');
  check('Keyboard: Enter reopens mobile menu from restored trigger', menu.open && menu.expanded === 'true', JSON.stringify(menu));
  let deviceLinkFocused = false;
  const menuFocusTrace = [];
  for (let index = 0; index < 12; index++) {
    await keyPress('Tab', 'Tab', 9);
    const focus = await evaluate('({inside:Boolean(document.activeElement.closest("#mobile-menu")),page:document.activeElement.dataset.page,tag:document.activeElement.tagName})');
    menuFocusTrace.push(focus);
    if (focus.page === 'devices') { deviceLinkFocused = true; break; }
  }
  const trapped = await evaluate('Boolean(document.activeElement.closest("#mobile-menu"))');
  check('Keyboard: Tab reaches a route and stays within native menu dialog', trapped && deviceLinkFocused, JSON.stringify(menuFocusTrace));
  if (deviceLinkFocused) {
    await keyPress('Enter', 'Enter', 13);
  } else {
    skip('Keyboard: Enter activates mobile route and restores focus to main', 'Tab no alcanzó el enlace Dispositivos.');
  }
  await delay(100);
  const navigation = await evaluate('({open:document.querySelector("#mobile-menu").open,title:document.querySelector("#page-title").textContent,focus:document.activeElement.id,aria:document.querySelector("#menu-button").getAttribute("aria-expanded")})');
  if (deviceLinkFocused) check('Keyboard: Enter activates mobile route and restores focus to main', !navigation.open && navigation.title === 'Dispositivos' && navigation.focus === 'main' && navigation.aria === 'false', JSON.stringify(navigation));

  await navigate(`${indexUrl}?ux=UX-05&theme=light`, 1440);
  let detail = await evaluate('({open:document.querySelector("#device-dialog").open,focusInDialog:Boolean(document.activeElement.closest("#device-dialog"))})');
  check('Keyboard: device drawer opens as modal and receives focus', detail.open && detail.focusInDialog, JSON.stringify(detail));
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await delay(120);
  detail = await evaluate('({open:document.querySelector("#device-dialog").open,focusId:document.activeElement.dataset.id})');
  check('Keyboard: Escape closes device drawer and restores row trigger', !detail.open && detail.focusId === 'a1', JSON.stringify(detail));
  for (const width of [320, 768]) {
    await navigate(`${indexUrl}?ux=UX-05&theme=light`, width);
    detail = await evaluate('({open:document.querySelector("#device-dialog").open,focusInDialog:Boolean(document.activeElement.closest("#device-dialog"))})');
    check(`Keyboard ${width}px: device drawer opens and focuses inside`, detail.open && detail.focusInDialog, JSON.stringify(detail));
    await keyPress('Escape', 'Escape', 27);
    await delay(80);
    detail = await evaluate('({open:document.querySelector("#device-dialog").open,focusId:document.activeElement.dataset.id,visible:Boolean(document.activeElement.closest(".device-card")?.getClientRects().length)})');
    check(`Keyboard ${width}px: Escape restores focus to visible device card`, !detail.open && detail.focusId === 'a1' && detail.visible, JSON.stringify(detail));
  }

  await navigate(`${indexUrl}?ux=UX-09&theme=light`, 1440);
  const invalidUses = await evaluate('(() => { const input=document.querySelector("#flow-content [name=uses]"); input.value="0"; return input.checkValidity(); })()');
  check('Wizard: invitation uses rejects zero before review', invalidUses === false);
  await evaluate('(() => { const input=document.querySelector("#flow-content [name=uses]"); input.value="2"; input.focus(); })()');
  let reviewButtonFocused = false;
  const focusTrace = [];
  for (let index = 0; index < 12; index++) {
    await keyPress('Tab', 'Tab', 9);
    const focus = await evaluate('({tag:document.activeElement.tagName,id:document.activeElement.id,name:document.activeElement.name,action:document.activeElement.dataset.action,label:document.activeElement.getAttribute("aria-label")})');
    focusTrace.push(focus);
    if (focus.action === 'flow-next') { reviewButtonFocused = true; break; }
  }
  check('Keyboard: Tab reaches enrollment review action', reviewButtonFocused, JSON.stringify(focusTrace));
  if (!reviewButtonFocused) {
    skip('Wizard: Enter validates and advances to scope review', 'Tab no alcanzó Revisar alcance.');
    skip('Wizard: simulated error preserves review values and announces alert', 'No se ejecutan asserts dependientes sin llegar a revisión.');
    skip('Wizard: return to edit preserves draft', 'No se ejecutan asserts dependientes sin llegar a revisión.');
  } else {
    await keyPress('Enter', 'Enter', 13);
    await delay(80);
    const wizard = await evaluate('({step:document.querySelector("#flow-progress").textContent,uses:document.querySelector("#flow-content").textContent.includes("2 · máximo 100")})');
    check('Wizard: Enter validates and advances to scope review', wizard.step.includes('Paso 2') && wizard.uses, JSON.stringify(wizard));
    if (!wizard.step.includes('Paso 2')) {
      skip('Wizard: simulated error preserves review values and announces alert', 'El wizard no alcanzó el paso de revisión.');
      skip('Wizard: return to edit preserves draft', 'El wizard no alcanzó el paso de revisión.');
    } else {
      await evaluate('document.querySelector("#flow-content [data-action=flow-error]").click()');
      const error = await evaluate('({alert:Boolean(document.querySelector("#flow-content [role=alert]")),uses:document.querySelector("#flow-content").textContent.includes("2 · máximo 100")})');
      check('Wizard: simulated error preserves review values and announces alert', error.alert && error.uses, JSON.stringify(error));
      await evaluate('document.querySelector("#flow-content [data-action=flow-back]").click()');
      const preserved = await evaluate('document.querySelector("#flow-content [name=uses]")?.value');
      check('Wizard: return to edit preserves draft', preserved === '2', String(preserved));
    }
  }

  const stateResults = [
    ['empty', '#content .empty h2'], ['loading', '#state-region [aria-busy="true"]'],
    ['error', '#state-region [role="alert"]'], ['stale', '#state-region .callout.warn'],
    ['forbidden', '#content .empty h2'],
  ];
  for (const [state, selector] of stateResults) {
    await navigate(`${indexUrl}?ux=UX-03&state=${state}&theme=light`, 1440);
    const present = await evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`);
    check(`State contract: ${state} is visible`, present);
  }

  await navigate(`${indexUrl}?persona=companyAdmin&view=devices&theme=light`, 1440);
  const adminExportDisabled = await evaluate('document.querySelector("#export-devices")?.disabled');
  check('RBAC presentation: company.admin has no implicit report export', adminExportDisabled === true, String(adminExportDisabled));
  await navigate(`${indexUrl}?persona=auditorExport&view=devices&theme=light`, 1440);
  const explicitGrantEnabled = await evaluate('document.querySelector("#export-devices")?.disabled === false');
  check('RBAC presentation: explicit company.report.export grant enables local export', explicitGrantEnabled);
  await navigate(`${indexUrl}?persona=companyAdminB&tenant=b&view=devices&theme=light`, 1440);
  const tenantIsolation = await evaluate('({hasB:Boolean(document.body.textContent.includes("Equipo Demo B-01")),hasA:Boolean(document.body.textContent.includes("Equipo Demo A-01"))})');
  check('Tenant fixtures: company B does not render company A device', tenantIsolation.hasB && !tenantIsolation.hasA, JSON.stringify(tenantIsolation));
  await navigate(`${indexUrl}?persona=auditorExport&view=devices&kind=Gateway&q=Demo%20A-05&theme=light`, 1440);
  const filterContract = await evaluate('({count:document.querySelector("#device-count")?.textContent,query:new URL(location.href).searchParams.get("q"),kind:new URL(location.href).searchParams.get("kind"),rows:document.querySelectorAll("#device-rows tr").length})');
  check('Inventory: search/type/count/URL agree on one row', filterContract.rows === 1 && filterContract.query === 'Demo A-05' && filterContract.kind === 'Gateway' && filterContract.count.startsWith('1 de '), JSON.stringify(filterContract));
  const intercepted = await evaluate('(() => { window.__uxCsvBlob=null; URL.createObjectURL=blob => { window.__uxCsvBlob=blob; return "blob:ux-capture"; }; URL.revokeObjectURL=()=>{}; HTMLAnchorElement.prototype.click=function(){}; document.querySelector("#export-devices").click(); return true; })()');
  const csvText = await evaluate('window.__uxCsvBlob.text()');
  const csvDetails = { intercepted, rows: csvText.split(/\r?\n/u).length, hasSelected: csvText.includes('Gateway Demo A-05'), hasOther: csvText.includes('Gateway Demo A-01'), csvText };
  check('Inventory: CSV export contains precisely the filtered fixture row', intercepted && csvDetails.rows === 2 && csvDetails.hasSelected && !csvDetails.hasOther, JSON.stringify(csvDetails));

  await navigate(`${indexUrl}?persona=providerOwner&tenant=global&view=overview&kind=Gateway&q=Demo&theme=light`, 1440);
  await evaluate('(() => { const tenant=document.querySelector("#tenant"); tenant.value="a"; tenant.dispatchEvent(new Event("change",{bubbles:true})); })()');
  const contextReset = await evaluate('({tenant:document.querySelector("#tenant").value,search:new URL(location.href).searchParams.get("q"),kind:new URL(location.href).searchParams.get("kind"),title:document.querySelector("#page-title").textContent})');
  check('Scope switch: owner changes tenant and clears URL filters', contextReset.tenant === 'a' && contextReset.search === null && contextReset.kind === null && contextReset.title === 'Resumen', JSON.stringify(contextReset));
  await navigate(`${indexUrl}?persona=providerOperator&view=overview&theme=light`, 1440);
  const assignedOnly = await evaluate('({hidden:document.querySelector("#tenant-wrap").hidden,options:[...document.querySelector("#tenant").options].map(x=>x.value)})');
  check('Scope selector: assigned provider operator cannot select an unassigned fixture', assignedOnly.hidden && assignedOnly.options.length === 1 && assignedOnly.options[0] === 'a', JSON.stringify(assignedOnly));
}

async function captureSharedStates() {
  const states = ['empty', 'loading', 'error', 'stale', 'forbidden'];
  const folder = join(output, 'states'); mkdirSync(folder, { recursive: true });
  for (const state of states) {
    await navigate(`${indexUrl}?ux=UX-03&state=${state}&theme=light`, 1440);
    const image = await send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
    writeFileSync(join(folder, `${state}-1440-light.png`), Buffer.from(image.data, 'base64'));
  }
}

let exitCode = 0;
try {
  mkdirSync(output, { recursive: true });
  const port = await openDevTools();
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
  for (const taskId of taskIds) {
    for (const theme of ['light', 'dark']) {
      for (const width of widthCases) await capture(taskId, width, theme);
    }
  }
  await captureSharedStates();
  await keyboardAndContracts();
  check('Prototype: no uncaught JavaScript runtime exceptions', runtimeExceptions.length === 0, runtimeExceptions.join(' | '));
  check('Prototype: no external HTTP(S) requests', externalRequests.length === 0, externalRequests.join(' | '));
  const report = {
    date: new Date().toISOString(),
    browser: executable,
    devtoolsPort: port,
    viewportWidths: widthCases,
    themes: ['light', 'dark'],
    taskCount: taskIds.length,
    screenshots: taskIds.length * widthCases.length * 2 + 5,
    assertions,
    runtimeExceptions,
    externalRequests,
    result: assertions.every(item => item.result === 'PASS') ? 'PASS' : 'FAIL',
  };
  writeFileSync(join(output, 'verification.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`${report.result}: ${assertions.filter(item => item.result === 'PASS').length}/${assertions.length} checks; ${report.screenshots} captures.`);
  if (report.result !== 'PASS') exitCode = 1;
} catch (error) {
  console.error(error);
  exitCode = 1;
} finally {
  try { socket?.close(); } catch { /* already closed */ }
  browser.kill('SIGTERM');
  await delay(200);
  rmSync(profile, { recursive: true, force: true });
}

process.exitCode = exitCode;
