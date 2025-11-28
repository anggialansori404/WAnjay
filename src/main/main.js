// main.js
const { app, BrowserWindow, BrowserView, Menu, shell, Tray, nativeImage, Notification, globalShortcut, session, ipcMain, powerMonitor, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
let AutoLaunch = null;
try { AutoLaunch = require("electron-auto-launch"); } catch (_) { AutoLaunch = null; }
const Store = require("electron-store");

// Configure data storage location to follow install directory (configurable at install)
// Users can persistently override via env var WANJAY_DATA_DIR or config file next to the executable
function getInstallBase() {
  try { return path.dirname(process.execPath); } catch (_) { return __dirname; }
}
function getConfigPath() {
  return path.join(getInstallBase(), "wanjay.config.json");
}
function readDataDirOverrideFromConfig() {
  try {
    const p = getConfigPath();
    if (fs.existsSync(p)) {
      const json = JSON.parse(fs.readFileSync(p, "utf8"));
      if (json && typeof json.userDataDir === "string" && json.userDataDir.trim()) return json.userDataDir.trim();
    }
  } catch (_) {}
  return null;
}
function writeDataDirOverrideToConfig(dir) {
  try {
    const p = getConfigPath();
    fs.writeFileSync(p, JSON.stringify({ userDataDir: dir }, null, 2), "utf8");
    return true;
  } catch (_) { return false; }
}
try {
  const installBase = getInstallBase();
  const cfgOverride = readDataDirOverrideFromConfig();
  const desiredDataDir = process.env.WANJAY_DATA_DIR
    ? process.env.WANJAY_DATA_DIR
    : (cfgOverride || (app.isPackaged ? path.join(installBase, "WAnjayData") : path.join(__dirname, "user-data-dev")));
  fs.mkdirSync(desiredDataDir, { recursive: true });
  app.setPath("userData", desiredDataDir);
  try { app.setAppLogsPath(path.join(desiredDataDir, "logs")); } catch (_) {}
} catch (_) {}

// Single instance lock to avoid multiple processes
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}
app.on("second-instance", () => {
  const wins = BrowserWindow.getAllWindows();
  if (wins.length) {
    const w = wins[0];
    if (w.isMinimized()) w.restore();
    w.show();
    w.focus();
  }
});

const store = new Store({ name: "settings" });
const DEFAULT_SETTINGS = {
  runOnStartup: false,
  alwaysOnTop: false,
  compactMode: false,
  forceDark: false,
  hideSidebar: false,
  muteUntil: 0,
  hidePreviews: false,
  presentationMode: false,
  lockEnabled: false,
  autoLockMinutes: 10,
  lowMemoryMode: false,
  // Default language: will be initialised later based on system locale if not set
  lang: 'id',
};
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) if (store.get(k) === undefined) store.set(k, v);

const appAutoLauncher = AutoLaunch ? new AutoLaunch({ name: "WAnjay" }) : null;
async function applyAutoLaunchSetting() {
  try {
    if (!appAutoLauncher) return; // if module missing, skip gracefully
    if (store.get("runOnStartup")) await appAutoLauncher.enable();
    else await appAutoLauncher.disable();
  } catch (_) {}
}

let tray = null;
let mainWindow;
let lockWindow;
let lockJustOpened = false;
let lockManuallyHidden = false;
let unreadCount = 0;
let idleTimer = null;
let isQuitting = false;
let lockAfterSetup = false;
let allowLockClose = false;
// When the auto‑lock timer elapses while the app is not focused, the
// overlay should not immediately appear.  Instead, we set this flag
// to true and notify the user that auto‑lock has engaged.  The lock
// overlay will then be shown the next time the user focuses the app.
let pendingAutoLock = false;

// Track whether each profile currently has an authenticated WhatsApp session.
// The preload script sends session:status IPC messages whenever the login
// state changes.  If a profile's status is false, the lock overlay is
// suppressed and auto‑lock timers are not started for that profile.
const hasSessionStatus = {};

// Window for renaming a profile.  This small overlay appears on top of
// the main window to allow users to type a new profile name.  It is
// destroyed after each use.  Only one renameWindow can exist at a time.
let renameWindow = null;

// Default tray icon image.  Will be assigned when the tray is created in
// app.whenReady().  Used to restore the tray icon when unread count is zero.
let defaultTrayImage = null;

// References to refresh functions defined later within app.whenReady(). These
// will be assigned when the app is ready so they can be called from
// top-level functions such as setLang(). Without these, refreshTray()
// would be undefined in setLang(). See assignment in app.whenReady().
let globalRefreshTray = () => {};
let globalRefreshAppMenu = () => {};

// -----------------------------------------------------------------------------
// Language support
// WAnjay can be displayed in multiple languages (Indonesian or English).  The
// current language is stored in settings under the key `lang`.  The app
// chooses a sensible default based on the system locale on first run.  When
// the language changes, all UI elements (tab bar, profile window, lock
// window, menus, etc.) can update accordingly via IPC messages.

/**
 * Determine a default language based on the system locale.  If the user's
 * locale is Indonesian (starts with "id"), return "id".  Otherwise, use
 * English ("en").  This is used only on first run when the setting is
 * undefined.
 */
function getSystemLanguage() {
  try {
    const loc = Intl.DateTimeFormat().resolvedOptions().locale || '';
    return loc.toLowerCase().startsWith('id') ? 'id' : 'en';
  } catch (_) {
    return 'en';
  }
}

/**
 * Return the current language setting.  Falls back to default system
 * language if the stored value is missing or invalid.
 */
function getLang() {
  const lang = store.get('lang');
  if (lang === 'id' || lang === 'en') return lang;
  // initialise on first run
  const sys = getSystemLanguage();
  store.set('lang', sys);
  return sys;
}

/**
 * Change the current language.  Persists to settings and notifies all
 * BrowserViews (profile views and tab bar) as well as the profile window and
 * any other listeners so they can update their UI.  If the requested
 * language is not supported, it falls back silently.
 *
 * @param {string} lang - either 'id' or 'en'
 */
function setLang(lang) {
  if (lang !== 'id' && lang !== 'en') return;
  store.set('lang', lang);
  notifyLanguageChanged();
  // Call refresh functions assigned from app.whenReady() to update tray and menus
  try { globalRefreshTray(); } catch (_) {}
  try { globalRefreshAppMenu(); } catch (_) {}
}

/**
 * Broadcast a language change to all BrowserViews and the profile
 * selection window.  Views can listen for the `language` event to
 * update their UI.  Also updates the title and tooltip of the tray icon.
 */
function notifyLanguageChanged() {
  const lang = getLang();
  // notify views
  for (const p of Object.keys(views)) {
    try { views[p].webContents.send('language', lang); } catch (_) {}
  }
  // notify tab bar
  if (tabView && tabView.webContents) {
    try { tabView.webContents.send('language', lang); } catch (_) {}
  }
  // notify profile window
  if (profileWindow && !profileWindow.isDestroyed()) {
    try { profileWindow.webContents.send('language', lang); } catch (_) {}
  }
  // update tray tooltip
  if (tray) {
    // Update tooltip according to unread count as well
    if (unreadCount > 0) {
      if (lang === 'id') {
        tray.setToolTip(`WAnjay - ${unreadCount} pesan belum dibaca`);
      } else {
        tray.setToolTip(`WAnjay - ${unreadCount} unread`);
      }
      try { tray.setImage(getRedDotOverlay()); } catch (_) {}
    } else {
      tray.setToolTip('WAnjay');
      try { tray.setImage(defaultTrayImage); } catch (_) {}
    }
  }
}

// -----------------------------------------------------------------------------
// Multi-profile support
// WAnjay can now host multiple WhatsApp sessions simultaneously. Each profile
// maintains its own isolated Electron session (via `partition` identifiers)
// which persists cookies and localStorage independently. Profiles are
// persisted to disk and can be switched at runtime without restarting
// the entire application. A simple tab bar lists the available profiles and
// clicking a tab swaps the view.

// Path where profile names are stored (one JSON array). Created in userData.
const profilesPath = path.join(app.getPath("userData"), "profiles.json");

// In-memory list of profile names, current active profile and BrowserViews per profile
let profiles = [];
let currentProfile = null;
let views = {};
let tabView = null;
let profileWindow = null;

// Height in pixels of the tab bar.  The lock overlay will be positioned
// below this amount so that the tab bar remains interactive even when
// locked.  Must match the height set in updateTabBar() (currently 36).
const TAB_BAR_HEIGHT = 36;

function loadProfiles() {
  // Read profiles from disk. If the file doesn't exist or is invalid,
  // return an empty array. Profiles are simple strings.
  try {
    if (fs.existsSync(profilesPath)) {
      const json = JSON.parse(fs.readFileSync(profilesPath, "utf8"));
      if (Array.isArray(json)) {
        return json.filter(p => typeof p === 'string' && p.trim()).map(p => p.trim());
      }
    }
  } catch (_) {}
  return [];
}

function saveProfiles(list) {
  // Persist the list of profile names atomically. Ignore errors.
  try {
    fs.mkdirSync(path.dirname(profilesPath), { recursive: true });
    fs.writeFileSync(profilesPath, JSON.stringify(list, null, 2), "utf8");
  } catch (_) {}
}

async function showProfileSelector() {
  // Display an overlay window to choose or create a profile. The window
  // covers the main window entirely and uses the profile-preload.js
  // preload script to communicate with the main process. When a profile
  // is selected, an IPC message triggers switchToProfile().
  try {
    // If selector already open, just focus it
    if (profileWindow && !profileWindow.isDestroyed()) {
      profileWindow.show();
      profileWindow.focus();
      return;
    }
    // Determine bounds based off the main window if available
    const b = mainWindow ? mainWindow.getBounds() : { width: 800, height: 600, x: undefined, y: undefined };
    profileWindow = new BrowserWindow({
      width: b.width,
      height: b.height,
      resizable: false,
      minimizable: false,
      maximizable: false,
      frame: false,
      title: "Select Profile - WAnjay",
      alwaysOnTop: true,
      movable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: true,
      backgroundColor: '#0f172a',
      webPreferences: { contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, "..", "profile", "profile-preload.js") },
    });
    if (b.x !== undefined && b.y !== undefined) profileWindow.setPosition(b.x, b.y);
    const profileHtmlPath = path.join(__dirname, "..", "profile", "profile.html");
    if (fs.existsSync(profileHtmlPath)) {
      profileWindow.loadFile(profileHtmlPath);
    } else {
      // Fallback simple content
      const html = `<!doctype html><html><body style="color:#fff;background:#0f172a;font-family:sans-serif;display:flex;align-items:center;justify-content:center"><div>Pilih profil...</div></body></html>`;
      profileWindow.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
    }
    profileWindow.on('closed', () => { profileWindow = null; });
    profileWindow.on('blur', () => {
      // If user clicks outside, do not close; keep overlay until choice
      if (profileWindow && !profileWindow.isDestroyed()) {
        profileWindow.show();
        profileWindow.focus();
      }
    });
  } catch (_) {}
}

/**
 * Show an overlay window prompting the user to rename a profile.  The
 * overlay is a small frameless BrowserWindow that loads rename.html.
 * When invoked, it either focuses an existing rename window or
 * creates a new one.  The old profile name is passed to the
 * renderer via the 'rename-data' event.
 *
 * @param {string} oldName The current profile name to rename.
 */
function showRenameWindow(oldName) {
  // If a rename window already exists, bring it forward and update data
  if (renameWindow && !renameWindow.isDestroyed()) {
    try {
      renameWindow.focus();
      renameWindow.webContents.send('rename-data', { oldName });
    } catch (_) {}
    return;
  }
  try {
    // Determine parent bounds for centering
    const b = mainWindow ? mainWindow.getBounds() : { width: 320, height: 180, x: undefined, y: undefined };
    renameWindow = new BrowserWindow({
      width: 340,
      height: 200,
      resizable: false,
      minimizable: false,
      maximizable: false,
      frame: false,
      show: false,
      alwaysOnTop: true,
      movable: false,
      skipTaskbar: true,
      modal: false,
      backgroundColor: '#0f172a',
      parent: mainWindow || undefined,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        preload: path.join(__dirname, '..', 'windows', 'rename-preload.js'),
      },
    });
    // Position centrally within parent window
    if (b.x !== undefined && b.y !== undefined && b.width !== undefined && b.height !== undefined) {
      const x = b.x + Math.round((b.width - 340) / 2);
      const y = b.y + Math.round((b.height - 200) / 2);
      renameWindow.setPosition(x, y);
    }
    const renamePath = path.join(__dirname, '..', 'windows', 'rename.html');
    if (fs.existsSync(renamePath)) {
      renameWindow.loadFile(renamePath);
    } else {
      renameWindow.loadURL('data:text/html,<html><body style="background:#0f172a;color:#fff;padding:24px;font-family:sans-serif">Rename</body></html>');
    }
    renameWindow.once('ready-to-show', () => {
      try {
        renameWindow.show();
        renameWindow.webContents.send('rename-data', { oldName });
      } catch (_) {}
    });
    renameWindow.on('closed', () => {
      renameWindow = null;
    });
  } catch (_) {
    // ignore errors
  }
}

function ensureView(profile) {
  // Return an existing BrowserView for a profile or create a new one. Each
  // view uses a unique persistent partition so sessions remain isolated.
  if (views[profile]) return views[profile];
  const partition = `persist:wanjay-${profile}`;
  const lowMem = !!store.get("lowMemoryMode");
  const view = new BrowserView({
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      spellcheck: !lowMem,
      partition,
    },
  });
  // Set a modern user agent so WhatsApp Web doesn't complain
  const chromeUA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
    "AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/122.0.0.0 Safari/537.36";
  view.webContents.setUserAgent(chromeUA);
  // Spellchecker languages for this session
  if (!lowMem) {
    try { view.webContents.session.setSpellCheckerLanguages(["en-US", "id"]); } catch (_) {}
  }
  // Redirect new windows to external browser
  view.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  // Handle downloads per session
  const downloadsDir = path.join(app.getPath("userData"), "Downloads");
  fs.mkdirSync(downloadsDir, { recursive: true });
  const sess = view.webContents.session;
  sess.on("will-download", (event, item) => {
    const filename = item.getFilename();
    item.setSavePath(path.join(downloadsDir, filename));
    item.on("done", (_e, state) => {
      if (state === "completed") {
        if (Notification.isSupported() && Date.now() > (store.get("muteUntil") || 0) && !store.get("presentationMode")) {
          new Notification({ title: "Unduhan selesai", body: filename }).show();
        }
      }
    });
  });
  // Listen to input events for idle timer reset
  view.webContents.on("before-input-event", () => resetIdleTimer());
  // Load WhatsApp URL
  view.webContents.loadURL("https://web.whatsapp.com/");
  // When page finishes loading, schedule a lock screen only if a PIN
  // exists and locking is enabled.  If a session has been detected,
  // the overlay will be shown after a short delay.  If the session
  // status remains false for an extended period (fallback), mark
  // hasSessionStatus[profile] as true after 30 seconds to avoid
  // blocking auto‑lock due to detection failures.  The fallback does
  // not automatically show the overlay but will allow subsequent
  // lock triggers to proceed.
  view.webContents.once("did-finish-load", () => {
    if (store.get("lockEnabled") && store.get("pinHash")) {
      setTimeout(() => {
        if (hasSessionStatus[profile]) {
          showLockWindow(false);
        }
      }, 500);
    }
    // Fallback: after 30 seconds, if session status is still false, mark
    // it as true so that future lock operations are not blocked.  Do not
    // show the lock overlay immediately; this simply relaxes the gate.
    setTimeout(() => {
      if (!hasSessionStatus[profile]) {
        hasSessionStatus[profile] = true;
      }
    }, 30000);
  });
  // Register the view and mark its session status as unknown (false).
  views[profile] = view;
  hasSessionStatus[profile] = false;
  return view;
}

function switchToProfile(profile) {
  // If the requested profile isn't known, ignore
  if (!profiles.includes(profile)) return;
  // Save last used profile
  currentProfile = profile;
  // Create or fetch view
  const view = ensureView(profile);
  if (!mainWindow) return;
  // Remove previous BrowserView to prevent resource leaks
  const existingViews = mainWindow.getBrowserViews();
  existingViews.forEach(v => {
    mainWindow.removeBrowserView(v);
  });
  // Re-add tab bar view first
  if (tabView) {
    mainWindow.addBrowserView(tabView);
    // Position the tab bar at the top of the content area
    const [w, h] = mainWindow.getContentSize();
    tabView.setBounds({ x: 0, y: 0, width: w, height: TAB_BAR_HEIGHT });
    tabView.setAutoResize({ width: true });
  }
  // Then add the selected profile view, filling the rest of the window
  mainWindow.addBrowserView(view);
  const [w, h] = mainWindow.getContentSize();
  const offsetY = tabView ? TAB_BAR_HEIGHT : 0;
  view.setBounds({ x: 0, y: offsetY, width: w, height: h - offsetY });
  view.setAutoResize({ width: true, height: true });
  // Update tab bar highlight
  updateTabBar();
  // Notify renderer about settings for this view
  try { view.webContents.send('settings-updated', getSettings()); } catch (_) {}
}

function initTabBar() {
  if (tabView) return;
  tabView = new BrowserView({
    webPreferences: {
      preload: path.join(__dirname, "..", "windows", "tabbar-preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  // Load the tab bar HTML from file
  const tabHtmlPath = path.join(__dirname, "..", "windows", "tabbar.html");
  if (fs.existsSync(tabHtmlPath)) {
    tabView.webContents.loadFile(tabHtmlPath);
  } else {
    tabView.webContents.loadURL("data:text/html,<html><body style='background:#0f172a;color:#fff;font-family:sans-serif'>Tabs</body></html>");
  }
}

function updateTabBar() {
  // Send the current profiles and active profile to the tab bar
  if (tabView && tabView.webContents) {
    try { tabView.webContents.send('profiles:update', { profiles, current: currentProfile }); } catch (_) {}
  }
}

function quitApp() {
  isQuitting = true;
  try { globalShortcut.unregisterAll(); } catch (_) {}
  try { if (tray) tray.destroy(); } catch (_) {}
  app.quit();
  setTimeout(() => { try { app.exit(0); } catch (_) {} }, 2000);
}

function resetIdleTimer() {
  clearTimeout(idleTimer);
  const mins = Number(store.get("autoLockMinutes")) || 0;
  // Always schedule the timer when locking is enabled and a timeout is
  // configured.  The session status will be checked again when the
  // timer fires (inside showLockWindow) to avoid locking when not
  // logged in.  This approach ensures that the timer still runs even
  // if detection has not yet reported the session state.
  if (store.get("lockEnabled") && mins > 0) {
    idleTimer = setTimeout(() => {
      try {
        attemptAutoLock();
      } catch (_) {}
    }, mins * 60 * 1000);
  }
}

/**
 * Called when the auto‑lock timer elapses.  If a session is active for
 * the current profile and the user is still logged in, this will either
 * immediately display the lock overlay (when the app is focused) or
 * defer the overlay until focus returns by setting `pendingAutoLock`.
 * When deferred, a system notification is shown to inform the user that
 * auto‑lock has engaged.
 */
function attemptAutoLock() {
  // Only auto‑lock if enabled, a PIN exists, and the session is active
  if (!store.get("lockEnabled") || !store.get("pinHash")) return;
  // If no profile or session has not yet been detected, abort silently
  if (!currentProfile || !hasSessionStatus[currentProfile]) return;
  // If the main window is focused and visible, lock immediately
  if (mainWindow && mainWindow.isVisible() && mainWindow.isFocused()) {
    showLockWindow(false);
    return;
  }
  // Otherwise, defer the lock until the user returns and show a notification
  pendingAutoLock = true;
  if (Notification.isSupported() && Date.now() > (store.get("muteUntil") || 0) && !store.get("presentationMode")) {
    const lang = getLang();
    const title = lang === 'id' ? 'Kunci otomatis aktif' : 'Auto‑lock engaged';
    const body = lang === 'id'
      ? 'WAnjay akan terkunci saat Anda kembali'
      : 'WAnjay will lock when you return';
    try {
      new Notification({ title, body }).show();
    } catch (_) {}
  }
}

function hashPIN(pin) {
  const crypto = require("crypto");
  return crypto.createHash("sha256").update(String(pin)).digest("hex");
}

/**
 * Show an "About" dialog describing the WAnjay application. It displays
 * the application name, version, and a brief description of what WAnjay
 * provides. This is triggered from menu items in the app and tray menus.
 */
function showAbout() {
  try {
    const name = app.getName() || 'WAnjay';
    const version = app.getVersion() || '';
    const lang = getLang();
    const message = `${name} ${version}`;
    let detail;
    let title;
    if (lang === 'id') {
      title = `Tentang ${name}`;
      detail =
        'WAnjay adalah pembungkus desktop untuk WhatsApp Web yang dibuat dengan Electron.\n' +
        'Fitur meliputi multi‑profil, mode gelap, compact mode, lock screen, dan kustomisasi lainnya.\n\n' +
        'Proyek ini bersifat independen dan tidak berafiliasi dengan WhatsApp Inc.';
    } else {
      title = `About ${name}`;
      detail =
        'WAnjay is a desktop wrapper for WhatsApp Web built with Electron.\n' +
        'Features include multi‑profile support, dark mode, compact mode, lock screen and other customisation.\n\n' +
        'This project is independent and not affiliated with WhatsApp Inc.';
    }
    dialog.showMessageBox({
      type: 'info',
      title,
      message,
      detail,
      buttons: [lang === 'id' ? 'OK' : 'OK'],
      defaultId: 0,
      noLink: true,
    });
  } catch (_) {
    // fallback silent
  }
}

function getRedDotOverlay() {
  // 16x16 red dot PNG (base64)
  const b64 =
    "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAPUlEQVQ4T2NkoBAwUqifAQxgYGBgMDEy/v//PwYGBkYg0ZkQJgZGRmGgGmJkQwGQK4g0C0gkR0QmJgGg0QAAE6wB9t8C0xAAAAAASUVORK5CYII=";
  return nativeImage.createFromBuffer(Buffer.from(b64, "base64"));
}

function syncLockWindowBounds() {
  if (!mainWindow || !lockWindow) return;
  try {
    const b = mainWindow.getBounds();
    const offsetY = tabView ? TAB_BAR_HEIGHT : 0;
    lockWindow.setBounds({ x: b.x, y: b.y + offsetY, width: b.width, height: Math.max(0, b.height - offsetY) });
  } catch (_) {}
}

/**
 * Display the PIN lock overlay.  The overlay is suppressed when no
 * WhatsApp session is available for the current profile to avoid
 * nagging the user before they have logged in.  However, when the
 * caller passes `force=true` (for example via a manual "Lock Now"
 * action), the overlay will be shown regardless of session state.
 *
 * @param {boolean} setup - If true, show the setup screen to set a
 *     new PIN.  If false, show the normal lock screen.
 * @param {boolean} force - If true, bypass the session check and
 *     display the lock overlay even when a session is not detected.
 */
function showLockWindow(setup = false, force = false) {
  // Do not show the lock overlay if this is not a setup screen and
  // there is no active WhatsApp session for the current profile.
  // When force is true (i.e. triggered by a user via Lock Now), the
  // overlay will still be shown.
  if (!setup && !force) {
    if (!currentProfile || !hasSessionStatus[currentProfile]) {
      return;
    }
  }
  // Tell all profile views to blur/dim
  try {
    for (const p of Object.keys(views)) {
      const v = views[p];
      v.webContents.send('locked', true);
    }
  } catch (_) {}

  if (lockWindow && !lockWindow.isDestroyed()) {
    try {
      lockManuallyHidden = false;
      lockWindow.show();
      lockWindow.focus();
      lockWindow.webContents.send("lock-state", { setup });
      // Blur all profile views when lock is shown
      for (const p of Object.keys(views)) {
        try { views[p].webContents.send('locked', true); } catch (_) {}
      }
    } catch (_) {}
    return;
  }
  const b = mainWindow ? mainWindow.getBounds() : { width: 800, height: 600, x: undefined, y: undefined };
  // Position the lock window below the tab bar so that the tab bar remains
  // visible for profile switching.  Use TAB_BAR_HEIGHT to offset the Y
  // coordinate and reduce the height accordingly.  If no mainWindow
  // exists, fall back to full height.
  const offsetY = tabView ? TAB_BAR_HEIGHT : 0;
  lockWindow = new BrowserWindow({
    width: b.width,
    height: Math.max(0, b.height - offsetY),
    resizable: false,
    minimizable: false,
    maximizable: false,
    frame: false,
    title: setup ? "Set PIN - WAnjay" : "Locked - WAnjay",
    alwaysOnTop: true,
    movable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, "..", "lock", "lock-preload.js") },
  });
  if (b.x !== undefined && b.y !== undefined) {
    // Position lock window offset down by the tab height to leave tab bar exposed
    lockWindow.setPosition(b.x, b.y + offsetY);
  }
  const lockHtmlPath = path.join(__dirname, "..", "lock", "lock.html");
  if (fs.existsSync(lockHtmlPath)) {
    lockWindow.loadFile(lockHtmlPath);
  } else {
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Lock</title><style>body{font-family:sans-serif;margin:24px}input{font-size:18px;padding:8px;width:100%;box-sizing:border-box;margin:8px 0}button{padding:8px 12px;font-size:16px;width:100%}.msg{color:#d00;margin-top:8px}</style></head><body><h2>WAnjay Lock</h2><div id="mode"></div><input id="pin" type="password" placeholder="PIN" autofocus /><div class="msg" id="msg"></div><button id="ok">OK</button><script>let setup=false;window.lockAPI.onState((p)=>{setup=p.setup;document.getElementById('mode').innerText=setup?'Set PIN minimal 4 digit':'Enter PIN';});document.getElementById('ok').onclick=async()=>{const pin=document.getElementById('pin').value;try{if(setup){const res=await window.lockAPI.setPin(pin);if(res.ok){window.close()}else{document.getElementById('msg').innerText=res.msg||'Gagal set PIN'}}else{const ok=await window.lockAPI.unlock(pin);if(!ok){document.getElementById('msg').innerText='PIN salah'}}}catch(e){document.getElementById('msg').innerText='Error'}};</script></body></html>`;
    lockWindow.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  }
  lockWindow.on("closed", () => { lockWindow = null; allowLockClose = false; });
  lockWindow.on("close", (e) => {
    // prevent closing via Alt+F4 or X; must unlock
    if (!allowLockClose) {
      e.preventDefault();
      if (lockWindow) { lockWindow.show(); lockWindow.focus(); }
    }
  });
  lockWindow.webContents.on("did-finish-load", () => {
    lockWindow.webContents.send("lock-state", { setup });
    // Mark just opened, so blur event doesn't hide it immediately
    lockJustOpened = true;
    setTimeout(() => { lockJustOpened = false; }, 1000);
    lockManuallyHidden = false;
    lockWindow.show();
    lockWindow.focus();
    // Blur all profile views when lock is shown
    for (const p of Object.keys(views)) {
      try { views[p].webContents.send('locked', true); } catch (_) {}
    }
  });
  lockWindow.setAlwaysOnTop(true, "floating");
  lockWindow.focus();
  // Keep overlay aligned with main window
  if (mainWindow) {
    const sync = () => syncLockWindowBounds();
    mainWindow.on("move", sync);
    mainWindow.on("resize", sync);
    // Only handle lock window visibility from lockWindow events
    lockWindow.on("blur", () => {
      // Hide lock window and remove blur overlay if user switches away
      if (lockWindow && !lockWindow.isDestroyed()) {
        lockWindow.hide();
        // Remove blur overlay on all profile views
        for (const p of Object.keys(views)) {
          try { views[p].webContents.send('locked', false); } catch (_) {}
        }
      }
    });
    mainWindow.on("focus", () => {
      // Show lock window and activate blur overlay when WAnjay regains focus
      if (lockWindow && !lockWindow.isDestroyed()) {
        lockWindow.show();
        lockWindow.focus();
        // Blur all profile views when lock is shown
        for (const p of Object.keys(views)) {
          try { views[p].webContents.send('locked', true); } catch (_) {}
        }
      }
    });
  }
}

ipcMain.handle("lock:is-enabled", () => Boolean(store.get("lockEnabled")));
ipcMain.handle("lock:has-pin", () => Boolean(store.get("pinHash")));
ipcMain.handle("lock:enable", (_e, enable) => { store.set("lockEnabled", !!enable); return true; });
ipcMain.handle("lock:set-pin", (_e, pin) => {
  if (!pin || String(pin).length < 4) return { ok: false, msg: "PIN minimal 4 digit" };
  store.set("pinHash", hashPIN(pin));
  store.set("lockEnabled", true);
  if (lockAfterSetup) {
    // ensure the setup window can close first, then show lock screen
    setTimeout(() => { try { showLockWindow(false); } catch (_) {} }, 150);
    lockAfterSetup = false;
  }
  return { ok: true };
});
ipcMain.handle("lock:unlock", (_e, pin) => {
  const p = String(pin || "").trim();
  const ok = store.get("pinHash") === hashPIN(p);
  if (ok) {
    // Remove blur first on all profile views
    for (const p of Object.keys(views)) {
      try { views[p].webContents.send('locked', false); } catch (_) {}
    }
    // Then close lock window
    if (lockWindow) { allowLockClose = true; lockWindow.close(); }
    // Reset idle timer
    resetIdleTimer();
  }
  return ok;
});

// -----------------------------------------------------------------------------
// Profile IPC handlers
// These handlers allow the profile selector window to list profiles,
// create new ones and signal when the user has chosen a profile. They
// operate on the in-memory `profiles` array and persist changes to disk.

ipcMain.handle('profiles:list', () => {
  return profiles.slice();
});

ipcMain.handle('profiles:create', (_event, name) => {
  const trimmed = String(name || '').trim();
  // Validate name: non-empty, unique.  Messages are localised.
  const lang = getLang();
  const msgDict = {
    id: { empty: 'Nama tidak boleh kosong', exists: 'Profil sudah ada' },
    en: { empty: 'Name cannot be empty', exists: 'Profile already exists' }
  };
  if (!trimmed) return { ok: false, msg: msgDict[lang].empty, profiles };
  if (profiles.includes(trimmed)) return { ok: false, msg: msgDict[lang].exists, profiles };
  profiles.push(trimmed);
  saveProfiles(profiles);
  // Create the view lazily when first switched to
  updateTabBar();
  return { ok: true, profiles: profiles.slice() };
});

// Rename a profile.  The renderer must provide the old name and a proposed
// new name.  Validation ensures the new name is non-empty, different from
// the old name, contains no whitespace, and does not already exist.  The
// existing session for the old profile is destroyed and a fresh session
// will be created when the user switches to the renamed profile.  The
// user will need to re-authenticate in WhatsApp after renaming.
ipcMain.handle('profiles:rename', async (_event, oldName, newName) => {
  const oldN = String(oldName || '').trim();
  const newN = String(newName || '').trim();
  const lang = getLang();
  const msgDict = {
    id: {
      empty: 'Nama tidak boleh kosong',
      same: 'Nama sama',
      notfound: 'Profil tidak ditemukan',
      exists: 'Profil sudah ada'
    },
    en: {
      empty: 'Name cannot be empty',
      same: 'Name is the same',
      notfound: 'Profile not found',
      exists: 'Profile already exists'
    }
  };
  if (!oldN || !newN) return { ok: false, msg: msgDict[lang].empty, profiles };
  if (oldN === newN) return { ok: false, msg: msgDict[lang].same, profiles };
  if (!profiles.includes(oldN)) return { ok: false, msg: msgDict[lang].notfound, profiles };
  if (profiles.includes(newN)) return { ok: false, msg: msgDict[lang].exists, profiles };
  // Remove old view and storage
  if (views[oldN]) {
    try {
      views[oldN].destroy();
    } catch (_) {}
    delete views[oldN];
    // Clear persistent storage for the old partition
    try {
      const oldPartition = `persist:wanjay-${oldN}`;
      const s = session.fromPartition(oldPartition);
      await s.clearStorageData();
    } catch (_) {}
  }
  // Rename in profiles list
  const idx = profiles.indexOf(oldN);
  profiles[idx] = newN;
  saveProfiles(profiles);
  // If current profile renamed, update reference
  if (currentProfile === oldN) {
    currentProfile = newN;
  }
  // Update UI
  updateTabBar();
  // Switch to the new profile name if active
  if (currentProfile === newN) {
    switchToProfile(newN);
  }
  return { ok: true, profiles: profiles.slice(), current: currentProfile };
});

// Delete a profile.  The renderer must provide the name of the profile to
// delete.  If the last remaining profile is removed, deletion is refused.
ipcMain.handle('profiles:delete', async (_event, name) => {
  const n = String(name || '').trim();
  const lang = getLang();
  const msgDict = {
    id: {
      empty: 'Nama tidak boleh kosong',
      notfound: 'Profil tidak ditemukan',
      last: 'Minimal satu profil'
    },
    en: {
      empty: 'Name cannot be empty',
      notfound: 'Profile not found',
      last: 'At least one profile required'
    }
  };
  if (!n) return { ok: false, msg: msgDict[lang].empty, profiles };
  if (!profiles.includes(n)) return { ok: false, msg: msgDict[lang].notfound, profiles };
  if (profiles.length <= 1) return { ok: false, msg: msgDict[lang].last, profiles };
  // Remove from profiles list
  profiles = profiles.filter(p => p !== n);
  saveProfiles(profiles);
  // Destroy associated view and storage
  if (views[n]) {
    try { views[n].destroy(); } catch (_) {}
    delete views[n];
    try {
      const part = `persist:wanjay-${n}`;
      const s = session.fromPartition(part);
      await s.clearStorageData();
    } catch (_) {}
  }
  // If current profile is deleted, switch to first available profile
  if (currentProfile === n) {
    currentProfile = profiles[0];
    switchToProfile(currentProfile);
  }
  updateTabBar();
  return { ok: true, profiles: profiles.slice(), current: currentProfile };
});

ipcMain.on('profile:selected', (_event, name) => {
  if (profileWindow && !profileWindow.isDestroyed()) {
    profileWindow.close();
  }
  if (name && profiles.includes(name)) {
    currentProfile = name;
    switchToProfile(name);
  }
});

ipcMain.on('profile:switch', (_event, name) => {
  if (name && profiles.includes(name)) {
    switchToProfile(name);
  }
});

// When the '+' tab button is clicked, show the profile selector to add
// a new profile. Profiles are persisted automatically by the selector.
ipcMain.on('profile:add', () => {
  showProfileSelector();
});

// When the tab bar requests a rename operation, open the rename overlay
ipcMain.on('rename:open', (_event, oldName) => {
  showRenameWindow(oldName);
});
// Request from rename window to close itself
ipcMain.on('rename:close', () => {
  if (renameWindow && !renameWindow.isDestroyed()) {
    try { renameWindow.close(); } catch (_) {}
    renameWindow = null;
  }
});

// User activity handler: reset idle timer whenever any BrowserView signals
// that the user is interacting (mouse move, key press, etc.). Without this
// handler, auto-lock could trigger even during active use if before-input-event
// does not fire for certain event types.
ipcMain.on('user-activity', () => {
  resetIdleTimer();
});

// Language IPC handlers
ipcMain.handle('lang:get', () => {
  return getLang();
});
ipcMain.handle('lang:set', (_event, lang) => {
  setLang(lang);
  return true;
});

// Session status handler.  The preload script sends a boolean indicating
// whether the current profile is logged in.  Record the state for the
// active profile so that locking logic can be gated on it.  If no
// currentProfile is set, ignore the update.  The status is stored in
// hasSessionStatus keyed by profile name.
ipcMain.on('session:status', (_event, status) => {
  if (!currentProfile) return;
  hasSessionStatus[currentProfile] = !!status;
  // If the session becomes unauthenticated, clear any pending idle timer
  // so that a lock screen does not appear unexpectedly.
  if (!status) {
    clearTimeout(idleTimer);
  }
});

function createWindow() {
  const lowMem = !!store.get("lowMemoryMode");
  mainWindow = new BrowserWindow({
    title: "WAnjay",
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    icon: fs.existsSync(path.join(__dirname, "..", "..", "src", "assets", "wanjay.ico"))
      ? path.join(__dirname, "..", "..", "src", "assets", "wanjay.ico")
      : path.join(__dirname, "..", "assets", "wanjay.ico"),
    webPreferences: {
      // Note: the main window itself remains mostly empty. Actual content
      // (WhatsApp Web) is loaded into BrowserViews per profile. We still
      // enable a preload so that the lock overlay can communicate via IPC.
      preload: path.join(__dirname, "..", "preload", "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      spellcheck: !lowMem,
    },
  });

  // Use a blank page as the content for the window itself. Actual WhatsApp
  // content will be attached via BrowserViews when a profile is selected.
  mainWindow.loadURL('data:text/html,<html><body style="background:#0f172a;"></body></html>');

  // We deliberately avoid setting a user agent on the main window because
  // it will not host WhatsApp directly. User agents are set on each
  // BrowserView via ensureView().

  // (Opsional) open DevTools
  // mainWindow.webContents.openDevTools();

  // Biar link eksternal (misal ke browser) tidak buka jendela baru di app
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // buka di browser default
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // Hilangkan menu default (File, Edit, View, dll) kalau mau simple
  Menu.setApplicationMenu(null);

  // Always on top initial
  mainWindow.setAlwaysOnTop(Boolean(store.get("alwaysOnTop")));

  // Reset idle on input
  // We'll also listen for input on BrowserViews; however still reset on
  // events from the empty window to handle edge cases
  mainWindow.webContents.on("before-input-event", () => resetIdleTimer());
  resetIdleTimer();

  // When the window gains focus and a pending auto‑lock is set, display
  // the lock overlay immediately and clear the pending flag.  This
  // allows auto‑lock to defer showing the overlay until the user
  // actually returns to WAnjay.
  mainWindow.on('focus', () => {
    if (pendingAutoLock) {
      pendingAutoLock = false;
      // Only show the lock if a session is active; the gate inside
      // showLockWindow will handle session and pin checks.
      try { showLockWindow(false); } catch (_) {}
    }
  });

  // Initialise the tab bar view. It will be attached when a profile is
  // selected (via switchToProfile()), but the BrowserView must exist
  // beforehand.
  initTabBar();
}

// Event lifecycle
app.whenReady().then(() => {
  // Apply low-memory mode flags before creating windows
  if (store.get("lowMemoryMode")) {
    try {
      app.commandLine.appendSwitch("disable-http-cache");
      app.commandLine.appendSwitch("disk-cache-size", "0");
      app.commandLine.appendSwitch("media-cache-size", "0");
      app.commandLine.appendSwitch("process-per-site");
    } catch (_) {}
  }
  // Load profiles from disk. Ensure a default profile exists.
  profiles = loadProfiles();
  if (!Array.isArray(profiles) || profiles.length === 0) {
    profiles = ['default'];
    saveProfiles(profiles);
  }

  // Tray setup
  // Prefer src/assets if exists, fallback to root assets
  const trayIconPathSrc = path.join(__dirname, "..", "..", "src", "assets", "wanjay.ico");
  const trayIconUnreadPathSrc = path.join(__dirname, "..", "..", "src", "assets", "wanjay-unread.ico");
  const trayIconPathRoot = path.join(__dirname, "..", "assets", "wanjay.ico");
  const trayIconUnreadPathRoot = path.join(__dirname, "..", "assets", "wanjay-unread.ico");
  const trayIcon = fs.existsSync(trayIconPathSrc) ? nativeImage.createFromPath(trayIconPathSrc) : nativeImage.createFromPath(trayIconPathRoot);
  const trayIconUnread = fs.existsSync(trayIconUnreadPathSrc)
    ? nativeImage.createFromPath(trayIconUnreadPathSrc)
    : (fs.existsSync(trayIconUnreadPathRoot) ? nativeImage.createFromPath(trayIconUnreadPathRoot) : trayIcon);
  tray = new Tray(trayIcon);
  // Preserve default icon so we can restore it when unread count returns to zero
  defaultTrayImage = trayIcon;
  global.trayIconUnread = trayIconUnread;
  tray.setToolTip("WAnjay");
  // left-click toggles show/hide, right-click shows context menu
  tray.on("click", () => {
    if (!mainWindow) return;
    if (mainWindow.isVisible()) mainWindow.hide(); else { mainWindow.show(); mainWindow.focus(); }
  });
  tray.on("double-click", () => {
    if (!mainWindow) return;
    mainWindow.show();
    mainWindow.focus();
  });

  function getSettings() {
    return {
      compactMode: !!store.get("compactMode"),
      forceDark: !!store.get("forceDark"),
      hideSidebar: !!store.get("hideSidebar"),
      mute: Date.now() < (store.get("muteUntil") || 0),
      hidePreviews: !!store.get("hidePreviews"),
      presentationMode: !!store.get("presentationMode"),
      lowMemoryMode: !!store.get("lowMemoryMode"),
    };
  }

  function buildTrayMenu() {
    const lang = getLang();
    // translation helper
    const tr = (key) => {
      const dict = {
        'show': { id: 'Tampilkan WAnjay', en: 'Show WAnjay' },
        'alwaysOnTop': { id: 'Selalu di atas', en: 'Always on Top' },
        'mute': { id: 'Mode hening', en: 'Mute notifications' },
        'off': { id: 'Off', en: 'Off' },
        '1h': { id: '1 jam', en: '1 hour' },
        '8h': { id: '8 jam', en: '8 hours' },
        '24h': { id: '24 jam', en: '24 hours' },
        'hidePreviews': { id: 'Sembunyikan pratinjau', en: 'Hide previews' },
        'presentationMode': { id: 'Mode presentasi', en: 'Presentation mode' },
        'compactMode': { id: 'Mode kompak', en: 'Compact mode' },
        'forceDark': { id: 'Paksa mode gelap', en: 'Force dark mode' },
        'hideSidebar': { id: 'Sembunyikan sidebar', en: 'Hide sidebar' },
        'lowMemory': { id: 'Mode memori rendah', en: 'Low memory mode' },
        'runOnStartup': { id: 'Jalankan saat mulai', en: 'Run on startup' },
        'lockNow': { id: 'Kunci sekarang', en: 'Lock now' },
        'about': { id: 'Tentang WAnjay', en: 'About WAnjay' },
        'quit': { id: 'Keluar', en: 'Quit' },
      };
      return (dict[key] && dict[key][lang]) || key;
    };
    return Menu.buildFromTemplate([
      { label: tr('show'), click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } },
      { type: "separator" },
      { label: tr('alwaysOnTop'), type: "checkbox", checked: !!store.get("alwaysOnTop"), click: (mi) => {
          store.set("alwaysOnTop", mi.checked); if (mainWindow) mainWindow.setAlwaysOnTop(mi.checked);
        } },
      { label: tr('mute'), submenu: [
          { label: tr('off'), type: "radio", checked: !(Date.now() < (store.get("muteUntil") || 0)), click: () => { store.set("muteUntil", 0); notifySettingsChanged(); } },
          { label: tr('1h'), type: "radio", click: () => { store.set("muteUntil", Date.now() + 1*60*60*1000); notifySettingsChanged(); } },
          { label: tr('8h'), type: "radio", click: () => { store.set("muteUntil", Date.now() + 8*60*60*1000); notifySettingsChanged(); } },
          { label: tr('24h'), type: "radio", click: () => { store.set("muteUntil", Date.now() + 24*60*60*1000); notifySettingsChanged(); } },
        ] },
      { label: tr('hidePreviews'), type: "checkbox", checked: !!store.get("hidePreviews"), click: (mi)=>{ store.set("hidePreviews", mi.checked); notifySettingsChanged(); } },
      { label: tr('presentationMode'), type: "checkbox", checked: !!store.get("presentationMode"), click: (mi)=>{ store.set("presentationMode", mi.checked); notifySettingsChanged(); } },
      { type: "separator" },
      { label: tr('compactMode'), type: "checkbox", checked: !!store.get("compactMode"), click: (mi)=>{ store.set("compactMode", mi.checked); notifySettingsChanged(); } },
      { label: tr('forceDark'), type: "checkbox", checked: !!store.get("forceDark"), click: (mi)=>{ store.set("forceDark", mi.checked); notifySettingsChanged(); } },
      { label: tr('hideSidebar'), type: "checkbox", checked: !!store.get("hideSidebar"), click: (mi)=>{ store.set("hideSidebar", mi.checked); notifySettingsChanged(); } },
      { type: "separator" },
      { label: tr('lowMemory'), type: "checkbox", checked: !!store.get("lowMemoryMode"), click: (mi)=>{ store.set("lowMemoryMode", mi.checked); notifySettingsChanged(); if (Notification.isSupported()) new Notification({ title: lang === 'id' ? 'Perlu restart' : 'Restart needed', body: lang === 'id' ? 'Restart WAnjay untuk menerapkan mode memori rendah.' : 'Restart WAnjay to fully apply low-memory mode.' }).show(); } },
      { label: tr('runOnStartup'), type: "checkbox", checked: !!store.get("runOnStartup"), click: async (mi)=>{ store.set("runOnStartup", mi.checked); await applyAutoLaunchSetting(); } },
      { label: tr('lockNow'), click: () => {
          // If a PIN is not yet set, open the setup lock window unconditionally.
          if (!store.get("pinHash")) {
            lockAfterSetup = true;
            showLockWindow(true);
            return;
          }
          // If there is a PIN but no session, do not lock.  Instead, notify
          // the user that a WhatsApp session is required.
          if (!currentProfile || !hasSessionStatus[currentProfile]) {
            if (Notification.isSupported() && Date.now() > (store.get("muteUntil") || 0) && !store.get("presentationMode")) {
              const lang = getLang();
              const title = lang === 'id' ? 'Tidak dapat mengunci' : 'Cannot lock';
              const body = lang === 'id' ? 'Masuk WhatsApp dulu sebelum mengunci' : 'You must log in before locking';
              new Notification({ title, body }).show();
            }
            return;
          }
          // Otherwise, show the lock overlay normally.
          showLockWindow(false);
        } },
      { label: tr('about'), click: () => { showAbout(); } },
      { type: "separator" },
      { label: tr('quit'), click: () => quitApp() },
    ]);
  }

  function refreshTray() { tray.setContextMenu(buildTrayMenu()); }
  // Expose refreshTray so setLang() can call it later
  globalRefreshTray = refreshTray;
  function notifySettingsChanged() {
    refreshTray();
    // Broadcast updated settings to all profile views so they can apply
    const settings = getSettings();
    for (const p of Object.keys(views)) {
      const v = views[p];
      try { v.webContents.send('settings-updated', settings); } catch (_) {}
    }
  }
  ipcMain.handle("settings:get", () => getSettings());
  refreshTray();

  // Auto-launch
  applyAutoLaunchSetting();

  // Global shortcut: Ctrl+Alt+W
  globalShortcut.register("Control+Alt+W", () => {
    if (!mainWindow) return;
    if (mainWindow.isVisible()) { mainWindow.hide(); } else { mainWindow.show(); mainWindow.focus(); }
  });

  // Downloads are handled per-profile session in ensureView().

  // Unread overlay/badge
  ipcMain.on("unread-count", (_e, count) => {
    unreadCount = count || 0;
    // Taskbar overlay on Windows
    if (process.platform === "win32" && mainWindow) {
      if (unreadCount > 0) mainWindow.setOverlayIcon(getRedDotOverlay(), `${unreadCount} unread`);
      else mainWindow.setOverlayIcon(null, "");
    } else if (process.platform === "darwin") {
      // Dock badge on macOS
      app.setBadgeCount(unreadCount);
    }
    // Update tray tooltip with unread count
    if (tray) {
      const lang = getLang();
      if (unreadCount > 0) {
        if (lang === 'id') {
          tray.setToolTip(`WAnjay - ${unreadCount} pesan belum dibaca`);
        } else {
          tray.setToolTip(`WAnjay - ${unreadCount} unread`);
        }
        // Use a proper unread icon if available
        try {
          tray.setImage(global.trayIconUnread || defaultTrayImage);
        } catch (_) {
          tray.setImage(defaultTrayImage);
        }
      } else {
        tray.setToolTip('WAnjay');
        try {
          tray.setImage(defaultTrayImage);
        } catch (_) {}
      }
    }
  });

  createWindow();

  // After the main window is ready, prompt the user to choose a profile.
  // The window will remain blank until a profile is selected. Once
  // selected, switchToProfile() will attach the appropriate view.
  showProfileSelector();

  // Build App Menu with auto-lock options
  function setAutoLock(mins) { store.set("autoLockMinutes", mins); resetIdleTimer(); refreshAppMenu(); }
  function refreshAppMenu() {
    const mins = Number(store.get("autoLockMinutes")) || 0;
    const alwaysOnTop = !!store.get("alwaysOnTop");
    const runOnStartup = !!store.get("runOnStartup");
    const lowMem = !!store.get("lowMemoryMode");
    async function relocateDataFolder() {
      const res = await dialog.showOpenDialog({
        title: "Pilih folder data WAnjay",
        properties: ["openDirectory", "createDirectory"],
      });
      if (res.canceled || !res.filePaths || !res.filePaths[0]) return;
      const chosenBase = res.filePaths[0];
      const newDir = path.join(chosenBase, "WAnjayData");
      const currentDir = app.getPath("userData");
      if (path.resolve(newDir) === path.resolve(currentDir)) {
        new Notification({ title: "Data Folder", body: "Lokasi sudah digunakan." }).show();
        return;
      }
      try {
        fs.mkdirSync(newDir, { recursive: true });
        // Try fast move; fallback to copy+remove if cross-device
        try {
          fs.renameSync(currentDir, newDir);
        } catch (_e) {
          await fs.promises.cp(currentDir, newDir, { recursive: true });
          await fs.promises.rm(currentDir, { recursive: true, force: true });
        }
        writeDataDirOverrideToConfig(newDir);
        new Notification({ title: "Relokasi Data", body: "Berhasil. Aplikasi akan restart." }).show();
        isQuitting = true;
        app.relaunch();
        app.exit(0);
      } catch (err) {
        new Notification({ title: "Relokasi gagal", body: String(err && err.message || err) }).show();
      }
    }
    const currentLang = getLang();
    const template = [
      { label: "WAnjay", submenu: [
        { label: "Show", click: ()=>{ if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } },
        { label: "Lock Now", click: ()=> {
          // If no PIN, enter setup mode.
          if (!store.get("pinHash")) {
            lockAfterSetup = true;
            showLockWindow(true);
            return;
          }
          // Allow the lock overlay to appear even if the session status
          // has not yet been detected (force).  This ensures the lock
          // always appears when the user explicitly chooses to lock now.
          showLockWindow(false, true);
        } },
        { type: "separator" },
        { label: "Always on Top", type: "checkbox", checked: alwaysOnTop, click: (mi)=>{ store.set("alwaysOnTop", mi.checked); if (mainWindow) mainWindow.setAlwaysOnTop(mi.checked); } },
        { label: "Auto-lock", submenu: [
          { label: "Off", type: "radio", checked: mins===0, click: ()=> setAutoLock(0) },
          { label: "1 minute", type: "radio", checked: mins===1, click: ()=> setAutoLock(1) },
          { label: "5 minutes", type: "radio", checked: mins===5, click: ()=> setAutoLock(5) },
          { label: "10 minutes", type: "radio", checked: mins===10, click: ()=> setAutoLock(10) },
          { label: "30 minutes", type: "radio", checked: mins===30, click: ()=> setAutoLock(30) },
        ]},
        { type: "separator" },
        { label: "Relocate Data Folder...", click: () => { relocateDataFolder(); } },
        { type: "separator" },
        { label: "Low memory mode", type: "checkbox", checked: lowMem, click: (mi)=>{ store.set("lowMemoryMode", mi.checked); refreshAppMenu(); if (Notification.isSupported()) new Notification({ title: "Restart needed", body: "Restart WAnjay to fully apply low-memory mode." }).show(); } },
        { label: "Run on startup", type: "checkbox", checked: runOnStartup, click: async (mi)=>{ store.set("runOnStartup", mi.checked); await applyAutoLaunchSetting(); } },
        // Language selection submenu
        { label: currentLang === 'id' ? 'Bahasa' : 'Language', submenu: [
          { label: 'Bahasa Indonesia', type: 'radio', checked: currentLang === 'id', click: ()=> { setLang('id'); } },
          { label: 'English', type: 'radio', checked: currentLang === 'en', click: ()=> { setLang('en'); } },
        ] },
        { label: currentLang === 'id' ? 'Tentang WAnjay' : 'About WAnjay', click: ()=> { showAbout(); } },
        { type: "separator" },
        { label: "Quit", click: ()=> { isQuitting = true; app.quit(); } },
      ]},
      { label: "View", submenu: [
        { role: "reload" },
        { role: "toggledevtools" }
      ]}
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  }
  // Expose refreshAppMenu so setLang() can call it later
  globalRefreshAppMenu = refreshAppMenu;
  refreshAppMenu();

  // Broadcast the initial language to all views so they can localise UI
  notifyLanguageChanged();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  // Di macOS aplikasi biasanya tetap hidup sampai Cmd+Q
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  isQuitting = true;
  try { globalShortcut.unregisterAll(); } catch (_) {}
  try { if (tray) tray.destroy(); } catch (_) {}
});

// Minimize to tray on close button
app.on("browser-window-created", (_e, win) => {
  win.on("close", (evt) => {
    // Only intercept main window close to hide to tray
    if (win === mainWindow && !isQuitting) {
      evt.preventDefault();
      win.hide();
    }
  });
});
