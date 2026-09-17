# ER:LC Staff Management Website

A Node.js + Express + PostgreSQL staff portal for an ER:LC Discord community.

## Features

- Discord OAuth2 login
- Discord server membership + role verification
- Staff dashboard
- Start/end shifts
- Shift history data
- LOA requests
- Supervisor LOA approval/denial
- Punishment logging
- Management punishment records
- PostgreSQL database
- Railway-ready

## Railway variables

Create a PostgreSQL service in Railway and connect its `DATABASE_URL` to this website.

Add:

- `DATABASE_URL`
- `SESSION_SECRET`
- `DISCORD_CLIENT_ID`
- `DISCORD_CLIENT_SECRET`
- `DISCORD_REDIRECT_URI`
- `DISCORD_BOT_TOKEN`
- `DISCORD_GUILD_ID`
- `STAFF_ROLE_IDS`
- `SUPERVISOR_ROLE_IDS`
- `MANAGEMENT_ROLE_IDS`

Role ID variables accept comma-separated role IDs.

## Discord Developer Portal

For the Discord application used by the website:

OAuth2 -> Redirects

Add:

`https://YOUR-RAILWAY-DOMAIN/auth/discord/callback`

The website uses Discord OAuth2 `identify` to sign users in. The backend then checks the user's membership and roles using the bot token.

Never put `DISCORD_CLIENT_SECRET` or `DISCORD_BOT_TOKEN` in frontend code.

## Run locally

```bash
npm install
npm start
```

Then visit:

`http://localhost:3000`
