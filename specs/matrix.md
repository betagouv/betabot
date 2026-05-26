# Matrix connector spec

`src/connectors/matrix.ts`

## Role

Bridges Matrix rooms/DMs to the `Orchestrator`. Handles authentication, E2EE, invite auto-join, message filtering, mention detection, thread tracking, and reply formatting.

## Class

```ts
class MatrixConnector {
  constructor(orchestrator: Orchestrator);
  async start(): Promise<void>;
}
```

## Authentication

Three modes, checked in priority order:

| Priority | Condition                          | Method                                                                                         |
| -------- | ---------------------------------- | ---------------------------------------------------------------------------------------------- |
| 1st      | `$DATA_DIR/credentials.json` exists | Load saved `accessToken` + `deviceId` + `userId` — env-var token/device are ignored.          |
| 2nd      | `MATRIX_ACCESS_TOKEN` is set        | Direct token auth. Device ID resolved via `/account/whoami` unless `MATRIX_DEVICE_ID` is set. |
| 3rd      | `MATRIX_PASSWORD` is set            | `m.login.password` flow — creates a new device once, then saves credentials.                  |

After the first successful login the resulting credentials are written to `$DATA_DIR/credentials.json` so subsequent starts reuse the same device without any manual step.

`MATRIX_DEVICE_ID` (optional): only consulted when there are no saved credentials. Allows pinning a pre-existing device ID.

## Credential persistence

File: `$DATA_DIR/credentials.json` (default `./data/credentials.json`).

```json
{ "accessToken": "...", "deviceId": "...", "userId": "@bot:example.org" }
```

- Created automatically on first start.
- Loaded on every subsequent start, giving the bot a stable E2EE device identity.
- To force re-registration (new device), delete this file.

## E2EE

- Uses `matrix-js-sdk` Rust crypto (`initRustCrypto`).
- `fake-indexeddb` polyfills `IndexedDB` for the crypto WASM module in Node.js.
- Global blacklist of unverified devices: **disabled** (`setGlobalBlacklistUnverifiedDevices(false)`).
- Error on unknown devices: **disabled** (`setGlobalErrorOnUnknownDevices(false)`).
- Encrypted events (`m.room.encrypted`) are processed after the SDK fires `MatrixEventEvent.Decrypted`.

## Crypto state persistence

The Rust crypto WASM stores the Olm account (identity keys, one-time key counter) and Megolm sessions in IndexedDB. Without persistence the account is recreated on every restart, causing:
- one-time key ID conflicts (`signed_curve25519:AAAAAAAAAA0 already exists`) because the counter resets to 0
- session loss so pre-restart messages can't be decrypted

`src/idb-persist.ts` provides `dumpIDB` / `restoreIDB`:
1. On startup, `restoreIDB` loads `$DATA_DIR/crypto-store.json` into the fresh `IDBFactory` **before** `initRustCrypto()` so the WASM finds its existing account and skips `onupgradeneeded`.
2. A 30-second `setTimeout` writes the first snapshot after the WASM's initial one-time key upload has completed (saving immediately after `initRustCrypto()` would capture a "pending upload" state and cause key-ID conflicts on the next restart).
3. A 5-minute `setInterval` keeps subsequent snapshots current.
4. `SIGINT` / `SIGTERM` handlers flush the final state before exit.

Binary values (`Uint8Array`, `ArrayBuffer`) are base64-encoded in the JSON. The file is located at `$DATA_DIR/crypto-store.json` (default `./data/crypto-store.json`).

## Device verification

The bot auto-verifies any SAS verification request it receives:

1. Listens for `CryptoEvent.VerificationRequestReceived` on the client.
2. Calls `request.accept()` to send `m.key.verification.ready`.
3. Waits for the other side to send `m.key.verification.start` (watches `VerificationRequestEvent.Change` until `request.verifier` is set). The bot does **not** call `startVerification()` itself — doing so would create a race where both sides send `start` simultaneously.
4. On `VerifierEvent.ShowSas`, logs the emojis and calls `sas.confirm()` automatically. A 500 ms `setInterval` polls `verifier.getShowSasCallbacks()` as a fallback in case the Rust backend emits SAS before the event listener is registered.
5. Awaits `verifier.verify()` to complete the handshake; the poll timer is cleared in the `finally` block.

Errors are caught and logged; they do not crash the bot. To verify the bot's device from a Matrix client (e.g. Element), initiate a device verification request — the bot will accept it automatically and Element will complete after the user confirms the emojis on their side.

## Sync

- `startClient({ initialSyncLimit: 0, lazyLoadMembers: true })` — no backfill of history.
- The `synced` flag is set on first `PREPARED` state; events received before that are dropped.

## Invite auto-join

On `RoomMemberEvent.Membership`:

- Only acts when `member.userId === ownUserId` and `membership === "invite"`.
- Detects DM rooms via `is_direct: true` in the invite content; adds the room to `dmRooms`.
- Joins the room, then sends `WELCOME_MESSAGE` once per room (tracked in `greetedRooms`).

## Message routing

On `RoomEvent.Timeline`, a message is handled if **any** of the following is true:

| Condition         | Detail                                                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| DM room           | Room has exactly 2 members, or was flagged `is_direct` at invite time.                                                                      |
| Bot mentioned     | `formatted_body` contains `ownUserId`, or `body` contains `ownUserId` (case-insensitive), or `body` contains the local part of `ownUserId`. |
| Active bot thread | A previous bot message exists in this thread (tracked in `activeBotThreads`).                                                               |

Ignored: events before sync, `toStartOfTimeline`, own messages, non-`m.text` messages, decryption failures.

## Thread tracking

When the bot is mentioned, the `threadRoot` event ID is added to `activeBotThreads`. Subsequent messages in the same thread are handled without requiring another mention.

Thread root resolution:

- If the event has `m.relates_to.rel_type === "m.thread"` → `relates_to.event_id`.
- Otherwise → `event.getId()` (the event itself is the thread root).

## Text cleaning

Before sending to the orchestrator, the bot's own user ID and display name are stripped from the message body (regex, case-insensitive).

## Sending replies

`sendMessage(roomId, text, replyToEventId?, threadRootId?)`:

- Content type: `m.text` with `format: org.matrix.custom.html`.
- `formatted_body`: Markdown rendered to HTML via `marked`.
- In a thread: `m.relates_to` with `rel_type: m.thread` + `m.in_reply_to`.
- In a DM (no thread): plain `m.in_reply_to` only.

On orchestrator error, sends `_(Erreur interne, merci de réessayer.)_` as fallback.

## Welcome message

Sent once per room on first join. Lists the bot's capabilities in French with bullet points and emojis.

## Config used

`config.matrix.{homeserver, user, accessToken, password, deviceId}` from `src/config.ts`.

## npm scripts

| Script                  | Command                                                  |
| ----------------------- | -------------------------------------------------------- |
| `npm run dev`           | `node --env-file=.env --import tsx src/index.ts`         |
| `npm run start`         | `node --env-file=.env dist/src/index.js`                 |
| `npm run get-device-id` | `node --env-file=.env --import tsx src/get-device-id.ts` |
