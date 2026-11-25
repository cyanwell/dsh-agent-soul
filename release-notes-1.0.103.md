# AgentSoul v4 1.0.103 hotfix candidate

Status: local candidate only; not tagged/published. The 1.0.102 v4 tag exists but no GitHub Release object was created.

## Fix

- MCP proxy previously read and cached its bearer token at module import, searching candidate roots. In this machine the MCP worker runs from the source tree while Core runs from the installed 1.0.102 tree, so their effective dataDir differed; Core returned 401 to MCP requests.
- The proxy now reads the token before each forwarded request, using only loadConfig().dataDir/token.txt. It does not fall back to another root, log the token, or include it in diagnostics.
- The local MCP Hub AgentSoul server configuration now sets AGENT_SOUL_DATA to the same effective data directory reported by Core. The currently running MCP worker was stopped to force config reload, but the DSH MCP Hub did not respawn it during this turn.

## Verification

- AgentSoul test suite: 298 passed, 0 failed.
- Core shell marker contract selftest: PASS.
- New isolated HTTP regression imports the proxy before the token exists, then creates the token in the configured dataDir and verifies the header by hash only; a second request verifies token rotation is observed. A wrong source-tree token is present to prove it is not selected.

## Runtime status / limitation

- The source fix and local MCP server dataDir setting are in place, but runtime recovery is not yet verified because the MCP Hub child remains disconnected after termination.
- The DSH desktop host must be restarted or its supported MCP-server reload action invoked in an idle window, then verify read-only soul_health and soul_waker state, soul_echo_stats, and a bounded soul_echo_search call.
- Do not claim the ECHO/MCP outage is fixed until those live probes pass. No secret values, message bodies, or QQ identities were read or written by this hotfix.
