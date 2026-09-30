# Plugin Intelligence MCP

Remote MCP server for Plugin Intelligence Commander.

Architecture:

ChatGPT / Plugin → Cloudflare Worker MCP → Google Apps Script → Google Sheets

## First tool

- `get_plugins` — reads plugin name, version, and status from the Apps Script backend.

## Required environment variable

`APPS_SCRIPT_URL`

Example value:

`https://script.google.com/macros/s/<DEPLOYMENT_ID>/exec`

Do not append `?action=get_plugins`; the MCP tool adds the action parameter.

## Development

```bash
npm install
npm run dev
```

MCP endpoint:

`http://localhost:8787/mcp`

## Deploy

```bash
npm run deploy
```

Then configure `APPS_SCRIPT_URL` as a Cloudflare Worker secret/variable.
