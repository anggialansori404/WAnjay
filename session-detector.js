/*
 * session-detector.js
 *
 * This module exports a helper to detect whether the user is logged in to
 * WhatsApp Web.  It works by inspecting certain values in the page's
 * localStorage.  When WhatsApp Web is paired to a phone, localStorage
 * contains authentication tokens (for example, `last-wid` or
 * `last-wid-md`) which persist between sessions.  When the page is
 * showing the QR code (i.e. the user has not paired yet), these keys
 * are absent.  The detector periodically checks for the presence of
 * these keys and invokes a callback whenever the login state changes.
 *
 * Note: This logic runs inside the preload context of a BrowserView and
 * therefore has access to the page's DOM and localStorage (but not
 * Node APIs when contextIsolation is enabled).  See Electron docs
 * regarding preload scripts for details【515250691700918†L239-L244】.
 */

/**
 * Start watching the login status on WhatsApp Web.  The provided
 * callback will be invoked with a boolean whenever the login state
 * transitions.  `true` indicates that a session appears to exist
 * (paired), whereas `false` indicates that the page is on the QR code
 * screen or otherwise unauthenticated.
 *
 * @param {(loggedIn: boolean) => void} callback
 */
function watchLoginStatus(callback) {
  let lastState = null;
  function check() {
    let isLoggedIn = false;
    try {
      // WhatsApp Web stores a token identifying the last connected phone
      // in localStorage under keys like 'last-wid' or 'last-wid-md'.  If
      // these values are present and non-empty, the user is currently
      // authenticated.  When not logged in, these entries are undefined.
      const keys = ['last-wid', 'last-wid-md', 'WABrowserId', 'WAToken1', 'WAToken2'];
      for (const key of keys) {
        const val = window.localStorage.getItem(key);
        if (val && typeof val === 'string' && val.trim().length > 0) {
          isLoggedIn = true;
          break;
        }
      }
    } catch (_) {
      // In case accessing localStorage throws (shouldn't on same origin),
      // treat as not logged in.
      isLoggedIn = false;
    }
    if (lastState !== isLoggedIn) {
      lastState = isLoggedIn;
      try {
        callback(isLoggedIn);
      } catch (_) {}
    }
  }
  // Perform an initial check immediately
  check();
  // Continue polling every 5 seconds
  return setInterval(check, 5000);
}

module.exports = { watchLoginStatus };