# YOBNH-Phone

Android app (Java) that talks to the YOBNH bot server.

## Features
- Send a text message to the bot owner (forwarded as a Discord DM)
- Send any file from your phone (saved to `community-files/phone-inbox` and DM'd to the owner)
- Record and send a voice mail (DM'd to the owner as an audio file)
- Receive live "bad word" alerts with a popup whenever the bot detects banned words in Discord

## Setup
1. On the server, set `PHONE_TOKEN` (and optionally `PHONE_PORT`, default `8091`) in your bot's env.
2. Make sure port `8091` is reachable (reverse proxy / firewall).
3. Open this folder in Android Studio, build, and install on your phone.
4. In the app: enter the server URL (`https://your-bot:8091` or `http://ip:8091`) and the phone token, then tap **Save**.

## API used by the app
- `GET  /api/phone/ping` — health check
- `POST /api/phone/message` — `{ "text": "..." }`
- `POST /api/phone/file` — `{ "name": "...", "data": "<base64>" }`
- `POST /api/phone/voice` — `{ "name": "...", "data": "<base64>" }`
- `GET  /api/phone/alerts?after=<id>` — bad-word alert feed

All requests send the token via the `X-Phone-Token` header.
