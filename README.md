<div align="center">
  <img src="frontend/public/icon.png" alt="Prado Chat Logo" width="120" />

  # Prado Chat

  A modern, self-hosted, real-time messaging platform styled after Google Messages, designed for secure home labs, private groups, and teams. Built from the ground up to be lightweight, incredibly fast, and run reliably in Docker environments.

  [![Docker Pulls](https://img.shields.io/docker/pulls/skyking83/prado-chat-frontend?style=flat-square&logo=docker&label=Frontend%20Pulls)](https://hub.docker.com/r/skyking83/prado-chat-frontend)
  [![Docker Pulls](https://img.shields.io/docker/pulls/skyking83/prado-chat-backend?style=flat-square&logo=docker&label=Backend%20Pulls)](https://hub.docker.com/r/skyking83/prado-chat-backend)

  [Features](#-features) •
  [Video Rooms](#-webrtc-video-rooms) •
  [Admin Console](#-admin-console) •
  [Tech Stack](#-tech-stack) •
  [Quick Start (Docker)](#-quick-start-with-docker) •
  [Development Setup](#-local-development)
</div>

---

## ✨ Features

### 🔐 Zero-Friction End-to-End Encryption (E2EE)
Completely invisible encryption — no passkey prompts, no lock icons, no "[Encrypted Message]" text. It just works.
- **Automatic Key Exchange**: RSA-2048 identity keypairs generated on registration; AES-256-GCM room keys distributed via RSA public-key wrapping — no user action needed
- **Server-Side Escrow**: Room keys backed up to server (encrypted with `JWT_SECRET`-derived key) for multi-device and offline recovery
- **Offline Key Recovery**: `pending_key_requests` queue ensures users get their keys even when no peers are online — fulfilled automatically on next socket connection
- **Multi-Device Sync**: Wrapped private key stored server-side, unwrapped with login password on any device/browser
- **Forward Secrecy**: Member removal/leave triggers automatic room key rotation — removed members cannot decrypt future messages
- **Graceful Degradation**: Shimmer placeholder animation while keys load; auto-retry decryption when keys arrive
- **Push Privacy**: Push notifications show "Sent a message" fallback (no ciphertext leaks); service worker decrypts using IndexedDB-cached keys for real message previews on trusted devices

### 💬 Real-Time Communication
Instant messaging powered by ultra-low-latency WebSockets via `Socket.io` with resilient reconnection handling, real-time typing indicators, and online/offline presence detection.
- **Threaded Messaging**: Reply to any message to start a collapsible thread. Thread reply toasts notify all participants — even across different spaces — with click-to-navigate deep linking. Thread unread badges on collapsed threads
- **New Message Pill**: Webex-style floating pill appears above the input area when new messages arrive while scrolled up, showing sender name, preview text, and stacking count badge. Click to jump to latest, auto-dismisses on scroll
- **Message Search**: `Ctrl+F` or search icon opens slide-down search bar in chat header. Client-side full-text search with highlighted results, result counter, and jump-to-message navigation. Separate global search across all spaces
- **Voice Messages**: Mic button (appears when input is empty) records audio via MediaRecorder API (`audio/webm;codecs=opus`). Inline waveform player with play/pause toggle and progress bar
- **@Mentions & Alerts**: Type `@` for auto-complete user dropdown. Mentioned users receive a 2-note audio chime + orange sidebar notification dot. Push notifications include "mentioned you" alerts
- **URL Link Previews**: Automatic Open Graph unfurling for shared URLs — shows title, description, thumbnail, and favicon in a collapsible card. 17+ oEmbed providers (YouTube, Spotify, TikTok, Reddit, Vimeo, Twitter/X, etc.) with YouTube channel/Music fallback. Detects bare domains without `http://` prefix. Toggle state persisted in localStorage

### 🏢 Dynamic Workspaces ("Spaces")
Create public channels for everyone or secure, lock-protected private spaces. Built-in **Notes to Self** personal space with deletion protection. Direct messages with per-user DM channels.

### 🎨 Modern Google Messages UI
Beautifully crafted Dual-Pane layout with responsive sidebar, floating chat inputs, infinite scroll message history, pinned messages board, and seamless mobile transitions.

### 📹 WebRTC Video & Audio Rooms
Full-featured peer-to-peer video conferencing with self-hosted TURN relay support — see [detailed breakdown below](#-webrtc-video-rooms).

### ✍️ Slack-Style Rich Text Editor
ContentEditable input with **live inline formatting** — type `**bold**`, `*italic*`, `` `code` ``, or `~~strike~~` and watch the syntax markers vanish as formatting appears in-place. Features:
- Floating format toolbar (Bold, Italic, Strikethrough, Code) appears on text selection
- Full Markdown rendering for sent messages (tables, blockquotes, lists, headings, code blocks) via `marked` + `DOMPurify`
- Paste-aware: pasted formatted text auto-converts to markdown patterns
- Works in both message composition and inline message editing
- **Message Drafts**: unsent text auto-saved per space, restored when you switch back

### 📎 Rich Media & Attachments
- Drag-and-drop secure file sharing with progress indicators
- Custom Emoji Picker built-in
- Auto-searching, debounced integrated GIF engine (via Giphy)
- Video message thumbnails with inline playback

### 🔔 Push Notifications
E2EE-aware Web Push with grouped notification stacking per-space, inline reply actions (Android), and one-tap deep-linking into the target conversation.

### 👤 Enhanced User Profiles
- **Status Indicators**: 10 curated SVG status icons (Available, Busy, Away, In a Meeting, Headphones, Working from Home, Traveling, DND, On a Break) — all theme-aware via `currentColor`
- **Bio**: 200-character user biography with live character counter
- **Timezone**: Auto-detected from browser on first login, auto-inferred from location with 30+ city/country keyword mappings, or manual override from 35 IANA timezones
- **Profile Hover Cards**: Hover over any avatar in the sidebar to see a rich floating card with avatar, display name, @username, status icon + text, bio (3-line clamp), and local time
- **Real-time status sync**: Status changes broadcast instantly to all connected clients via WebSocket

### 🛡️ Admin Console
Full-featured admin dashboard with five management tabs — see [detailed breakdown below](#-admin-console).

### 📱 Progressive Web App (PWA)
Installable as a native app on iOS, Android, macOS, and Windows:
- Service worker with offline fallback page and cache versioning
- 512px maskable icons for Android adaptive icon support
- iOS Safari `apple-mobile-web-app` meta tags and Dynamic Island safe area support
- Home screen shortcuts for quick access

### 🎨 Customizable Theming & Typography
- **Dynamic App Name**: set your own app name via Admin Panel → Branding (shown on login, sidebar, loading screen)
- **Custom Logo Upload**: upload a custom logo image in Admin Panel → Branding (replaces default icon everywhere)
- Dynamically switchable UI accent colors
- 1,500+ Google Fonts natively integrated
- Real-time UI Scaling slider with continuous CSS `rem` ratio adjustments
- Dark / Light mode toggle (fully applied to all views including video calls)

### ⌨️ Keyboard Shortcuts
| Shortcut | Action |
|----------|--------|
| `Escape` | Close topmost modal/panel |
| `Ctrl+F` | Search messages in current space |
| `Ctrl+K` | Focus chat input |
| `Ctrl+Shift+S` | New space modal |
| `Ctrl+Shift+D` | New DM modal |
| `Ctrl+Shift+,` | Toggle settings |
| `Alt+↑/↓` | Navigate spaces (visual sidebar order) |
| `Ctrl+Shift+M` | Toggle mute (in call) |
| `Ctrl+Shift+V` | Toggle camera (in call) |
| `Spacebar` | Push-to-talk momentary unmute (in call) |

### ♿ Accessibility
- Respects `prefers-reduced-motion` (disables all animations/transitions)
- Proper semantic HTML structure
- iOS safe area insets for notch/Dynamic Island devices
- No forced zoom prevention (user-scalable preserved)

### 🔗 Resilient Connection States
Real-time network detection seamlessly swapping avatar states, suppressing active boundaries on WebSocket drops, and automatic reconnection with exponential backoff.

---

## 📹 WebRTC Video Rooms

Prado Chat includes a complete, browser-native video conferencing system — no external services, no plugins, fully peer-to-peer with optional TURN relay.

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
- **Dynamic ICE Configuration**: TURN/STUN servers loaded from admin config on each call
- **Muted Indicators**: per-tile SVG badge when a participant is muted
- **Camera-Off Avatars**: participant avatars shown when camera is disabled
- **Push-to-Talk**: hold spacebar while muted for momentary unmute (walkie-talkie style)
- **In-Call Chat Panel**: side panel showing the current space's chat with E2EE decryption and full Markdown rendering
- **Theme-Aware UI**: all video call components respect the global light/dark theme via CSS variables

### TURN/STUN Relay
- Self-hosted **coturn** container included in Docker Compose
- Admin-configurable TURN server URL, credentials, and STUN server
- Dynamic ICE server discovery via `GET /api/ice-servers`
- Built-in **connectivity test** in admin panel — verifies Host, STUN (srflx), and TURN (relay) candidates
- Enables reliable connections behind symmetric NATs / corporate firewalls

### Call Invite & Ringing
- **Invite-to-Call Modal**: click Video or Audio call button to open a user picker showing all users with avatars, display names, and live online/offline status
- **Targeted Ringing**: select specific users to ring with "Ring All" toggle, "Ring & Join" or "Join Quietly" options
- **Push Notifications**: offline users receive push notifications with caller name and call type
- **Mid-Call Invites**: invite additional participants from within an active call via the user-plus button in the controls bar
- **Persistent Ringing Banner**: incoming call banner with caller avatar, space name, call type, and 30-second countdown timer
- **Web Audio Ringtone**: two-tone ring pattern (440Hz + 480Hz) via Web Audio API oscillators, auto-stops on dismiss/accept/timeout
- **Dual Accept Options**: accept as Video or Audio Only directly from the ringing banner

### Browser Compatibility
- `canScreenShare` / `canFullscreen` capability detection
- WebKit vendor prefix fallback for Fullscreen API
- `AudioContext` / `webkitAudioContext` fallback
- `enumerateDevices` graceful degradation
- Device selectors auto-hidden when only one device is available

---

## 🛡️ Admin Console

The admin console is accessible from the avatar dropdown menu by users with the `admin` role. It provides five management tabs:

### 👥 Users Tab
- Searchable user list with real-time status, role badges, and creation dates
- **Edit User**: hero avatar, responsive 2-column form with profile, status & bio, role & preferences, and security sections
- **Login History**: modal with timestamped session log per user
- **Export**: CSV download of the full user database
- **Delete User**: confirmation dialog with cascade delete of messages and memberships

### 🏠 Spaces Tab
- Full space inventory with member counts, creator info, and type badges (Public/Private/DM/Self)
- **Delete Space**: confirmation modal with full data cascade

### 📢 Moderation Tab
- **User Reports**: flagged message queue with reporter info, timestamps, and one-click dismiss
- **Word Filter**: add/remove filtered words, auto-applied to new messages server-side
- **Audit Log**: paginated, timestamped log of all admin actions (user edits, config changes, deletions, broadcasts)
- **Broadcast System**: send real-time announcements to all connected users via an animated top-of-screen banner with auto-dismiss countdown

### ⚙️ Config Tab
All settings auto-save on blur/change with a visual "Saving…/Saved" indicator.

| Section | Settings |
|---------|----------|
| **Registration** | Registration mode (open/closed), email verification toggle, domain whitelist |
| **Branding** | App name (dynamic, shown everywhere), custom logo upload with preview, default theme (dark/light), accent color (circular color picker) |
| **Uploads** | Max upload size (MB) — enforced server-side by multer middleware |
| **Maintenance** | Maintenance mode toggle + custom message (non-admin users see a branded maintenance screen) |
| **API Keys** | Generate/revoke API keys with read/write scopes, stored as SHA-256 hashes |
| **Email Provider** | Resend API key (DB-stored, not env var), from address, test email delivery with inline status |
| **TURN/STUN** | TURN server URL, username, credential, STUN server URL, **connectivity test button** with Host/STUN/TURN candidate discovery |
| **Giphy** | Giphy API key (DB-stored, not env var) for GIF search integration |

> **Note**: All sensitive API keys (Resend, Giphy) and TURN/STUN credentials are managed entirely from the Admin Panel → Config tab and stored in the SQLite database — no environment variables needed. Coturn runs as a stateless Docker service using inline CLI arguments.

### 🔍 Environment Overview
- System diagnostics: Node.js version, platform, hostname, CPU count, memory, uptime
- Configuration status for all secrets and integrations with color-coded SVG status icons:
  - 🟢 Green shield = configured
  - 🟡 Amber circle = using fallback
  - 🔴 Red triangle = not configured

---

## 🛠 Tech Stack

| Layer | Technology |
|-------|------------|
| **Frontend** | React 18 / Vite ⚡️ |
| **Styling** | Vanilla CSS (CSS Grid + Custom Properties) |
| **Encryption** | WebCrypto API (AES-GCM / RSA-OAEP) |
| **Video/Audio** | Native WebRTC (`RTCPeerConnection`) |
| **TURN Relay** | coturn (self-hosted, containerized) |
| **Rich Text** | `marked` + `DOMPurify` |
| **Emoji** | `emoji-picker-react` |
| **Backend** | Node.js & Express |
| **Database** | SQLite3 (zero-config local persistence) |
| **Real-Time** | `Socket.io` (WebSocket engine) |
| **Auth** | JSON Web Tokens (JWT) & bcrypt |
| **Email** | Resend (transactional email API) |
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
| [`skyking83/prado-chat-backend`](https://hub.docker.com/r/skyking83/prado-chat-backend) | Node.js API + SQLite + Socket.io + WebRTC signaling + coturn |
| [`skyking83/prado-chat-frontend`](https://hub.docker.com/r/skyking83/prado-chat-frontend) | Vite-built React SPA served via Nginx |

### 1. Clone the repository
```bash
git clone https://github.com/skyking83/prado-chat.git
cd prado-chat
```

### 2. Configure your Environment
The only required environment variables are `JWT_SECRET`, `VAPID_PUBLIC_KEY`, and `VAPID_PRIVATE_KEY` — these are set directly in `docker-compose.yml`. No `.env` file is needed.

> **All other configuration** (Resend API key, Giphy API key, TURN/STUN credentials, branding, etc.) is managed from the **Admin Panel → Config** tab after first login.

### 3. Spin up the stack
```bash
docker-compose up -d
```

### 4. Access the App
Open your browser and navigate to `http://localhost:30099`.

### 5. First-Time Setup
1. Register your admin account (first user gets `admin` role automatically)
2. Open **Admin Panel → Config** to set up:
   - **Email Provider**: Resend API key for email verification
   - **Giphy**: Giphy API key for GIF search
   - **TURN/STUN**: TURN relay credentials for NAT traversal (optional but recommended)

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

### 3. Start coturn (optional, for TURN relay testing)
```bash
docker-compose -f docker-compose.dev.yml up coturn -d
```

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
