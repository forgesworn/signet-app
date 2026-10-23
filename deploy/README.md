# Signet privacy routing

`mysignet-privacy.Caddyfile` supplements the existing static HTTPS routes for
MySignet and Lite. It discards HTTP redirect access logs, preserves the path and
query when redirecting to HTTPS, and redirects `www.mysignet.app` to the apex.
It adds no upload, relay, badge-rendering or application backend.

The inspected Hetzner host uses `/etc/caddy/Caddyfile`, which imports
`/etc/caddy/conf.d/*.Caddyfile`. The live supplemental file is
`/etc/caddy/conf.d/mysignet-privacy.Caddyfile`.

Before applying an edit, read the current files and loaded configuration. Validate
the complete configuration with `caddy validate --config /etc/caddy/Caddyfile`
before `systemctl reload caddy`. Preserve unrelated sites and check that existing
HTTPS routes retain their handlers. Check origin certificates for every proxied
hostname before enabling Cloudflare Full (strict).

Verification must cover direct-origin HTTP and HTTPS, with harmless query-string
markers, as well as public requests through Cloudflare. Confirm that redirects
preserve the query and the marker does not appear in the Caddy journal. Do not
use real proofs, personal data or signing credentials as probes.

Cloudflare Web Analytics and Always Use HTTPS are separate account/zone settings;
this file does not control them. Discarding redirect access logs also does not
eliminate Cloudflare processing, every possible error log or old journal entries.
Do not purge the shared journal to remove historical Signet entries.

To roll back this supplemental route file, first compare it with the recorded
task fingerprint, move only this file out of the imported `*.Caddyfile` pattern,
validate the full configuration and reload. Do not restore a whole-machine
snapshot over unrelated configuration changes. Removing the file also removes
the new `www` route and restores automatic HTTP redirect behaviour.
