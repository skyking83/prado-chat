<div align="center">
  <img src="frontend/public/icon.png" alt="Prado Chat Logo" width="120" />

  # Prado Chat

  A modern, self-hosted, real-time messaging platform styled after Google Messages, designed for secure home labs, private groups, and teams. Built from the ground up to be lightweight, incredibly fast, and run reliably in Docker environments.

  [![Docker Pulls](https://img.shields.io/docker/pulls/skyking83/prado-chat-frontend?style=flat-square&logo=docker&label=Frontend%20Pulls)](https://hub.docker.com/r/skyking83/prado-chat-frontend)
  [![Docker Pulls](https://img.shields.io/docker/pulls/skyking83/prado-chat-backend?style=flat-square&logo=docker&label=Backend%20Pulls)](https://hub.docker.com/r/skyking83/prado-chat-backend)

  [Features](#-features) •
  [Video Rooms](#-webrtc-video-rooms) •
  [Tech Stack](#-tech-stack) •
  [Quick Start (Docker)](#-quick-start-with-docker) •
  [Development Setup](#-local-development)
</div>

---

## ✨ Features

### 🔐 Zero-Trust End-to-End Encryption (E2EE)
Messages and keys are mathematically secured locally in the browser utilizing native `WebCrypto` primitives (`RSA-OAEP` for PKI identity, `AES-GCM` for Room Keys). The SQLite backend stores purely encrypted ciphertexts — the server **never** has access to plaintext message content.

### 💬 Real-Time Communication
Instant messaging powered by ultra-low-latency WebSockets via `Socket.io` with resilient reconnection handling, real-time typing indicators, and online/offline presence detection.

### 🏢 Dynamic Workspaces ("Spaces")
Create public channels for everyone or secure, lock-protected private spaces. Built-in **Notes to Self** personal space with deletion protection. Direct messages with per-user DM channels.

### 🎨 Modern Google Messages UI
Beautifully crafted Dual-Pane layout with responsive sidebar, floating chat inputs, infinite scroll message history, pinned messages board, and seamless mobile transitions.

### 📹 WebRTC Video & Audio Rooms
Full-featured peer-to-peer video conferencing built right into your chat spaces — see [detailed breakdown below](#-webrtc-video-rooms).

### ✍️ Slack-Style Rich Text Editor
ContentEditable input with **live inline formatting** — type `**bold**`, `*italic*`, `` `code` ``, or `~~strike~~` and watch the syntax markers vanish as formatting appears in-place. Features:
- Floating format toolbar (Bold, Italic, Strikethrough, Code) appears on text selection
- Full Markdown rendering for sent messages (tables, blockquotes, lists, headings, code blocks) via `marked` + `DOMPurify`
- Paste-aware: pasted formatted text auto-converts to markdown patterns
- Works in both message composition and inline message editing

### 📎 Rich Media & Attachments
- Drag-and-drop secure file sharing with progress indicators
- Custom Emoji Picker built-in
- Auto-searching, debounced integrated GIF engine (via Giphy)
- Video message thumbnails with inline playback

### 🔔 Push Notifications
E2EE-aware Web Push with grouped notification stacking per-space, inline reply actions (Android), and one-tap deep-linking into the target conversation.

### 🛡️ Admin Dashboard
Full internal control panel — manage user roles, delete spaces (with Notes to Self protection), audit chat logs, and orchestrate global app settings from a dedicated admin panel.

### 📱 Progressive Web App (PWA)
Installable as a native app on iOS, Android, macOS, and Windows:
- Service worker with offline fallback page and cache versioning
- 512px maskable icons for Android adaptive icon support
- iOS Safari `apple-mobile-web-app` meta tags and Dynamic Island safe area support
- Home screen shortcuts for quick access

### 🎨 Customizable Theming & Typography
- Dynamically switchable UI accent colors
- 1,500+ Google Fonts natively integrated
- Real-time UI Scaling slider with continuous CSS `rem` ratio adjustments
- Dark / Light mode toggle

### ♿ Accessibility
- Respects `prefers-reduced-motion` (disables all animations/transitions)
- Proper semantic HTML structure
- iOS safe area insets for notch/Dynamic Island devices
- No forced zoom prevention (user-scalable preserved)

### 🔗 Resilient Connection States
Real-time network detection seamlessly swapping avatar states, suppressing active boundaries on WebSocket drops, and automatic reconnection with exponential backoff.

---

## 📹 WebRTC Video Rooms

Prado Chat includes a complete, browser-native video conferencing system — no external services, no plugins, fully peer-to-peer.

### Pre-Join Lobby
- Live camera preview with mirror effect
- Microphone level meter bar (real-time audio visualization)
- Device selectors: pick your camera, microphone, and speaker
- Audio-only toggle for low-bandwidth calls
- Join Call / Cancel controls

### In-Call Features
- **Screen Sharing** via `getDisplayMedia` with automatic track replacement
- **Fullscreen Mode** for immersive video experience
- **Picture-in-Picture (PiP)** floating resizable window — keep chatting while on a call
- **Adaptive Grid Layouts**: solo, side-by-side (duo), 2×2 (quad), 3×2 (six), and scrollable grid for 7+ participants
- **Presentation Mode**: click any participant to pin them to the main stage with a side strip for other participants
- **Active Speaker Detection** via `AudioContext` + `AnalyserNode` with green pulsing border highlight
- **Connection Quality Monitor**: real-time RTT, packet loss, and bitrate stats with per-participant quality dots
- **Call Duration Timer** displayed in header (MM:SS / HH:MM:SS)
- **Audio Processing**: noise suppression, echo cancellation, and auto gain control
- **ICE Reconnection**: automatic `restartIce` on connection failure
- **Muted Indicators**: per-tile SVG badge when a participant is muted

### Incoming Call Flow
- Animated ringing banner with caller info
- One-click Accept / Dismiss actions
- Separate "Video Call" and "Audio Only" call initiation buttons in the chat header

### Browser Compatibility
- `canScreenShare` / `canFullscreen` capability detection
- WebKit vendor prefix fallback for Fullscreen API
- `AudioContext` / `webkitAudioContext` fallback
- `enumerateDevices` graceful degradation
- Device selectors auto-hidden when only one device is available

---

## 🛠 Tech Stack

| Layer | Technology |
|-------|------------|
| **Frontend** | React 18 / Vite ⚡️ |
| **Styling** | Vanilla CSS (CSS Grid + Custom Properties) |
| **Encryption** | WebCrypto API (AES-GCM / RSA-OAEP) |
| **Video/Audio** | `simple-peer` (WebRTC) |
| **Rich Text** | `marked` + `DOMPurify` |
| **Emoji** | `emoji-picker-react` |
| **Backend** | Node.js & Express |
| **Database** | SQLite3 (zero-config local persistence) |
| **Real-Time** | `Socket.io` (WebSocket engine) |
| **Auth** | JSON Web Tokens (JWT) & bcrypt |
| **Push** | `web-push` (VAPID protocol) |
| **Transcoding** | FFmpeg (server-side media processing) |
| **Deployment** | Docker & Docker Compose |
| **Reverse Proxy** | Nginx (WebSocket upgrading, SPA routing) |
| **Auto-Update** | Watchtower (continuous deployment) |

---

## 🚀 Quick Start with Docker

The easiest way to run Prado Chat is via Docker Compose. Pre-built images are hosted on **Docker Hub**.

### Docker Hub Images

| Image | Description |
|-------|-------------|
| [`skyking83/prado-chat-backend`](https://hub.docker.com/r/skyking83/prado-chat-backend) | Node.js API + SQLite + Socket.io + WebRTC signaling |
| [`skyking83/prado-chat-frontend`](https://hub.docker.com/r/skyking83/prado-chat-frontend) | Vite-built React SPA served via Nginx |

### 1. Clone the repository
```bash
git clone https://github.com/skyking83/prado-chat.git
cd prado-chat
```

### 2. Configure your Environment
Create a `.env` file in the project root:
```env
JWT_SECRET=super_secret_key_change_me
RESEND_API_KEY=your_resend_api_key
GIPHY_API_KEY=your_giphy_api_key
```

### 3. Spin up the stack
```bash
docker-compose up -d
```

### 4. Access the App
Open your browser and navigate to `http://localhost:30099`.

> **TrueNAS / NAS Users**: The `docker-compose.yml` includes bind mounts to `/mnt/pool1/app_data/` for persistent data that survives container rebuilds. Adjust the paths to match your storage pool.

---

## 💻 Local Development

If you want to contribute, tweak styles, or run the components locally without Docker:

### 1. Start the SQLite Backend
```bash
cd backend
npm install
npm run dev
```
*(Runs on `http://localhost:3001`)*

### 2. Start the Vite Frontend Server
```bash
# In a new terminal window
cd frontend
npm install
npm run dev
```
*(Runs on `http://localhost:5173` — proxies API/WebSocket to the backend)*

---

## 🔑 Default Administrator

The first user registered on a fresh instance is automatically granted the **`admin`** role. All subsequent registrations are standard `users`.

To access the admin panel, click your avatar in the Top App Bar → **Admin Panel**.

---

## 📱 PWA Installation

Prado Chat is a fully installable Progressive Web App:

| Platform | Method |
|----------|--------|
| **Android** | Tap "Install App" in the user menu, or Chrome → "Add to Home Screen" |
| **iOS** | Safari → Share button → "Add to Home Screen" |
| **Desktop** | Click "Install App" in the user dropdown or use the browser install icon |

The PWA includes offline detection with a branded fallback page, app shortcuts, and full push notification support with E2EE-aware message decryption.

---

## 📄 License & Privacy

Built as a private, self-hosted sanctuary. Your data stays on **your** hardware. End-of-story.

<div align="center">
  <sub>Made with ❤️ for the HomeLab community.</sub>
</div>
