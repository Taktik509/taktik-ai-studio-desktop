/**
 * Taktik AI Studio — Desktop App
 * Native shell for https://taktikmarketing.space
 * Windows / macOS / Linux — Electron
 */
'use strict';

const { app, BrowserWindow, BrowserView, Menu, Tray, shell, dialog, ipcMain, session } = require('electron');
const path = require('path');

let autoUpdater = null;
try {
  ({ autoUpdater } = require('electron-updater'));
} catch (_) {
  autoUpdater = null; // updater optional (e.g. dev)
}

const SITE_URL = 'https://taktikmarketing.space';
const APP_URL = SITE_URL + '/dashboard/';
const TOOLKIT_PATH = path.join(__dirname, 'assets', 'offline-tools', 'index.html');
const { pathToFileURL } = require('url');
const TOOLKIT_URL = pathToFileURL(TOOLKIT_PATH).href;
const TOOLBAR_HEIGHT = 46;
const TOOLBAR_FILE = path.join(__dirname, 'assets', 'toolbar.html');

// Desktop Chrome user agent (no "Electron" token): Google/Facebook refuse
// OAuth logins from embedded-browser user agents ("disallowed_useragent"),
// so the app identifies as plain Chrome.
function chromeUA() {
  const v = '131.0.0.0';
  const os = process.platform === 'win32' ? 'Windows NT 10.0; Win64; x64'
    : process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7'
    : 'X11; Linux x86_64';
  return `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v} Safari/537.36`;
}

// OAuth providers open in a dedicated in-app popup (shared session), never
// the system browser — the login then lands back inside the app.
const OAUTH_HOSTS = new Set([
  'accounts.google.com',
  'www.facebook.com', 'facebook.com', 'm.facebook.com', 'web.facebook.com',
]);
const isOAuthUrl = (url) => {
  try { return OAUTH_HOSTS.has(new URL(url).hostname.toLowerCase()); }
  catch (_) { return false; }
};

// Keep navigation inside the app for our own site AND local pages (offline toolkit);
// open everything else outside
const isOurs = (url) => {
  if (url.startsWith('file://')) return true; // offline toolkit pages
  try { return new URL(url).origin === new URL(SITE_URL).origin; } catch (_) { return false; }
};
const BRAND_BG = '#0B1220';
const SMOKE_TEST = process.argv.includes('--smoke-test');

let mainWindow = null;
let contentView = null;   // the website / toolkit
let toolbarView = null;   // slim nav toolbar (back / forward / reload / home)
let authWindow = null;    // OAuth popup (Google / Facebook)
let tray = null;
let targetUrl = APP_URL; // last intended in-app URL (for offline retry)
if (process.argv.includes('--smoke-toolkit')) { targetUrl = TOOLKIT_URL; }

// ---- Single instance -------------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    } else {
      createWindow();
    }
  });
}

// ---- App identity ----------------------------------------------------------
app.setName('Taktik AI Studio');
if (process.platform === 'win32') {
  app.setAppUserModelId('space.taktikmarketing.studio');
}
// Deep link: taktik://dashboard
if (app.isPackaged && !SMOKE_TEST) {
  try { app.setAsDefaultProtocolClient('taktik'); } catch (_) {}
}

// ---- Window: slim toolbar on top + content view below ----------------------
function openAuthWindow(url) {
  if (authWindow && !authWindow.isDestroyed()) {
    authWindow.loadURL(url);
    authWindow.focus();
    return;
  }
  authWindow = new BrowserWindow({
    width: 520,
    height: 700,
    minWidth: 440,
    minHeight: 560,
    backgroundColor: BRAND_BG,
    title: 'Sign in — Taktik AI Studio',
    autoHideMenuBar: true,
    parent: mainWindow,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // When the provider sends us back to our own site, close the popup and
  // continue inside the app (shared session => already logged in).
  const finishIfBackHome = (u) => {
    try {
      if (u && new URL(u).origin === new URL(SITE_URL).origin && authWindow && !authWindow.isDestroyed()) {
        const dest = u;
        authWindow.close();
        if (contentView) {
          targetUrl = dest;
          contentView.webContents.loadURL(dest);
        }
      }
    } catch (_) {}
  };
  authWindow.webContents.on('will-redirect', (_e, u) => finishIfBackHome(u));
  authWindow.webContents.on('did-navigate', (_e, u) => finishIfBackHome(u));
  authWindow.on('closed', () => { authWindow = null; });
  authWindow.loadURL(url);
}

function layoutViews() {
  if (!mainWindow || !toolbarView || !contentView) return;
  const { width, height } = mainWindow.getContentBounds();
  toolbarView.setBounds({ x: 0, y: 0, width, height: TOOLBAR_HEIGHT });
  contentView.setBounds({ x: 0, y: TOOLBAR_HEIGHT, width, height: Math.max(0, height - TOOLBAR_HEIGHT) });
}

function pushNavState() {
  if (!contentView || !toolbarView || toolbarView.webContents.isDestroyed()) return;
  const wc = contentView.webContents;
  toolbarView.webContents.send('taktik:nav-state', {
    canGoBack: wc.canGoBack(),
    canGoForward: wc.canGoForward(),
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: BRAND_BG,
    title: 'Taktik AI Studio',
    autoHideMenuBar: false,
    // NOTE: show immediately — our content lives in BrowserViews, so the
    // window's own 'ready-to-show' may never fire; waiting on it left the
    // app running invisible (v1.2.0 bug). backgroundColor avoids any flash.
    show: true,
  });

  toolbarView = new BrowserView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  contentView = new BrowserView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.addBrowserView(toolbarView);
  mainWindow.addBrowserView(contentView);
  mainWindow.setTopBrowserView(toolbarView);
  layoutViews();
  mainWindow.on('resize', layoutViews);
  toolbarView.webContents.loadFile(TOOLBAR_FILE);

  const wc = contentView.webContents;

  // (window is shown immediately — see show:true above)

  // Offline handling: branded offline page with retry
  wc.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL) => {
    if (errorCode === -3) return; // aborted, ignore
    console.error(`[taktik] load failed (${errorCode}) ${validatedURL}: ${errorDescription}`);
    if (SMOKE_TEST) {
      console.error('SMOKE FAIL: page did not load');
      app.exit(1);
      return;
    }
    wc.loadFile(path.join(__dirname, 'assets', 'offline.html'));
  });

  // Smoke test: verify the live site actually loads, then quit
  if (SMOKE_TEST) {
    const timer = setTimeout(() => {
      console.error('SMOKE FAIL: load timeout');
      app.exit(2);
    }, 90000);
    wc.on('did-finish-load', () => {
      const url = wc.getURL();
      const wantFile = process.argv.includes('--smoke-toolkit');
      if ((!wantFile && !url.startsWith('file://')) || (wantFile && url.startsWith('file://'))) {
        clearTimeout(timer);
        wc.executeJavaScript(`JSON.stringify({
          title: document.title,
          hookCards: document.querySelectorAll('#hook-list .card').length,
          ctaCards: document.querySelectorAll('#cta-list .card').length,
          playbooks: (window.TAKTIK_PLAYBOOKS||[]).length,
          calDays: document.querySelectorAll('#cal-grid .cal-day').length,
          errors: (window.__taktikErrors||[]).length
        })`).then(r => console.log('SMOKE DIAG: ' + r))
          .catch(e => console.log('SMOKE DIAG ERROR: ' + e.message))
          .finally(() => {
            console.log(`SMOKE OK: loaded ${url} | title="${wc.getTitle()}"`);
            setTimeout(() => app.exit(0), 300);
          });
      }
    });
  }

  wc.on('will-navigate', (e, url) => {
    if (isOAuthUrl(url)) {
      e.preventDefault();
      openAuthWindow(url);
      return;
    }
    if (!isOurs(url)) {
      e.preventDefault();
      shell.openExternal(url);
    } else {
      targetUrl = url;
    }
  });
  wc.setWindowOpenHandler(({ url }) => {
    if (isOAuthUrl(url)) {
      openAuthWindow(url);
      return { action: 'deny' };
    }
    if (isOurs(url)) {
      targetUrl = url;
      wc.loadURL(url);
    } else {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // Keep the toolbar buttons in sync with history
  wc.on('did-navigate', pushNavState);
  wc.on('did-finish-load', pushNavState);
  wc.on('did-navigate-in-page', pushNavState);

  // Downloads: ask where to save
  wc.session.on('will-download', (_e, item) => {
    const fileName = item.getFilename();
    const savePath = dialog.showSaveDialogSync(mainWindow, {
      defaultPath: path.join(app.getPath('downloads'), fileName),
      title: 'Save file from Taktik AI Studio',
    });
    if (savePath) item.setSavePath(savePath);
    else item.cancel();
  });

  mainWindow.on('closed', () => { mainWindow = null; contentView = null; toolbarView = null; });
  wc.loadURL(targetUrl);
  buildMenu();
  buildTray();
}

// (permissions + user agent are set in the main whenReady block below)

// ---- Menu ------------------------------------------------------------------
function go(url) {
  targetUrl = url;
  if (contentView) contentView.webContents.loadURL(url);
}

function goToolkit(tool) {
  const url = TOOLKIT_URL + (tool ? '#' + tool : '');
  targetUrl = url;
  if (contentView) contentView.webContents.loadURL(url);
}

const cwc = () => (contentView ? contentView.webContents : null);

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{
      label: 'Taktik AI Studio',
      submenu: [
        { label: 'About Taktik AI Studio', click: showAbout },
        { type: 'separator' },
        { label: 'Check for Updates…', click: checkForUpdates },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Dashboard', accelerator: 'CmdOrCtrl+1', click: () => go(APP_URL) },
        { label: 'AI Tools', accelerator: 'CmdOrCtrl+2', click: () => go(SITE_URL + '/tools/') },
        { label: 'Flow Studio', accelerator: 'CmdOrCtrl+3', click: () => go(SITE_URL + '/flow-studio/') },
        { label: 'Billing & Plans', accelerator: 'CmdOrCtrl+4', click: () => go(SITE_URL + '/billing/') },
        { type: 'separator' },
        {
          label: 'Sign Out',
          click: async () => {
            const ses = session.defaultSession;
            await ses.clearStorageData();
            await ses.clearCache();
            go(SITE_URL + '/login/');
          },
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Tools',
      submenu: [
        { label: 'Offline Toolkit', accelerator: 'CmdOrCtrl+5', click: () => goToolkit('') },
        { type: 'separator' },
        { label: 'Hook Lab (offline)', click: () => goToolkit('hooks') },
        { label: 'CTA Builder (offline)', click: () => goToolkit('ctas') },
        { label: 'Playbooks (offline)', click: () => goToolkit('playbooks') },
        { label: 'Content Calendar (offline)', click: () => goToolkit('calendar') },
        { label: 'Caption Formatter (offline)', click: () => goToolkit('formatter') },
        { type: 'separator' },
        { label: 'AI Tools (needs internet)', click: () => go(SITE_URL + '/tools/') },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Back', accelerator: 'Alt+Left', click: () => { const w = cwc(); if (w && w.canGoBack()) w.goBack(); } },
        { label: 'Forward', accelerator: 'Alt+Right', click: () => { const w = cwc(); if (w && w.canGoForward()) w.goForward(); } },
        { type: 'separator' },
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => { const w = cwc(); if (w) w.reload(); } },
        { label: 'Force Reload', accelerator: 'CmdOrCtrl+Shift+R', click: () => { const w = cwc(); if (w) w.reloadIgnoringCache(); } },
        { type: 'separator' },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+Plus', click: () => { const w = cwc(); if (w) w.setZoomFactor(Math.min(2, w.getZoomFactor() + 0.1)); } },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => { const w = cwc(); if (w) w.setZoomFactor(Math.max(0.5, w.getZoomFactor() - 0.1)); } },
        { label: 'Reset Zoom', accelerator: 'CmdOrCtrl+0', click: () => { const w = cwc(); if (w) w.setZoomFactor(1); } },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'close' }] },
    {
      label: 'Help',
      submenu: [
        { label: 'Check for Updates…', click: checkForUpdates },
        { label: 'Download the Latest Version', click: () => shell.openExternal(SITE_URL + '/download/') },
        { type: 'separator' },
        { label: 'Visit Website', click: () => shell.openExternal(SITE_URL + '/') },
        { label: 'Contact Support', click: () => shell.openExternal(SITE_URL + '/contact/') },
        { type: 'separator' },
        { label: 'About Taktik AI Studio', click: showAbout },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function showAbout() {
  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'About Taktik AI Studio',
    message: 'Taktik AI Studio',
    detail: `Desktop app v${app.getVersion()}\nCreate Smarter. Market Faster. Grow Further.\n\n${SITE_URL}`,
    buttons: ['OK'],
  });
}

// ---- Tray ------------------------------------------------------------------
function buildTray() {
  if (tray || SMOKE_TEST) return;
  const iconPath = path.join(__dirname, 'assets', process.platform === 'win32' ? 'tray.ico' : 'tray.png');
  try {
    tray = new Tray(iconPath);
  } catch (e) {
    console.error('[taktik] tray unavailable:', e.message);
    return;
  }
  tray.setToolTip('Taktik AI Studio');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Taktik AI Studio', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } },
    { label: 'Go to Dashboard', click: () => { go(APP_URL); if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } },
    { label: 'Offline Toolkit', click: () => { goToolkit(''); if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } },
    { type: 'separator' },
    { label: 'Check for Updates…', click: checkForUpdates },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]));
  tray.on('click', () => {
    if (!mainWindow) return;
    if (mainWindow.isVisible()) mainWindow.hide();
    else { mainWindow.show(); mainWindow.focus(); }
  });
}

// ---- Auto-update (active once GitHub releases are configured) --------------
function checkForUpdates(manual = true) {
  if (!autoUpdater || !app.isPackaged) {
    if (manual && mainWindow) {
      dialog.showMessageBox(mainWindow, {
        type: 'info', title: 'Updates',
        message: 'You are running the latest packaged build.',
        detail: `Version ${app.getVersion()}. Automatic updates activate once releases are published.`,
        buttons: ['OK'],
      });
    }
    return;
  }
  autoUpdater.checkForUpdates().catch(() => {
    if (manual && mainWindow) {
      dialog.showMessageBox(mainWindow, {
        type: 'info', title: 'Updates',
        message: 'Could not check for updates right now.',
        detail: 'Please try again later or download the latest version from the website.',
        buttons: ['OK'],
      });
    }
  });
}

if (autoUpdater && app.isPackaged && !SMOKE_TEST) {
  autoUpdater.autoDownload = true;
  autoUpdater.on('update-downloaded', () => {
    const res = dialog.showMessageBoxSync(mainWindow, {
      type: 'info', title: 'Update ready',
      message: 'A new version of Taktik AI Studio is ready.',
      detail: 'Restart now to install it?',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
    });
    if (res === 0) autoUpdater.quitAndInstall();
  });
  app.whenReady().then(() => {
    setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 15000);
  });
}

// ---- IPC (offline page retry + toolkit + toolbar nav) ----------------------
ipcMain.on('taktik:retry', () => {
  if (contentView) contentView.webContents.loadURL(targetUrl);
});
ipcMain.on('taktik:open-toolkit', (_e, tool) => {
  goToolkit(tool || '');
});
ipcMain.on('taktik:nav', (_e, action) => {
  const wc = cwc();
  if (!wc) return;
  if (action === 'back' && wc.canGoBack()) wc.goBack();
  else if (action === 'forward' && wc.canGoForward()) wc.goForward();
  else if (action === 'reload') wc.reload();
  else if (action === 'home') go(APP_URL);
});
ipcMain.on('taktik:nav-state-request', () => pushNavState());
ipcMain.handle('taktik:version', () => app.getVersion());

// ---- Lifecycle ---------------------------------------------------------------
app.whenReady().then(() => {
  // Identify as desktop Chrome (not Electron) so Google/Facebook accept logins.
  session.defaultSession.setUserAgent(chromeUA());
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'notifications');
  });
  createWindow();
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  } else if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
    mainWindow.show();
  }
});
