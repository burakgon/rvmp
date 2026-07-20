# Exposing codegent safely

codegent is **local-only by design**: the daemon binds `127.0.0.1` and every
request needs the per-install token (`~/.codegent/token`, also in the URL
fragment the CLI prints). There is no relay, no accounts, no remote service.

Want to reach it from another device? Bring your own tunnel — pointed at the
local port (default 4666):

**Tailscale (recommended)**
```sh
tailscale serve 4666
# then open https://<your-machine>.<tailnet>.ts.net/#t=<token>
```

**cloudflared**
```sh
cloudflared tunnel --url http://127.0.0.1:4666
# open the printed URL with #t=<token>
```

**Plain SSH**
```sh
ssh -L 4666:127.0.0.1:4666 your-server
# open http://127.0.0.1:4666/#t=<token> locally
```

Note: page links carry the token in the URL FRAGMENT (`#t=`), which browsers
never send over the wire. The live board's own WebSocket upgrade does send it
as a query parameter — that stays inside your tunnel's encrypted channel.

Rules of thumb:
- The token IS the credential — treat the full URL like a password.
- **Never** bind the daemon to `0.0.0.0` or port-forward it raw: agents on
  your machine execute code; an exposed board is an exposed shell.
- The always-on recipe: install codegent on the server itself
  (`curl … | sh` + `codegent service enable`), then tunnel to it.
