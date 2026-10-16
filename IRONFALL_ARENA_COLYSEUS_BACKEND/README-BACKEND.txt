IRONFALL ARENA — COLYSEUS BACKEND

LOCAL TEST
1) Install Node.js 18 or newer.
2) Open a terminal in this folder.
3) Run: npm install
4) Run: npm start
5) Health check: http://localhost:2567/health
6) In the game Friends menu, use ws://localhost:2567.

DEPLOY TO A HOST THAT SUPPORTS PERSISTENT WEBSOCKETS
- This folder contains server.js, package.json and render.yaml.
- Create a new Web Service from this folder/repository on a Node.js host that supports WebSockets.
- Build command: npm install
- Start command: npm start
- Health check path: /health
- The service reads PORT from the environment.
- Once deployed, use the provider's secure WebSocket URL (wss://...) in netlify-site/config.js.

NETLIFY CANNOT RUN THIS SERVER.JS AS A STATIC SITE. Deploy frontend and backend separately.

NOTES
- The free Render plan may sleep or have limits; service availability and pricing can change.
- The room-code lookup endpoint /find-room/:code is HTTP(S); the Colyseus connection uses ws:// locally or wss:// online.
- This is a starter implementation, not production-hardened anti-cheat. Before public competitive play, validate hits server-side and test reconnects, rate limits, match lifecycle and multiple concurrent rooms.
