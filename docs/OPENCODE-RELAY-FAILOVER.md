# OpenCode relay failover candidate

This branch packages the locally validated PR #4998-style no-auth proxy-pool failover, DeepSeek V4.1 Free registry/family recognition, and regression tests. PR #4972 tool normalization is intentionally NOT included.

## Scope and known limits

- Failed relay pools receive distinct virtual `proxy:<poolId>` identities and are excluded on retry. Retry classification supports 403/429/5xx; pool exhaustion stops without silently replaying direct.
- Existing Auto/session/fingerprint code from the fork's master is retained. No production ranks, provider settings, data, or credentials are included.
- Local focused fallback tests: 18 passed. Previous full #4998 validation: 263 passed, 1 failed, 1 todo; cooldown assertion also failed at the untouched baseline. Production build and real streaming relay failover passed during that validation.
- A full OpenCode CLI read → shell → final-answer loop through the relay setup has NOT passed. App-only `403 FreeTierError` can still exhaust both relays and put Auto into cooldown. This is a failover improvement, not a complete fix for OpenCode Free admission.

## Deployment

Select Git branch `fix/opencode-relay-failover-4998` in Dokploy and rebuild from this checkout. The Compose file uses local `build.context: .`; do not substitute the old remote `#master` build context, which ignores the selected branch. Persistent volume, service name, container name, port, and environment are unchanged.

After deploy, check the build's Git commit, `/api/version`, and correlated request logs. Version remains 0.5.104, so version alone cannot distinguish this patch. Verify one failed pool is followed by a different pool and a valid final answer. Do not count an HTTP 200 health response or a retry log alone as end-to-end acceptance.

Keep the previous deployment revision available for rollback. This branch does not authorize changing production ranks, bypassing strictProxy, or removing provider admission checks.
