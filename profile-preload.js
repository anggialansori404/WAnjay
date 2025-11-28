const { contextBridge, ipcRenderer } = require('electron');

/**
 * Expose APIs to the profile selection window. This preload bridges the
 * renderer and main process for listing, creating, and selecting user
 * profiles. Profiles allow WAnjay to maintain separate WhatsApp sessions
 * (cookies, local storage, etc.) for different accounts.  The list of
 * profiles is managed by the main process via IPC.
 */

contextBridge.exposeInMainWorld('profileAPI', {
  /**
   * Retrieve the list of existing profiles. Returns a promise that
   * resolves to an array of profile names.
   */
  getProfiles: () => ipcRenderer.invoke('profiles:list'),
  /**
   * Create a new profile. Accepts a proposed name and returns a
   * promise which resolves to an object `{ ok: boolean, msg?: string, profiles?: string[] }`.
   */
  createProfile: (name) => ipcRenderer.invoke('profiles:create', name),
  /**
   * Finalise selection of a profile. This does not return a value but
   * sends an event back to the main process which will close the profile
   * selector and continue startup.
   */
  chooseProfile: (name) => ipcRenderer.send('profile:selected', name),
});

// Expose language APIs for the profile selection UI.  The UI can call
// getLang() to retrieve the current language and onLangUpdate() to
// listen for changes.
contextBridge.exposeInMainWorld('langAPI', {
  /**
   * Get the current language code ('id' or 'en').  Returns a promise.
   */
  getLang: () => ipcRenderer.invoke('lang:get'),
  /**
   * Register a listener for language updates.  The callback receives
   * the new language code whenever the language changes.
   */
  onUpdate: (callback) => {
    if (typeof callback === 'function') {
      ipcRenderer.on('language', (_e, lang) => callback(lang));
    }
  },
});