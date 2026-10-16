# Taktik AI Studio — Desktop App

Native desktop shell for [taktikmarketing.space](https://taktikmarketing.space),
built with Electron. Same account, same credits, same AI tools — in a real
Windows / macOS / Linux application.

## What it does

- Opens straight into `/dashboard/` (log in once, session persists)
- Native menus: Dashboard, AI Tools, Flow Studio, Billing, Sign out
- External links (anything outside taktikmarketing.space) open in the default browser
- Branded offline screen with auto-retry when the connection returns
- System tray with quick actions (Windows/Linux)
- Download manager (asks where to save)
- Zoom controls, fullscreen, web notifications
- Deep link support: `taktik://dashboard`
- Automatic updates via `electron-updater` once GitHub Releases are configured

## Develop

```bash
npm install
npm start            # run the app
npm run smoke        # headless load test: loads the live site, prints title, exits
```

## Build installers

```bash
npm run dist:win     # → dist/Taktik-AI-Studio-1.0.0-win-portable.zip (portable: unzip & run)
npm run dist:mac     # → dist/Taktik-AI-Studio-1.0.0-mac-x64.zip + -mac-arm64.zip
npm run dist:linux   # → dist/Taktik-AI-Studio-1.0.0.AppImage + .deb
```

Builds run on Linux for all three platforms (no Mac/Windows machine needed).

> **Windows installer (.exe) note:** a true NSIS installer needs 32-bit Wine
> (or a Windows machine / GitHub Actions runner) to build — the portable zip
> above is the Windows deliverable for now and works the same for the user.

## Publish / distribute

1. **Where to host the files** — either:
   - GitHub Releases (recommended: enables in-app auto-update), or
   - Upload the three installers to the website (Media Library or a `/downloads/` folder) and link them from the `/download/` page.
2. **Auto-update** — edit `package.json` → `build.publish`: replace
   `REPLACE_WITH_GITHUB_USER` with the real GitHub username/org that owns the
   `taktik-ai-studio-desktop` repo, then publish releases with matching version tags.
3. **Code signing (recommended before public launch)** —
   - Windows: EV or OV certificate → set `CSC_LINK`/`CSC_KEY_PASSWORD` env vars at build time.
   - macOS: Apple Developer ID → `electron-builder --mac dmg` on a Mac with `CSC_*` set, plus notarization.
   - Unsigned builds work fine but show a SmartScreen / Gatekeeper warning on first run.

## Website download page

`site-download-page.html` is a ready-to-paste branded section for a new
WordPress page at `/download/`. Replace the three `href="#"` placeholders with
the real installer URLs.

## Versioning

Bump `version` in `package.json` for each release (auto-update relies on it).
