<div align="center">
  <img src="frontend/public/icon.png" alt="Prado Chat Logo" width="120" />

  # Prado Chat

  A modern, self-hosted, real-time messaging platform styled after Google Messages, designed for secure home labs, private groups, and teams. Built from the ground up to be lightweight, incredibly fast, and run reliably in Docker environments.

  [Features](#features) •
  [Tech Stack](#tech-stack) •
  [Quick Start (Docker)](#quick-start-with-docker) •
  [Development Setup](#local-development)
</div>

---

## ✨ Features

- **Zero-Trust End-to-End Encryption (E2EE)**: Messages and keys are mathematically secured locally in the browser utilizing native `WebCrypto` primitives (`RSA-OAEP` for PKI identity, `AES-GCM` for Room Keys). The SQLite backend stores purely encrypted ciphertexts unconditionally.
- **Real-Time Communication**: Instant messaging powered by ultra-low-latency WebSockets via `Socket.io`.
- **Dynamic Workspaces ("Spaces")**: Create public channels for everyone or secure, lock-protected private spaces.
- **Modern Google Messages UI**: Beautifully crafted Dual-Pane layout featuring a responsive sidebar, floating chat inputs, and seamless mobile transitions.
- **WebRTC Video Rooms**: Integrated peer-to-peer video & audio calls right in your chat spaces.
- **Rich Media & Attachments**: 
  - Drag-and-drop secure file sharing
  - Custom Emoji Picker built-in
  - Auto-searching, debounced integrated GIF engine (via Giphy)
- **Slack-Style Rich Text Editor**: ContentEditable input with live inline formatting — type `**bold**`, `*italic*`, `` `code` ``, or `~~strike~~` and watch the syntax markers vanish as formatting appears in-place. Includes a floating format toolbar (Bold, Italic, Strikethrough, Code) on text selection. Sent messages render full Markdown (tables, blockquotes, lists, headings) via `marked` + `DOMPurify`.
- **Admin Dashboard**: Full internal control panel to manage user roles, delete spaces, audit chat logs, and orchestrate global app settings.
- **Progressive Web App (PWA)**: Installable as a native app on iOS, Android, macOS, and Windows. Full offline support with service worker caching policy, push notifications with E2EE-aware decryption, and iOS-optimized `apple-mobile-web-app` meta tags.
- **Push Notifications**: E2EE-aware Web Push with grouped notification stacking per-space, inline reply actions (Android), and one-tap deep-linking into the target conversation.
- **Customizable Theming & Typography**: Dynamically updates UI accents, features a partitioned subset of the 1,500+ Google Fonts natively, and ships with a real-time UI Scaling slider leveraging continuous CSS `rem` ratios natively across the client.
- **Resilient Connection States**: Real-time network detection seamlessly swapping avatar states and suppressing active boundaries if the backend WebSocket drops out.
- **Accessibility**: Respects `prefers-reduced-motion`, proper semantic HTML, iOS safe area insets for notch/Dynamic Island devices.

---

## 🛠 Tech Stack

**Frontend**
- React 18 / Vite ⚡️
- Vanilla CSS (CSS Grid + Custom Variables)
- **WebCrypto API Native** (AES-GCM / RSA-OAEP Asymmetric Keys)
- `Simple-Peer` for WebRTC Video/Audio
- `emoji-picker-react`
- `marked` + `DOMPurify` (Markdown rendering & XSS sanitization)

**Backend**
- Node.js & Express
- SQLite3 (zero-configuration local persistence)
- `Socket.io` (Real-Time Bidirectional Event Engine)
- JSON Web Tokens (JWT) & bcrypt (Authentication)
- `web-push` (VAPID Web Push Notifications)

**Deployment**
- Fully Containerized (Docker & Docker Compose)
- Auto-bridged Nginx Reverse Proxy (Frontend routing & WebSocket upgrading)
- Service Worker with offline fallback, cache versioning, and no-cache policy via nginx
- Watchtower auto-update support for continuous deployment

---

## 🚀 Quick Start with Docker

The easiest way to run Prado Chat is via Docker Compose. The environment is orchestrated to automatically route Nginx on standard ports and mount SQLite inside a secure Docker Volume.

1. **Clone the repository**
   ```bash
   git clone https://github.com/skyking83/prado-chat.git
   cd prado-chat
   ```

2. **Configure your Environment**
   Create a `.env` file in the project root:
   ```env
   JWT_SECRET=super_secret_key_change_me
   RESEND_API_KEY=your_resend_api_key
   GIPHY_API_KEY=your_giphy_api_key
   ```

3. **Spin up the stack**
   ```bash
   # Make sure Docker Desktop / Engine is running
   docker-compose up -d
   ```

4. **Access the App**
   Open your browser and navigate to `http://localhost:30099`.

---

## 💻 Local Development

If you want to contribute, tweak styles, or run the components locally without Docker, follow these steps:

### 1. Start the SQLite Backend
```bash
cd backend
npm install
npm run dev
```
*(The backend runs on `http://localhost:3001`)*

### 2. Start the Vite Frontend Server
```bash
# In a new terminal window
cd frontend
npm install
npm run dev
```
*(The frontend runs on `http://localhost:5173` and proxies API/WebSocket to the backend)*

---

## 🔑 Default Administrator

If you are spinning the application up from a clean slate, the first user you register will automatically be granted the **`admin`** role. All subsequent registrations will be tagged as standard `users`. 

To manage your instance, simply click your avatar in the Top App Bar, and hit the **Admin Panel** gear. 

---

## 📱 PWA Installation

Prado Chat is a fully installable Progressive Web App:

- **Android**: Tap the "Install App" option in the user menu, or use Chrome's "Add to Home Screen"
- **iOS**: In Safari, tap the Share button → "Add to Home Screen"
- **Desktop**: Click "Install App" in the user dropdown or use the browser's install icon in the address bar

The PWA includes offline detection with a branded fallback page, app shortcuts, and full push notification support.

---

## 📄 License & Privacy

Built as a private, self-hosted sanctuary. You own your data. End-of-story. 

<div align="center">
  <sub>Made with ❤️ for the HomeLab community.</sub>
</div>
