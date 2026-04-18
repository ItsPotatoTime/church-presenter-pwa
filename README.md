# Church Presenter — Phone Remote (PWA)

A Progressive Web App that turns any phone into a wireless remote control for the **ChurchPresenter** desktop app. Pair once via QR code, then control slides, manage the song queue, and browse the entire library — even offline.

**Live app:** https://itspotatotime.github.io/church-presenter-pwa/

---

## Features

### Live Slide Control
- See the currently displayed slide text in real time on your phone
- Navigate slides: Previous / Next
- Blank / un-blank the projector screen
- Start and Stop the presentation
- Adjust the projected font size remotely
- **Follow mode** — freeze the phone view so you can read without it jumping as slides change

### Library Browser
- Full searchable library of all songs synced from the desktop
- **Diacritic-insensitive search** — searching "cantati" finds "Cântați"
- **Scored results** — song name matches rank above folder matches, which rank above slide-content matches
- **Slide-content search** — toggle "Slides" to search inside lyrics; matching snippet shown under the result
- **Markdown rendering** — `**bold**` markers in lyrics display as **bold** text
- Progressive loading — 3 500+ song libraries load instantly; more songs appear as you scroll
- Tap any song to preview all its slides, then add it to the queue with one tap

### Queue Management
- View the current queue and see which song is playing
- Tap a queued song to switch the desktop to it immediately
- Remove songs or clear the entire queue
- Reorder songs by drag-and-drop

### Lists (Playlists)
- Create, rename, and delete named playlists
- Add songs from the library to any list
- Reorder list songs by drag-and-drop
- Load a list directly into the queue with one tap
- **Full offline support** — create and edit lists while the desktop is disconnected; changes sync automatically when you reconnect

### Connection
- **LAN (Wi-Fi)** — low-latency direct connection on the same network, advertised via mDNS
- **Cloud (cloudflared tunnel)** — works over cellular data from anywhere in the world
- Automatic cloud ↔ LAN fallback with exponential backoff reconnection
- iOS Safari background reconnect — returns instantly when you switch back to the app

### Multi-Phone & Access Control
- Multiple phones can connect simultaneously
- **Exclusive mode** — operator locks one phone as the sole controller; others become view-only
- View-only banner shown on phones that are not in control

### Offline Support
- Library, queue, and lists are cached in IndexedDB — visible without a connection
- Pending list mutations queue up and replay automatically on reconnect
- Delta sync — only changed songs are transferred after the first full sync

---

## Pairing

1. Open **ChurchPresenter** on the desktop and click the phone icon to show the QR code.
2. On your phone, open the PWA (or scan the QR directly — it opens the pair page).
3. Give the phone a name and tap **Pair**.
4. The phone is remembered; future sessions reconnect automatically.

To revoke a phone, open **Phones** in ChurchPresenter and remove it.

---

## Connection Modes

| Mode | When it works | Latency |
|------|--------------|---------|
| **LAN** | Phone on the same Wi-Fi as the desktop | ~5 ms |
| **Cloud** | Any network (cellular, guest Wi-Fi, etc.) | ~50–200 ms |

The desktop must be running **ChurchPresenter** with the remote server enabled. The cloudflared named tunnel is started automatically when the server starts.

---

## Dev Setup

```bash
cd phone-remote
npm install
npm run dev        # → http://localhost:5173
npm run build      # production build → build/
npm run preview    # preview the production build locally
```

Requires Node 18+.

---

## Tech Stack

- **SvelteKit** (Svelte 5 runes) — UI framework
- **TypeScript** — type safety throughout
- **WebSocket** — real-time communication with the desktop
- **IndexedDB** — offline persistence (library, queue, lists, credentials)
- **Service Worker** — PWA installability and offline shell caching
- **cloudflared** — public HTTPS tunnel for remote access
- **mDNS** — LAN discovery without manual IP entry
