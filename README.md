# Church Presenter — Phone Remote (PWA)

Progressive Web App companion for the ChurchPresenter desktop.
Hosted at: **https://itspotatotime.github.io/church-presenter-pwa/**

## Phase 0 — Infrastructure Validation

This is the infra-only scaffold. No real features yet. The goal of this phase is to prove that:

1. A hello-world PWA deployed to GitHub Pages installs on both iOS and Android.
2. `cloudflared` tunnel gives a public HTTPS WebSocket URL reachable from any network.
3. The installed PWA on a phone (cellular, not WiFi) can open that URL and round-trip a message.

### Local dev

```bash
cd phone-remote
npm install
npm run dev     # → http://localhost:5173
```

### Deploy to GitHub Pages (one-time setup)

1. On the GitHub repo → **Settings → Pages → Source: GitHub Actions**.
2. Push this folder as the repo root:
   ```bash
   cd phone-remote
   git init
   git remote add origin https://github.com/ItsPotatoTime/church-presenter-pwa.git
   git add .
   git commit -m "Phase 0 scaffold"
   git branch -M main
   git push -u origin main
   ```
3. Wait ~1 minute for the Action to run. Check `Actions` tab.
4. Open **https://itspotatotime.github.io/church-presenter-pwa/** — should load.

### Phase 0 end-to-end test

Terminal 1 — start the echo server:
```bash
cd phone-remote/tests
pip install -r requirements.txt    # installs `websockets` (only needed once)
python echo_server.py
```

Terminal 2 — start cloudflared tunnel:
```bash
# from the repo root above phone-remote/
../vendor/cloudflared.exe tunnel --url http://localhost:9999
```

The tunnel prints a URL like `https://funny-horse-1234.trycloudflare.com`.

On your phone (disable WiFi, use cellular):
1. Open **https://itspotatotime.github.io/church-presenter-pwa/**.
2. Install the app (iOS: Share → Add to Home Screen; Android: "Install" banner).
3. Paste the tunnel host (e.g. `funny-horse-1234.trycloudflare.com`) into the **Tunnel URL** field.
4. Tap **Test connection**.

**✓ Success** when the status pill shows **Connected** and the log shows `← echo: ping`.

If that works, Phase 0 is done — we have the full infra path (phone cellular → HTTPS → Cloudflare → your desktop → echo server) proven. Ready to build Phase 1.

### Troubleshooting

- **Action fails:** Check `Settings → Pages → Source` is set to `GitHub Actions`, not `Deploy from branch`.
- **404 on the GH Pages URL:** Wait for the first successful Action run. Check `Actions → Deploy PWA to GitHub Pages`.
- **PWA won't install on iOS:** Must be opened in Safari, not in-app browsers. Share button → Add to Home Screen.
- **Tunnel connects but "error":** `cloudflared` sometimes terminates WebSockets if the upgrade header is missing. The `websockets` Python library sets it correctly — if you swap the echo server for something else, make sure it handles the upgrade handshake.
- **`cloudflared tunnel --url` prints a URL but it's unreachable:** Quick tunnels can take 10–20s to propagate. Retry after a few seconds.
