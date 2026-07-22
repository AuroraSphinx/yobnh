# YOBNH (TypeScript)

A Discord AI assistant bot with browser search/open integration.

## Setup

1. Install dependencies:

```powershell
npm install
```

2. Set the environment variables:

```powershell
$env:DISCORD_TOKEN = "your-discord-token"
$env:MISTRAL_API_KEY = "your-mistral-api-key"
```

3. Build and run:

```powershell
npm run build
npm start
```

> Do not run `node index.ts` directly. Use `npm start` or `npm run start:dev` instead.

## Development

```powershell
npm run dev
```

## Notes

- `index.ts` keeps the existing system prompt verbatim.
- If you want OpenAI instead of Mistral, set `OPENAI_API_KEY` and do not set `MISTRAL_API_KEY`.
