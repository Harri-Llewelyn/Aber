/**
 * What a client needs to read through the i3X server with a token, one setup per client, for the
 * Issue Token dialog. The base URL carries `/v1`: the server answers 404 outside it, and a client
 * then mistakes it for a server older than 1.0.
 */

/** Pinned as `scripts/mint-api-token.mjs --json` pins it; the dialog's test holds the two equal. */
export const I3X_MCP_PACKAGE = 'i3x-mcp@0.1.0'
/** The server's name in the MCP block, as the script names it. */
export const I3X_MCP_SERVER_NAME = 'aber-i3x'

/** The address a client is given: the origin with `/v1` on it. */
export const i3xBaseUrl = (origin) => `${origin.replace(/\/+$/, '')}/v1`

/**
 * The setups for `origin` (VITE_I3X_URL, no `/v1`) and the minted `token`, in the order the
 * dialog offers them. Each is `{ id, label, text, hint }`; `text` is what Copy Setup copies.
 */
export function i3xClientSetups(origin, token) {
  const base = i3xBaseUrl(origin)
  return [
    {
      id: 'explorer',
      label: 'i3X Explorer',
      text: [
        `Server URL      ${base}`,
        'Authentication  Bearer Token',
        `Token           ${token}`,
      ].join('\n'),
      hint: 'The desktop build works as it is. The browser build needs its origin in '
        + 'global.corsExtraOrigins in this site’s Helm values.',
    },
    {
      id: 'mcp',
      label: 'MCP client',
      // The block `node scripts/mint-api-token.mjs --json` prints, key for key.
      text: JSON.stringify({
        mcpServers: {
          [I3X_MCP_SERVER_NAME]: {
            command: 'npx',
            args: ['-y', I3X_MCP_PACKAGE],
            env: {
              I3X_BASE_URL: base,
              I3X_AUTH_SCHEME: 'bearer',
              I3X_TOKEN: token,
            },
          },
        },
      }, null, 2),
      hint: 'For claude_desktop_config.json, or any MCP host’s equivalent.',
    },
    {
      id: 'curl',
      label: 'curl',
      // Not /info, which answers without a token and so proves nothing about one.
      text: `curl -H "Authorization: Bearer ${token}" ${base}/objecttypes`,
      hint: 'Proves the token works: the server lists its object types. A 401 means it refused the token.',
    },
  ]
}
