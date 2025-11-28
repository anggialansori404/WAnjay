# WAnjay – WhatsApp Web Desktop Wrapper

WAnjay is a modern desktop wrapper for WhatsApp Web, built with Electron. It lets you run WhatsApp on your desktop with features not available in the official web or desktop clients, such as multi‑profile support, PIN‑based locking, and extensive customisation. WAnjay aims to stay lightweight and unobtrusive while giving power users full control over their messaging experience.

> **Note:** WAnjay is an independent project and is not affiliated with WhatsApp Inc. It uses WhatsApp Web under the same limitations and terms of service as any web browser. Do not use WAnjay for spam or other abusive behaviour.

---

## Features

### 🗂 Multi‑profile management
- **Multiple profiles:** Run several WhatsApp accounts side by side. Each profile uses its own persistent Electron session (via the `persist:wanjay-<profile>` partition), so cookies and localStorage remain isolated. Profiles are saved to disk and persist across restarts.
- **Tab bar interface:** A sleek tab bar lists your profiles. Click a tab to switch immediately; the underlying page does not reload, thanks to Electron’s BrowserView management.
- **Add, rename and delete:** Use the “+” button to create a new profile. Profiles can be renamed via a pencil icon or double‑clicking on a tab, and removed via the × icon. Validation prevents duplicate names.
- **Profile selector:** A full‑screen overlay makes it easy to choose or create a profile on first launch or when switching from the tray menu.

### 🔒 Secure locking system
- **PIN protection:** Protect your chats with a user‑defined PIN. If enabled, WAnjay will prompt you to enter the PIN before showing any WhatsApp content.
- **Manual and automatic locking:** Lock instantly from the tray or application menu. An auto‑lock feature locks the app after a period of inactivity (1, 5, 10, or 30 minutes). User activity such as mouse movement or typing resets the timer.
- **Session detection:** The lock only triggers when a valid WhatsApp session is paired. If no session exists (e.g. on the QR screen), the lock overlay is suppressed to avoid needless prompts.
- **Deferred locking:** When auto‑lock triggers while the app is running in the background, WAnjay shows a notification (e.g. “Kunci otomatis aktif”) instead of interrupting your current workflow. The lock overlay appears the moment you return to the app.
- **Customisable overlay:** The lock overlay sits below the tab bar, letting you switch profiles even when locked. Dark and light styles are supported through your settings.

### 🛠 User‑tunable preferences
WAnjay exposes many settings, stored persistently via [electron-store](https://github.com/sindresorhus/electron-store):
- **Always on Top:** Keep the window above other apps.
- **Run on Startup:** Launch WAnjay automatically when you sign in to your desktop.
- **Compact Mode:** Reduce spacing and font sizes to fit more information on screen.
- **Dark Mode / Force Dark:** Use WhatsApp’s dark mode or force dark colours on all pages.
- **Hide Sidebar:** Collapse the chat list sidebar for a distraction‑free view.
- **Mute Notifications:** Temporarily silence notifications until a specified time; hide message previews for privacy.
- **Presentation Mode:** Suppress notifications entirely during presentations.
- **Low Memory Mode:** Disable spell‑checking and cache to conserve RAM.
- **Language:** Switch between Indonesian (id) and English (en). All UI labels, dialogs and menu entries update instantly.

### 🔔 System tray integration
- **Tray icon:** WAnjay minimises to the system tray and can be shown or hidden with a single click. A red badge indicates unread messages; the tooltip displays the unread count.
- **Context menu:** Right‑click the tray icon to access quick actions: Show/Hide, Lock Now, Auto‑lock settings, Always on Top, Run on Startup, language selection, and About WAnjay.
- **Unread counter:** The app observes WhatsApp’s page title and updates the tray badge whenever new messages arrive.

### 💬 Other niceties
- **Notifications & downloads:** WAnjay forwards WhatsApp Web notifications to your desktop. Optional “hide preview” mode shows generic alerts (“Pesan baru”/“New message”). Downloaded files are automatically saved to a Downloads subfolder and a notification appears when complete.
- **Spellcheck:** Automatic spell‑checking for English and Indonesian (disabled in low‑memory mode).
- **Unobtrusive:** New windows and external links open in your default browser. The app hides its menu bar for a clean look.
- **Custom data directory:** Set `WANJAY_DATA_DIR` in your environment or `wanjay.config.json` to specify where profile data is saved.

---

## Getting Started

### Prerequisites
- Node.js (v14 or later recommended) and npm
- Git if you plan to clone the repository

### Development setup
```sh
git clone <repository-url>
cd wanjay
```
Install dependencies:
```sh
npm install
```
Run in development mode:
```sh
npm start
```
A window will open with the WAnjay interface. Use the profile selector to pair your first account by scanning the QR code. You can then explore the settings via the tray or application menu.

### Building distributions
WAnjay uses [electron-builder](https://www.electron.build/) to produce native installers for Windows, macOS and Linux. You can customise the product name, icons and targets in `package.json`.

To build the default targets (NSIS on Windows, DMG on macOS, AppImage on Linux):
```sh
npm run dist
```
The packages will be generated in the `dist/` folder.

---

## Usage tips
- Switch profiles quickly by clicking the tab bar. The app remembers the last active profile on restart.
- Rename or delete a profile using the pencil (rename) and × (delete) icons on each tab. Deleting the last remaining profile is disallowed.
- Manually lock with Ctrl+Shift+L (or via the tray menu) when you step away. After the auto‑lock timer expires, WAnjay shows a notification if the window is in the background and only displays the PIN prompt when you return.
- Change language on the fly from the menu: WAnjay instantly reflects your choice in the tab bar, dialogs and menus.
- **Troubleshooting login detection:** WAnjay detects a WhatsApp session by looking for certain localStorage keys (e.g. `last-wid` and `last-wid-md`). If the lock does not appear after pairing, wait ~30 seconds; a fallback will treat the session as active even if detection fails. You can still lock manually at any time.

---

## Contributing
Pull requests and feature suggestions are welcome! Please open an issue to discuss changes before submitting a PR. Ensure that your contribution does not violate WhatsApp’s terms of service and that your code follows the project’s formatting conventions.

## License
This project is released under the MIT License. See [LICENSE](LICENSE) for details.
