# AgentSoul v4 1.0.107

Status: v4 release candidate; post-restart runtime verification is complete. Tag and GitHub Release publication are the remaining steps.

## MCP authentication hotfix

- MCP proxy reads the token per forwarded request from the effective config.dataDir/token.txt. It no longer caches a token at module load or falls back to guessed roots. loadConfig honors AGENT_SOUL_DATA for source-launched MCP workers sharing Core data.
- The local DSH MCP Hub AgentSoul server sets AGENT_SOUL_DATA to the same data directory used by Core.
- Regression coverage uses synthetic credentials only and verifies source-config/environment dataDir divergence, token creation after module import, and token rotation.

## Verification

- Full suite: 299 passed, 0 failed.
- Core shell marker contract selftest: PASS.
- Post-DSH-restart Core health: healthy; active owner is Core events ingress; ingress connected; one Core-owned established OneBot connection to port 3003.
- Production aggregates: received=1901, forwarded=1227, Aurabot.sent=261, outbox.sent=387, errors=7. Outbox reports duplicateEventParts=0 across its recent 64-row correlation ring; earlier bounded review found 20/20 recent rows had valid event/session/part/message correlation, duplicateRows=0. This is bounded evidence, not an all-history claim.
- Aurabot settings save/readback, service-backed mood/sticker routing, missing-LLM explicit status, restart metadata and retired huanqi quota wording remain covered by prior integration/unit tests.
- soul_health succeeded after restart. soul_waker state returned the local Core ledger view; direct local state reports total=0 and badge=0. Empty cap/action soul_ask_host validation reached the handler without dispatch and no longer returned 401.
- Standalone ECHO MCP stats, recall and bounded search succeeded. The bounded search returned total=15, shown=1, 583ms; result text and pointers were suppressed.
- Core ECHO live sync remains enabled=false/running=false; authority view reports sourceAvailable=true, aligned=true, one source row, no issue. AgentSoul v4 derived ECHO index reports ECHO_INDEX_MISSING; no index rebuild was run, per default-off requirement.

## Remaining limitations

- SnowLuma consent remains unknown and auto-attach fails closed.
- Installer end-to-end overwrite test was not run because preflight detects an existing AgentSoul installation/process and refuses destructive replacement.
- Runtime error aggregate is 7; no message bodies, QQ identities, credentials or correlation identifiers were logged in the release note.

## Release lineage

- The previous 1.0.102 tag was pushed to v4 but has no GitHub Release assets.
- The v4 tag will target the commit containing these notes; the GitHub Release will use the three verified 1.0.107 artifacts built from that payload.
