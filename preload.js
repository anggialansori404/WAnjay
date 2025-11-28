// preload.js
const { contextBridge, ipcRenderer } = require("electron");

// Kalau nanti butuh expose API ke page, kita bisa pakai ini:
let settings = { compactMode: false, forceDark: false, hideSidebar: false, mute: false, hidePreviews: false, presentationMode: false };

async function loadSettings() {
  try { settings = await ipcRenderer.invoke("settings:get"); } catch (_) {}
}

// CSS injection helpers
function applyCSS() {
  const styleId = "wanjay-style";
  let el = document.getElementById(styleId);
  if (!el) { el = document.createElement("style"); el.id = styleId; document.head.appendChild(el); }
  const css = [];
  if (settings.compactMode) {
    css.push(`html *{font-size:95%} ._ak73, ._ak8l { padding: 4px !important; }`);
  }
  if (settings.forceDark) {
    css.push(`@media (prefers-color-scheme: light){ html { filter: invert(1) hue-rotate(180deg); } img, video { filter: invert(1) hue-rotate(180deg); } }`);
  }
  if (settings.hideSidebar) {
    css.push(`div[role="navigation"], [data-testid="chatlist-panel"]{ display:none !important }`);
  }
  el.textContent = css.join("\n");
}

// Override Notification to support mute and preview-hiding
const OriginalNotification = window.Notification;
class WrappedNotification extends OriginalNotification {
  constructor(title, options = {}) {
    const nowMuted = settings.mute || settings.presentationMode;
    if (nowMuted) {
      super("", { silent: true, body: "" });
      return;
    }
    if (settings.hidePreviews && options) {
      options = { ...options, body: "Pesan baru" };
    }
    super(title, options);
  }
}

// Observe title to infer unread count e.g. "(3) WhatsApp"
function watchTitleForUnread() {
  const cb = () => {
    const m = /^\((\d+)\)/.exec(document.title);
    const count = m ? parseInt(m[1], 10) : 0;
    ipcRenderer.send("unread-count", count);
  };
  const obs = new MutationObserver(cb);
  obs.observe(document.querySelector("title"), { childList: true });
  cb();
}

contextBridge.exposeInMainWorld("electronAPI", {
  getSettings: async () => { await loadSettings(); return settings; },
});

// Simple log buat cek preload jalan
window.addEventListener("DOMContentLoaded", () => {
  console.log("Preload loaded for WhatsApp Electron");
  try { window.Notification = WrappedNotification; } catch (_) {}
  loadSettings().then(applyCSS);
  ipcRenderer.on("settings-updated", async (_e, s) => { settings = s; applyCSS(); });
  watchTitleForUnread();

  // Lock blur overlay
  const overlayId = "wanjay-lock-overlay";
  function setLockedOverlay(locked) {
    let el = document.getElementById(overlayId);
    if (!locked) {
      if (el) el.remove();
      document.documentElement.style.pointerEvents = "";
      return;
    }
    if (!el) {
      el = document.createElement("style");
      el.id = overlayId;
      document.head.appendChild(el);
    }
    el.textContent = `
      html.is-locked { filter: blur(6px) brightness(0.8); }
      html.is-locked, html.is-locked body, html.is-locked * { user-select: none !important; }
    `;
    document.documentElement.classList.add("is-locked");
    document.documentElement.style.pointerEvents = "none";
  }
  ipcRenderer.on("locked", (_e, locked) => {
    if (!locked) {
      document.documentElement.classList.remove("is-locked");
      setLockedOverlay(false);
    } else {
      setLockedOverlay(true);
    }
  });

  // Activity events to reset idle timer. Listen for various user interactions
  // and notify the main process that the user is active. This works around
  // limitations where before-input-event may not fire for certain pointer
  // events within BrowserViews. Throttle via the main process as needed.
  const activityEvents = ["mousemove", "mousedown", "mouseup", "keydown", "keyup", "wheel", "touchstart", "touchmove"];
  activityEvents.forEach((evt) => {
    window.addEventListener(evt, () => {
      ipcRenderer.send('user-activity');
    }, { passive: true });
  });
});
