const { contextBridge, ipcRenderer } = require('electron');

/**
 * Preload script for the tab bar. It provides a small API
 * for receiving profile updates from the main process and
 * requesting profile switches back to the main process. This
 * enables the tab bar UI (tabbar.html) to remain simple and
 * decoupled from Electron's IPC mechanisms. The API is exposed
 * on `window.profileTabs`.
 */

const listeners = [];

// Listen for updates from main process and forward to all registered callbacks
ipcRenderer.on('profiles:update', (_event, data) => {
  listeners.forEach(fn => {
    try { fn(data); } catch (_) {}
  });
});

contextBridge.exposeInMainWorld('profileTabs', {
  /**
   * Register a listener to be called whenever the set of profiles or
   * the current profile changes. The callback receives an object
   * `{ profiles: string[], current: string }`.
   * @param {Function} callback
   */
  onUpdate(callback) {
    if (typeof callback === 'function') listeners.push(callback);
  },
  /**
   * Request to switch to a different profile. The main process will
   * respond by swapping the BrowserView. Nothing is returned.
   * @param {string} name
   */
  switchTo(name) {
    ipcRenderer.send('profile:switch', name);
  },

  /**
   * Request to add a new profile. The main process will open the
   * profile selector overlay so the user can create or select another
   * profile. Nothing is returned.
   */
  addNew() {
    ipcRenderer.send('profile:add');
  },

  /**
   * Rename an existing profile.  Returns a promise resolving to
   * an object { ok, msg, profiles, current }.  The main process will
   * perform validation and update its state accordingly.
   * @param {string} oldName
   * @param {string} newName
   */
  rename(oldName, newName) {
    return ipcRenderer.invoke('profiles:rename', oldName, newName);
  },

  /**
   * Open a rename dialog for the specified profile.  The main process
   * will create a separate overlay window with an input field.  Once
   * the user enters a new name, the rename request is sent back to
   * the main process.  Nothing is returned.
   * @param {string} name
   */
  openRename(name) {
    ipcRenderer.send('rename:open', name);
  },

  /**
   * Delete a profile.  Returns a promise resolving to
   * { ok, msg, profiles, current }.  Deletion may fail if it is the last
   * profile.  The main process will handle switching to another profile.
   * @param {string} name
   */
  delete(name) {
    return ipcRenderer.invoke('profiles:delete', name);
  },

  /**
   * Get the current language.  Returns a promise resolving to the
   * language code ('id' or 'en').
   */
  getLang() {
    return ipcRenderer.invoke('lang:get');
  },

  /**
   * Register a listener for language changes.  The callback is called
   * whenever the language is updated by the main process, with the new
   * language code as its parameter.
   * @param {Function} callback
   */
  onLangUpdate(callback) {
    if (typeof callback === 'function') {
      ipcRenderer.on('language', (_e, lang) => callback(lang));
    }
  },
});