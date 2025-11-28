const { contextBridge, ipcRenderer } = require('electron');

/**
 * Preload script for the rename overlay window.  It exposes an API to
 * the renderer to perform the rename operation and to close the window.
 * It also listens for initial data from the main process (`rename-data`)
 * which contains the profile name to rename.  The language can be
 * fetched on demand via `lang:get` in order to localise strings.
 */

let initialName = '';

// Receive initial data (oldName) from main process
ipcRenderer.on('rename-data', (_event, { oldName }) => {
  initialName = String(oldName || '');
  // Notify the web page via a custom event so it can pre-fill the form
  window.dispatchEvent(new CustomEvent('rename-data', { detail: { oldName: initialName } }));
});

contextBridge.exposeInMainWorld('renameAPI', {
  /**
   * Returns the current language ('id' or 'en').  Used to localise UI.
   */
  getLang() {
    return ipcRenderer.invoke('lang:get');
  },
  /**
   * Perform the rename operation.  Returns a promise resolving to
   * { ok, msg, profiles, current }.  This proxies to the existing
   * profiles:rename handler in the main process.
   * @param {string} oldName
   * @param {string} newName
   */
  rename(oldName, newName) {
    return ipcRenderer.invoke('profiles:rename', oldName, newName);
  },
  /**
   * Request that the rename overlay be closed.  The main process
   * will destroy the window.
   */
  close() {
    ipcRenderer.send('rename:close');
  },
  /**
   * Return the initial profile name passed by the main process.  This
   * value is set once when the window is created.
   */
  getInitialName() {
    return initialName;
  },
});