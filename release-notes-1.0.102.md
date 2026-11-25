# AgentSoul v4 1.0.102

## Highlights

- Aurabot social message handling is owned by the Core OneBot ingress; the embedded Aurabot OneBot client stays stopped. In Core composition, the generic event responder is gated while the independent soul_waker/leadRelay cross-session request path remains intact.
- Inbound event IDs are correlated explicitly through fresh and pending session turns, per-bubble sends, and outbox receipts. Correlation metadata contains event IDs, a session hash, part index, and returned message ID; it does not include message text or QQ/chat identities.
- Aurabot configuration save/readback, request-body handling, background LLM readiness, sticker-caption readiness, and SnowLuma consent fail-closed behavior have regression coverage.
- soul_waker reads and decides against the Core-owned local Ledger; upstream authoritative ledger writes remain outside this path. ECHO remains disabled/not-imported by default.

## Verification

- AgentSoul test suite: 297 passed, 0 failed.
- Core shell marker contract selftest: PASS.
- Payload verification: 627 files; missing 0, different 0, extra 0.
- Distribution self-check: Setup footer valid, 2,936 ZIP entries, required files present.
- Production: Core health OK; Core ingress is the OneBot owner; one established WS:3003 connection for the Core PID. 22 correlation records observed; the 20-row recent view had complete event/session/part/message metadata. duplicateEventParts=0 and no repeated event/session/part keys in the recent view.

## Known Limitations

- SnowLuma agreements API remains Unauthorized and consent remains unknown. autoAttach stays fail-closed; no consented attachment was performed.
- Installer end-to-end was not run: preflight refused to overwrite an existing AgentSoul installation/process.
- The observed live duplicate metric is zero; the production trace sample is bounded to the latest 20 detailed records and must be interpreted with duplicateEventParts=0. No QQ message body, QQ identity, or credential was logged or included in this release note.
