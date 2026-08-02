# Stratego Online v2.0 (Socket.io)

Classic Stratego multiplayer that works reliably on **phones, Edge, Chrome, Firefox**, and different networks.

## Features
- Classic ranking: **1 = Marshal** (strongest) … **9 = Scout**, S = Spy
- **Online** via Socket.io (server-authoritative – no PeerJS)
- **Local Hotseat** on one device
- Simultaneous placement + **Random** setup button
- Blue’s board is flipped so their pieces are at the bottom

## Run locally

```bash
cd stratego
npm install
npm start
```

Open http://localhost:3000

## Deploy on Hostinger

### Option A – Hostinger Node.js app (Business / Cloud plans)

1. In hPanel → **Websites** → your domain → **Node.js**
2. Create a Node.js app:
   - Node version: 18 or 20
   - Application root: folder where you upload these files
   - Application startup file: `server/index.js`
   - Application URL: your domain / subdomain
3. Upload **all** project files (including `package.json`, `server/`, `public/`)
4. In the Node.js panel, click **NPM Install** (or SSH: `npm install --production`)
5. Set environment if needed: `PORT` is usually set automatically by Hostinger
6. **Restart** the Node app
7. Open your domain – you should see Stratego v2.0

### Option B – VPS (any provider) / Railway / Render (free tier)

```bash
npm install --production
npm start
```

Set `PORT` if the host requires it (e.g. `process.env.PORT`).

### Important for Hostinger shared hosting
- Pure **static HTML hosting does NOT run Node**. You need a **Node.js** feature or a VPS.
- If your plan has no Node.js, use a free host for the server:
  - [Render.com](https://render.com) – free web service, sleeps after idle
  - [Railway.app](https://railway.app) – free trial credits
  - Then point your Hostinger domain or just share the Render URL

## How to play online
1. One player: **Host Online Game** → share the 6-letter **Room Code**
2. Other player: **Join Online Game** → enter the code
3. Both place pieces (or click **Random**) → both click **I'm Ready**
4. Red moves first

## Files
- `server/index.js` – Express + Socket.io game server
- `public/` – frontend (HTML/CSS/JS)
- `package.json` – dependencies

## Troubleshooting
- **"Cannot reach server"** → Node app is not running or wrong URL
- **Room not found** → code typo, or server restarted (rooms are in-memory)
- After server restart, create a **new** room
