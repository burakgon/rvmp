# sshx: E2E terminal relay, room protocol, and server mesh

Date: 2026-07-20 · Repo: github.com/ekzhang/sshx @
`dd42496be83da6a7cbb963aee54ba9402f0ddd98`
(`v0.4.1-2-gdd42496`, commit date 2025-06-19, Rust/TypeScript, MIT) · Clone kept at
`/Users/burakgon/.claude/jobs/b3095dd6/tmp/sshx`.
All unqualified `file:line` refs below are into sshx at that SHA.

**Headline: sshx is excellent prior art for outbound terminal hosting, multiplexed
relay rooms, bounded queues, byte-offset output resynchronization, and owner-node
proxying. Its cryptography is not the construction codegent should copy. sshx has no
public-key handshake and no AEAD: a 14-character URL-fragment bearer secret is run
through Argon2id and used as an AES-128-CTR key. The relay receives a deterministic
key verifier, parses every control message, stores encrypted terminal chunks plus
plaintext metadata, and can replay or modify terminal ciphertext undetectably. This is
passive-relay confidentiality for terminal bytes, not codegent's stronger authenticated,
all-content-opaque relay contract.**

The target codegent contract is stricter: X25519 device identity and per-connection key
agreement, authenticated frames, one `crypto_secretstream` per direction, per-device
revocation, fragment-based TOFU pairing, LAN-direct transport, and a signed remote UI
(`docs/superpowers/specs/2026-07-19-codegent-design.md:237-248`).

## 1. Crypto construction: exact source truth

### 1.1 Secret generation and URL construction

The native host generates the terminal secret locally with
`rand_alphanumeric(14)` and labels it **83.3 bits of entropy**
(`crates/sshx/src/controller.rs:48-62`). `rand_alphanumeric` uses Rust `thread_rng()`
and the 62-character alphanumeric distribution (`crates/sshx-core/src/lib.rs:21-29`).
If `--enable-readers` is enabled, it independently generates a second 14-character
write password (`crates/sshx/src/controller.rs:64-73`). These are random bearer
credentials, not human passwords and not device keys.

The host first calls the relay's `Open` RPC without either raw secret. Only after the
relay returns `/s/<room>` does the host append `#<terminal-secret>` locally; the
writable link appends `,<write-password>` after the same fragment
(`crates/sshx/src/controller.rs:83-96`). The browser reads the values only from
`window.location.hash` (`src/lib/Session.svelte:132-142`) and opens its socket at
`/api/s/${id}`, with no secret in that path (`src/lib/Session.svelte:144-145`). This is
the correct fragment pattern: URI fragments are removed before dereference and handled
by the user agent, per [RFC 3986 section 3.5](https://www.rfc-editor.org/rfc/rfc3986.html#section-3.5).
The application never copies the raw fragment into an HTTP, WebSocket, or gRPC field.

That fact protects the fragment from an honest server's request logs. It does **not**
protect it from JavaScript served by that server: the served app itself reads
`window.location.hash`, so a malicious replacement bundle can exfiltrate the secret
before doing any encryption.

### 1.2 KDF parameters and cipher

Rust and browser implementations intentionally match:

| Property | Exact sshx value | Evidence |
|---|---:|---|
| KDF | Argon2id, version `0x13` / v1.3 | `crates/sshx/src/encrypt.rs:20-27` |
| Salt | One fixed public ASCII sentence, global to sshx.io | `crates/sshx/src/encrypt.rs:7-10`; browser twin `src/lib/encrypt.ts:8-9` |
| Memory cost | `19 * 1024` KiB = **19,456 KiB (19 MiB)** | `crates/sshx/src/encrypt.rs:23-27`; `src/lib/encrypt.ts:18-25` |
| Time cost | **2** iterations | same refs |
| Parallelism | **1** lane | same refs |
| Output | **16 bytes / 128 bits** | same refs |
| Cipher | AES-128 in CTR mode, 64-bit big-endian counter | `crates/sshx/src/encrypt.rs:3-5,14-16`; `src/lib/encrypt.ts:27-37,67-75` |
| Authentication | **None**: no MAC and no AEAD tag | `crates/sshx/src/encrypt.rs:43-57`; ciphertext length equals plaintext in tests at `:74-81` |

`aes_key: [u8; 16]` is a 16-**byte** AES-128 key; the source comment saying
`// 16-bit` is a typo (`crates/sshx/src/encrypt.rs:14-16`). The browser uses
`argon2-browser` for the KDF and WebCrypto `AES-CTR` for encryption
(`package.json:14-21`; `src/lib/encrypt.ts:14-38`). The browser is therefore a
Svelte/TypeScript client with an Argon2 browser module and WebCrypto, not a Rust
application protocol compiled wholesale to WASM.

### 1.3 Counter/nonce discipline

sshx models every encrypted byte sequence as a seekable CTR stream:

- The 128-bit AES counter block starts with an 8-byte big-endian `stream_num`; the
  lower 8 bytes are initially zero. Rust seeks to the byte `offset`
  (`crates/sshx/src/encrypt.rs:47-57`). The browser writes `streamNum` into the high
  64 bits, `offset >> 4` into the low 64-bit block counter, and pads to
  `offset % 16` before calling WebCrypto (`src/lib/encrypt.ts:51-76`).
- Daemon → browser terminal output uses stream number
  `0x1_0000_0000 | shell_id`, and its absolute terminal byte sequence number as the
  CTR offset (`crates/sshx/src/runner.rs:113-127`). A shell's retransmitted bytes
  therefore reproduce the same ciphertext at the same positions.
- Browser → daemon input uses the single stream number `0x2_0000_0000` for every
  shell and every viewer. Each loaded page chooses one random 64-bit starting byte
  offset, then reserves monotonically increasing ranges before each asynchronous
  encrypt call (`src/lib/Session.svelte:263-301`). Random starts make overlap unlikely,
  but there is no assigned per-viewer stream namespace and no collision proof.
- Stream number zero is rejected for ordinary data (`crates/sshx/src/encrypt.rs:47-49`).
  Separately, `zeros()` encrypts one all-zero block under an all-zero counter and uses
  the deterministic 16-byte result as the key verifier
  (`crates/sshx/src/encrypt.rs:35-40`).

This arrangement avoids deterministic reuse between output shells and the input
direction under normal operation. It does not supply integrity, sender identity,
cryptographic ordering, or replay rejection. An active relay can flip ciphertext bits,
change the plaintext shell ID or offset, redirect an input ciphertext to another shell,
or replay a previously valid input; the daemon will decrypt and write it. Multiple
viewers also share the input stream namespace, so overlapping random offset ranges would
reuse CTR keystream.

### 1.4 What sshx calls a handshake

There is **no ECDH/public-key handshake** and no forward-secret session negotiation.
There are two separate server-authentication flows:

1. **Host opens the room.** `OpenRequest` contains the requested web origin, terminal
   `encrypted_zeros`, plaintext display name, and optional write-password verifier
   (`crates/sshx-core/proto/sshx.proto:39-45`). The server creates a random
   10-character room name, stores those fields, and returns the room name, URL, and
   `HMAC-SHA256(server_secret, room_name)` token
   (`crates/sshx-server/src/grpc.rs:45-71`; HMAC state at
   `crates/sshx-server/src/state.rs:29-63`). The HMAC token authenticates the native
   host on later `Channel`/`Close` calls; it is not an E2E key.
2. **Browser proves knowledge.** The server actually sends `Hello(uid, session_name)`
   before authentication, then requires the first browser message to be
   `Authenticate(encrypted_zeros, optional_write_zeros)` and compares both verifiers in
   constant time (`crates/sshx-server/src/web/socket.rs:94-128`). Matching the terminal
   verifier grants room access. With read-only mode, absence of the write verifier gives
   read access and equality grants write access.

The relay never receives the raw fragment or AES key. It **does** receive a deterministic
offline verifier of both secrets. Because the salt and derivation are global and public,
the relay can test guesses offline and can recognize reuse of the same secret across
rooms. With sshx's random 83.3-bit values, brute force remains impractical; Argon2 is not
what creates that entropy.

### 1.5 The actual zero-knowledge boundary

The server's per-room metadata is the terminal verifier, plaintext human-readable
session name, and optional write verifier (`crates/sshx-server/src/session.rs:28-39`).
It stores encrypted output chunks together with plaintext shell IDs, byte sequence and
chunk offsets, closed state, and window geometry (`crates/sshx-server/src/session.rs:82-102`;
serialized schema at `crates/sshx-core/proto/sshx.proto:100-120`). It also maintains
plaintext viewer names, cursor positions, focused shell IDs, and write status
(`crates/sshx-server/src/web/protocol.rs:32-44`). Chat is sent and broadcast as plaintext
`String` values (`crates/sshx-server/src/web/protocol.rs:62-63,95-96`;
`crates/sshx-server/src/session.rs:358-368`).

So the honest statement is:

- sshx's relay cannot passively read **terminal input/output bytes** without the
  fragment-derived key.
- It sees room IDs, session titles, user metadata, terminal topology and dimensions,
  exact terminal ciphertext lengths and byte offsets, all semantic control operations,
  timing, latency, errors, and chat content.
- It can actively alter terminal traffic without detection because AES-CTR is not
  authenticated.

That is materially weaker than codegent's requirement that the relay see only device
IDs, opaque frame sizes, and timing.

### 1.6 Crypto-fork verdict

**Keep codegent's X25519 device-key model and authenticated libsodium stream; do not
adopt sshx's Argon2 → AES-CTR construction.** The models serve different products:

| Design question | sshx | codegent decision |
|---|---|---|
| Primary object | Short-lived anonymous room | Long-lived daemon paired with several browser devices |
| Credential | Shared symmetric bearer fragment | One-time pairing capability that authorizes/pins a distinct browser device key |
| Identity/revocation | Everyone with a link is equivalent; optional relay-enforced writer password | Stable per-device identity, list/revoke one browser, confirm new devices, rotate all links |
| Key agreement | None | X25519-derived per-connection directional keys |
| Live encryption | AES-128-CTR, no authentication | `crypto_secretstream_xchacha20poly1305` per direction |
| Replay/reorder | Transport ordering plus app byte offsets; no crypto rejection | Secretstream rejection plus application connection epoch/sequence for reconnect dedup |
| Relay semantics | Parses control plane; encrypts terminal byte fields only | Routes an opaque encrypted inner protocol |

Libsodium's `crypto_kx` API derives distinct receive/transmit keys from X25519 and peer
public keys, but its own precondition is that the peer public key is already known
([official key-exchange documentation](https://doc.libsodium.org/key_exchange)). Plan 3
must therefore specify how the fragment pairing capability authenticates the initial
daemon/browser public-key transcript and how the browser pins the daemon key; raw X25519
through a malicious relay is otherwise MITM-able. For later connections, the daemon must
authorize the pinned browser key before accepting the stream. If forward secrecy is a
requirement, use authenticated ephemeral X25519 keys rather than only static device-key
`crypto_kx`; that is a handshake decision still missing from §10's one-line primitive
list.

`crypto_secretstream_xchacha20poly1305` is itself an ordered authenticated-encryption
construction: it generates its nonce/header, authenticates each message, detects
modification/removal/duplication/reordering, and supports rekey tags
([official secretstream documentation](https://doc.libsodium.org/secret-key_cryptography/secretstream)).
Interpret the current codegent wording “XChaCha20-Poly1305 frames” + “secretstream per
direction” as **one secretstream-protected frame sequence per direction**, not two nested
encryption layers. Standalone XChaCha20-Poly1305 is useful for independently decryptable
stored/datagram records; it is redundant around the same live secretstream frame.

Argon2 remains appropriate if codegent ever accepts a human-memorable password. A random
256-bit fragment pairing capability does not need password stretching; it needs strict
single-use/expiry semantics and transcript binding.

## 2. Relay framing and protocol

sshx has **two different relay legs**, not one symmetric WebSocket protocol:

```
native sshx host ── outbound HTTPS/gRPC bidirectional stream ──► relay
browser viewer   ── WSS, binary CBOR messages                ──► relay
```

The Rust server explicitly combines a Tonic gRPC handler and Axum HTTP/WebSocket handler
on one Hyper listener (`crates/sshx-server/src/lib.rs:1-10`;
`crates/sshx-server/src/listen.rs:14-60`). The host therefore opens no inbound port, but
it is not a WebSocket client.

### 2.1 Native host ↔ relay: Protobuf over bidirectional gRPC

The complete service is three RPCs: unary `Open`, bidirectional streaming `Channel`, and
unary `Close` (`crates/sshx-core/proto/sshx.proto:7-16`). The exact shapes are:

| Direction | Protobuf message / oneof | Fields |
|---|---|---|
| Host → server | `OpenRequest` | `origin:string`, `encrypted_zeros:bytes`, `name:string`, `write_password_hash?:bytes` |
| Server → host | `OpenResponse` | `name:string`, `token:string`, `url:string` |
| Host → server, first stream item | `ClientUpdate.hello` | one string formatted exactly as `"<name>,<token>"` |
| Host → server | `data: TerminalData` | `id:u32`, encrypted `data:bytes`, first-byte `seq:u64` |
| Host → server | `created_shell: NewShell` | `id:u32`, `x:i32`, `y:i32` |
| Host → server | `closed_shell:u32` | shell ID |
| Host → server | `pong:fixed64` | echoed server timestamp |
| Host → server | empty `ClientUpdate` | heartbeat |
| Server → host | `input: TerminalInput` | `id:u32`, encrypted `data:bytes`, CTR `offset:u64` |
| Server → host | `create_shell: NewShell` | `id:u32`, `x:i32`, `y:i32` |
| Server → host | `close_shell:u32` | shell ID |
| Server → host | `sync: SequenceNumbers` | map `shell_id:u32 → received_bytes:u64` |
| Server → host | `resize: TerminalSize` | `id:u32`, `rows:u32`, `cols:u32` |
| Server → host | `ping:fixed64` | server timestamp |
| Either way | `error:string` | plaintext application error |

These field numbers and types are the protocol source of truth
(`crates/sshx-core/proto/sshx.proto:18-98`). Shell IDs multiplex all PTYs over one gRPC
channel. Only `TerminalData.data` and `TerminalInput.data` are encrypted; every operation,
ID, offset, size, error, and synchronization map is relay-readable.

The first stream item is validated as `name,token` before the server looks up or restores
the room (`crates/sshx-server/src/grpc.rs:74-97`). The server then multiplexes periodic
sync/ping events, browser-originated commands, daemon events, and shutdown on one `select!`
loop (`crates/sshx-server/src/grpc.rs:137-186`).

### 2.2 Browser ↔ relay: binary CBOR over WebSocket

Browser messages are CBOR objects serialized by `cbor-x`; the client sends only binary
WebSocket messages (`src/lib/srocket.ts:8-15,62-74,89-106`). The server uses matching
Serde enums and `ciborium`, ignores text frames, and emits one CBOR object per binary
WebSocket message (`crates/sshx-server/src/web/socket.rs:72-92`). With Serde's external
camel-case tag, the exact application shapes are the one-property objects below
(`src/lib/protocol.ts:20-47` mirrors the Rust source):

**Browser → server**

```text
{ authenticate: [encryptedZeros: bytes, writeEncryptedZeros: bytes | null] }
{ setName: string }
{ setCursor: [x: i32, y: i32] | null }
{ setFocus: sid | null }
{ create: [x: i32, y: i32] }
{ close: sid }
{ move: [sid, { x: i32, y: i32, rows: u16, cols: u16 } | null] }
{ data: [sid, ciphertext: bytes, ctrOffset: u64] }
{ subscribe: [sid, chunkIndex: u64] }
{ chat: string }
{ ping: u64 }
```

**Server → browser**

```text
{ hello: [uid, plaintextSessionName] }
{ invalidAuth: [] }
{ users: [[uid, { name, cursor, focus, canWrite }], ...] }
{ userDiff: [uid, user | null] }
{ shells: [[sid, { x, y, rows, cols }], ...] }
{ chunks: [sid, firstByteSeq: u64, [ciphertextChunk, ...]] }
{ hear: [uid, plaintextUserName, plaintextChat] }
{ shellLatency: u64 }
{ pong: u64 }
{ error: string }
```

The canonical Rust definitions are `crates/sshx-server/src/web/protocol.rs:7-99`.
The relay parses and acts on every one of these variants. This is **field encryption**,
not an opaque E2E envelope.

### 2.3 Output routing, synchronization, duplicates, and gaps

Daemon output is a seekable append log per shell:

- The daemon emits at most **64 KiB** of terminal text per `TerminalData` message and
  retains at least **8 MiB**, pruning only after its local buffer exceeds **12 MiB**
  (`crates/sshx/src/runner.rs:15-17,113-137`).
- The relay accepts a chunk only if it overlaps the current tail and extends it:
  `seq <= current_seq && seq + len > current_seq`. It slices off the already-seen
  prefix, appends only the new suffix, and ignores full duplicates and forward gaps
  (`crates/sshx-server/src/session.rs:258-287`). This is idempotent byte-log repair,
  not cryptographic anti-replay.
- Every **5 seconds**, the relay sends the received byte count of every open shell
  (`crates/sshx-server/src/grpc.rs:22-26,143-157`). If the daemon sees a lower relay
  sequence three times, it rewinds its local send cursor and retransmits from that byte
  (`crates/sshx/src/runner.rs:86-98`).
- A browser subscribes by **chunk index**, not byte sequence. The relay returns all
  retained chunks plus the byte sequence at which the first returned chunk starts
  (`crates/sshx-server/src/session.rs:158-197`). On reconnect the browser keeps its
  per-shell chunk count, clears the socket's subscription set, and resubscribes
  (`src/lib/Session.svelte:181-193,218-224`). Per-shell async locks preserve browser
  decrypt/render order (`src/lib/Session.svelte:158-172`; `src/lib/lock.ts:1-28`).

This recovers missing **output** after a relay replica transfer or WebSocket reconnect.
Browser input has no analogous acknowledgement, idempotency key, or resume log. A keypress
sent as the socket dies can be lost; a replay can execute it twice. WebSocket/TCP and
gRPC ordering are relied upon for normal delivery. AES-CTR offsets merely locate
keystream and do not reject duplicates or reordering.

For codegent, steal the `Subscribe(stream_id, last_applied)` /
`Chunks(stream_id, base_seq, frames[])` and periodic `Sync(map)` ideas, but put every
semantic field inside the encrypted inner protocol. On every reconnect, create fresh
directional secretstreams, send an encrypted resume cursor, and retransmit daemon-owned
events under the **new** stream. Keep an application connection epoch + message/PTY byte
sequence for cross-connection dedup; secretstream's in-stream replay protection alone
cannot decide whether a freshly encrypted reconnect command was already applied on the
previous connection.

### 2.4 Backpressure and flow control

sshx consistently uses bounded internal queues:

- Native shell output → controller: Tokio MPSC **64**; per-gRPC connection: MPSC
  **16**; relay → host commands: async-channel **256**; per-shell input queue: MPSC
  **16** (`crates/sshx/src/controller.rs:40-45,98,163,248-251`;
  `crates/sshx-server/src/session.rs:104-118`). Sending awaits capacity, including the
  per-shell write path (`crates/sshx/src/controller.rs:197-202`).
- Relay → one browser's output subscription fan-in uses an MPSC of **1** and awaits
  each WebSocket send (`crates/sshx-server/src/web/socket.rs:136-155,231-240`).
- Room metadata broadcasts use a Tokio broadcast ring of **64**. A lagging browser gets
  `client fell behind on broadcast stream` and its socket exits rather than silently
  applying a hole (`crates/sshx-server/src/session.rs:62-67,104-118`;
  `crates/sshx-server/src/web/socket.rs:141-147`).
- The browser queues at most **64 CBOR messages** while disconnected and silently drops
  additional sends. It calls this “at-most-once” and reconnects after 500 ms
  (`src/lib/srocket.ts:10-15,62-75,84-99`). Once connected it calls WebSocket `send`
  without checking `bufferedAmount`, so there is no explicit browser-side high-water
  mark for a slow but still-open socket (`src/lib/srocket.ts:62-74`).

There is no credit/window protocol and no application-level maximum CBOR frame size in
the handler. The useful pattern for codegent is bounded queues with explicit policy on
overflow: output/state events should be resumable; PTY input must never be silently
queued across a dead connection or silently dropped; slow consumers should disconnect
and resume from an acknowledged cursor.

## 3. Session/room and access model

### 3.1 Room creation and outbound-only host

The `sshx` binary defaults to `https://sshx.io`, chooses the local shell and plaintext
`user@host` room title, constructs the controller, prints the URL, then runs until Ctrl-C
(`crates/sshx/src/main.rs:10-34,74-112`). All host networking is outbound Tonic
`SshxServiceClient::connect(origin)` (`crates/sshx/src/controller.rs:114-121,161-170`).
Browser `Create` asks the relay for a shell ID; the relay sends `CreateShell` down the
existing gRPC stream, and only then does the host spawn the local PTY task
(`crates/sshx-server/src/web/socket.rs:177-188`;
`crates/sshx/src/controller.rs:206-213,248-273`). No NAT traversal or inbound host port
is required.

The public room ID is a random 10-character alphanumeric string, generated server-side
(`crates/sshx-server/src/grpc.rs:45-52`). The host-only HMAC token is separate from the
fragment and authorizes reconnect and close (`crates/sshx-server/src/grpc.rs:65-71,112-133`).

### 3.2 Multi-viewer and write access

Each authenticated WebSocket gets a monotonically assigned `Uid`; the room keeps a map
of connected users and broadcasts join/change/leave diffs
(`crates/sshx-server/src/session.rs:289-346`). Multiple viewers are first-class—the
integration test opens two sockets and observes two users
(`crates/sshx-server/tests/with_client.rs:146-172`). A room can contain multiple shells,
multiplexed by `Sid`.

Default mode has no read-only class: once the terminal verifier matches, **every viewer
can write** (`crates/sshx-server/src/web/socket.rs:99-110`). With `--enable-readers`, the
CLI prints:

```text
read-only: https://host/s/<room>#<terminal-key>
writable:  https://host/s/<room>#<terminal-key>,<write-password>
```

The formatting is implemented at `crates/sshx/src/main.rs:30-55`; fragment assembly is
at `crates/sshx/src/controller.rs:90-96`. The relay checks write permission before
create/close/move/data operations (`crates/sshx-server/src/web/socket.rs:177-225`). This
is relay-enforced authorization, not E2E writer authentication: read-only viewers know
the same AES terminal key, and a malicious relay can grant them write permission.

There are no accounts, durable user identities, per-viewer device keys, approval flow,
or single-device revocation. User IDs are room-local counters and display names are
self-asserted. To revoke a leaked terminal or write link, the host must close the whole
room and create a new one. This directly conflicts with codegent's long-lived paired
device list, revoke-one-device operation, link rotation semantics, and already-paired
surface confirmation.

## 4. Server architecture, state, scaling, and lifecycle

### 4.1 Stack and local state

The server is a Rust 2021 Tokio application: Tonic/Protobuf for gRPC, Axum for HTTP and
WebSocket, Hyper/Tower for the shared listener, DashMap + parking_lot for concurrent
room state, and optional Redis for mesh storage (`crates/sshx-server/Cargo.toml:10-44`;
`crates/sshx-server/src/listen.rs:27-60`). Static SvelteKit files are served from
`build/`, with SPA fallback (`crates/sshx-server/src/web.rs:14-33`).

Without Redis, all rooms live only in a process-local `DashMap<String, Arc<Session>>`
(`crates/sshx-server/src/state.rs:29-42,70-98`). A restart loses them. With Redis, the
relay can restore room state and transfer ownership across replicas.

Source-level resource bounds are concrete:

| Resource | Bound | Evidence |
|---|---:|---|
| In-memory relay output history | **2 MiB per shell** | `crates/sshx-server/src/session.rs:25-26,269-281` |
| Host resend history | Keep ≥ **8 MiB**, prune after > **12 MiB**, per shell | `crates/sshx/src/runner.rs:15-17,132-137` |
| Output message | At most **64 KiB** | `crates/sshx/src/runner.rs:15,113-127` |
| Redis snapshot output tail | At most **32 KiB per shell** | `crates/sshx-server/src/session/snapshot.rs:15-16,31-50` |
| Decompressed/encoded snapshot | Strictly under **4 MiB** | `crates/sshx-server/src/session/snapshot.rs:18,67-75` |
| Snapshot compression | zstd level **3** | `crates/sshx-server/src/session/snapshot.rs:67-70` |
| Redis connection pool | **10** | `crates/sshx-server/src/state/mesh.rs:40-47` |

There is no committed idle-RSS or CPU benchmark. There are also important missing
server-side caps: no maximum rooms, viewers, shells per room, name/chat length, or total
room memory is enforced in the Rust handler. The UI refuses to create shell 15, but that
is only a browser check (`src/lib/Session.svelte:265-278`). Fly's deployment configuration
adds a connection soft limit of 1,024 and hard limit of 65,536, not an application quota
(`fly.toml:10-18`). Codegent should retain sshx's per-stream buffers but enforce relay-side
connection/device/frame-rate/frame-size caps even when the default policy is “unlimited.”

### 4.2 Redis persistence and owner-node routing

When configured, Redis holds three hash-tagged keys per room: `owner`, `snapshot`, and
`closed`. Owner and snapshot are refreshed every **20 seconds** or immediately after
topology/counter changes; every key has a **300-second TTL**
(`crates/sshx-server/src/state/mesh.rs:13-22,85-137`). The snapshot is a zstd-compressed
Protobuf containing verifiers, plaintext metadata/layout/counters, and encrypted terminal
output (`crates/sshx-server/src/session/snapshot.rs:20-70`). Redis is therefore still
zero-knowledge only for the AES-encrypted terminal byte fields, not for the room control
plane.

One relay instance owns the live in-memory `Session`:

- A browser that lands on a non-owner looks up `owner` and the receiving node proxies
  its WebSocket to `ws://<owner>/api/s/<room>` over the private mesh
  (`crates/sshx-server/src/state.rs:131-149`;
  `crates/sshx-server/src/web/socket.rs:23-69,254-310`).
- A reconnecting native host that lands on another replica loads the Redis snapshot,
  becomes owner, and publishes a transfer notification to the previous owner; the old
  node removes and shuts down its session (`crates/sshx-server/src/state.rs:109-128,152-159`;
  `crates/sshx-server/src/state/mesh.rs:157-200`).
- All nodes must reach each other over TCP mesh networking
  (`crates/sshx-server/src/state/mesh.rs:24-31`).

This owner pin + transparent proxy is directly reusable for a first horizontal codegent
relay. The persisted object should differ: codegent's daemon owns cards, scrollback, and
resume truth, so the relay should persist only opaque device presence/lease/routing data
(and at most opaque bounded frames if Plan 3 explicitly needs them), not a decoded room
snapshot. A non-owner node can proxy opaque WSS bytes to the owner exactly as sshx does.

### 4.3 Reconnect, expiry, and GC

The host sends an empty application heartbeat every **2 seconds**, and voluntarily opens
a fresh gRPC connection every **60 seconds** so it can escape a draining replica
(`crates/sshx/src/controller.rs:22-26,161-193`). Failures retry after 1, 2, 4, 8, then
16 seconds (16-second cap), resetting after a connection lasted at least 10 seconds
(`crates/sshx/src/controller.rs:143-159`). Its bounded output queues and rolling terminal
history survive channel reconnect, while the relay's sequence map drives retransmission.

The browser reconnects every **500 ms**, authenticates again, resets presence/latency,
and resubscribes to shells from retained chunk indexes (`src/lib/srocket.ts:84-125`;
`src/lib/Session.svelte:210-245`). Up to 64 messages produced while disconnected are sent
after the new authentication; excess messages are dropped.

Only backend/host messages refresh `last_accessed`
(`crates/sshx-server/src/grpc.rs:189-223`; `crates/sshx-server/src/session.rs:376-384`).
Every minute the server scans rooms and permanently closes any whose host has been absent
for **300 seconds**, even if browser viewers remain connected
(`crates/sshx-server/src/state.rs:22-27,162-178`). Closing removes the snapshot, writes a
300-second `closed` tombstone, and notifies the owner (`crates/sshx-server/src/state/mesh.rs:140-155`).

The server HMAC secret defaults to a fresh random 22-character value at process start
(`crates/sshx-server/src/state.rs:44-57`). Production replicas/restarts must therefore
share a stable `SSHX_SECRET`; otherwise existing host tokens fail validation **before** a
Redis snapshot can be restored (`crates/sshx-server/src/grpc.rs:74-97`). This operational
dependency is easy to miss.

For codegent's always-on daemon fleet, copy the lease/owner/transfer shape but not the
2-second heartbeat blindly: it exists partly for live latency measurement and would be
25,000 application heartbeats/second at 50,000 connected daemons. Plan 3 should set a
proxy-compatible ping/lease cadence from scale and failure-detection requirements, while
retaining immediate reconnect and daemon-owned event replay.

## 5. Transport, latency, and LAN-direct

### 5.1 WSS/gRPC and keepalive behavior

- Browser WebSocket URL is derived from the page scheme (`https:` → `wss:`, otherwise
  `ws:`), and all app messages are binary CBOR (`src/lib/srocket.ts:40-47,89-106`).
- The browser sends an application `Ping(Date.now())` every **2 seconds**; the server
  echoes `Pong` for browser↔relay latency (`src/lib/Session.svelte:238-245`;
  `crates/sshx-server/src/web/socket.rs:243-248`). There is no application code sending
  WebSocket protocol Ping control frames; non-binary/non-text frames are ignored in the
  main socket handler (`crates/sshx-server/src/web/socket.rs:82-91`).
- The gRPC relay sends a timestamp ping every **2 seconds**, the host returns a pong, and
  the relay broadcasts measured host latency to viewers
  (`crates/sshx-server/src/grpc.rs:22-26,146-161,213-215`;
  `crates/sshx/src/controller.rs:237-240`). The UI shows the median of the latest ten
  browser↔relay and relay↔host samples (`src/lib/Session.svelte:129-130,199-204,248-257`).
- The server sets `TCP_NODELAY` on accepted sockets
  (`crates/sshx-server/src/lib.rs:91-101`). The browser includes a VS Code-derived local
  typeahead predictor: it begins showing predictions after enough accurate samples when
  median observed echo latency reaches **50 ms**, and turns them off with hysteresis
  (`src/lib/typeahead.ts:1598-1608,1736-1767`; wired at
  `src/lib/ui/XTerm.svelte:106-115,197-210`).

WebSocket reconnect is stateful only at the application layer. There is no session-resume
extension at the WSS transport layer and no browser input acknowledgement. The relay's
output chunk log supplies terminal replay.

### 5.2 LAN-direct / P2P answer

**sshx does not implement LAN-direct, WebRTC, ICE/STUN/TURN, or any other P2P data path.**
The host always connects to the configured HTTP(S) relay via Tonic
(`crates/sshx/src/main.rs:14-16`; `crates/sshx/src/controller.rs:114-121`), and the browser
always connects back to the serving origin's `/api/s/<room>` WebSocket
(`src/lib/Session.svelte:144-145`). Neither Rust nor web dependency manifests contain a
WebRTC/ICE stack (`crates/sshx/Cargo.toml:12-35`; `package.json:14-54`). “Nearest peer” in
the marketing page means the nearest server replica, not a direct daemon connection.

**codegent can do LAN-direct, but it is a separate transport project, not something to
inherit from sshx.** The browser-native path with the fewest local-PKI problems is an
ordered reliable WebRTC `RTCDataChannel`: use the relay only for authenticated E2E
offer/answer/ICE signaling, let ICE select a host/LAN candidate when possible, and fall
back to the existing relay WSS path when direct establishment fails. The W3C WebRTC
Recommendation explicitly supports generic peer-to-peer application data plus
ICE/STUN/TURN discovery ([W3C WebRTC sections 1 and 6](https://www.w3.org/TR/webrtc/)).
Keep codegent's own X25519 + secretstream protocol above WebRTC/DTLS so both transports
have identical E2E identity, framing, resume, and relay-threat properties. Direct WSS to
a daemon's private address is possible only after separately solving browser trust/local
network permissions and daemon TLS identity; it is not the zero-friction primary path.

LAN-direct should therefore be an opportunistic race after the relay connection is live,
never a prerequisite for pairing or reconnect. Migration between relay and direct paths
must start a new connection epoch/secretstream and resume from acknowledged application
sequence, not transplant secretstream state across transports.

## 6. Deployment and the c4a + Caddy target

### 6.1 What sshx actually deploys

The production image is a three-stage Docker build:

1. Rust Alpine builds the release `sshx-server` binary.
2. Node LTS Alpine runs `npm ci` and builds the static SvelteKit app.
3. Final `alpine:latest` contains only `build/` and `sshx-server`, then runs
   `./sshx-server --listen ::` (`Dockerfile:1-22`).

The binary serves the UI and multiplexes HTTP, WebSocket, and gRPC on port **8051**.
CLI configuration is deliberately small: `--port` (8051), `--listen` (`::1` by
default), token-signing `--secret` / `SSHX_SECRET`, `--override-origin`,
`--redis-url` / `SSHX_REDIS_URL`, and mesh `--host`
(`crates/sshx-server/src/main.rs:12-39`).

Hosted sshx runs on Fly.io with Redis Cloud (`README.md:111-118`). Fly terminates
HTTP/TLS on 80/443, advertises ALPN `h2` and `http/1.1`, forwards to internal port 8051,
checks TCP every 15 seconds, and gives graceful shutdown 90 seconds
(`fly.toml:1-35`). The Rust listener itself has no built-in certificate/key configuration.
The README explicitly says a custom deployment must supply HTTP/TCP reverse proxying,
gRPC forwarding, TLS termination, private mesh networking, and graceful shutdown
(`README.md:111-121`). `compose.yaml` is development-only Redis, not a production stack
(`compose.yaml:1-12`).

The release script builds Linux `aarch64-unknown-linux-musl` and packages both client
and server binaries (`scripts/release.sh:15-18,59-68`), so the Rust server shape is
compatible with GCP c4a ARM. The repository does not publish a measured idle RSS/CPU or
final image-size budget, and this environment did not have Cargo available to produce a
same-commit local measurement; use the source-level per-shell bounds in §4.1 until Plan 3
adds a deployment benchmark.

### 6.2 What to use for codegent

For codegent's first `c4a-standard-1/2` node, the useful deployment choices are:

- Keep the planned **single relay binary + Docker image + Caddy TLS termination**. sshx
  validates this split: the application listens plaintext on a private socket/loopback
  and an external proxy owns certificates.
- codegent uses WSS on both daemon and browser legs, so Caddy only needs ordinary
  WebSocket reverse proxying. If Plan 3 copied sshx's mixed gRPC/HTTP listener instead,
  the upstream must also support cleartext HTTP/2 (`h2c`) for gRPC. Caddy supports both
  WebSocket tunnels and `h2c://` upstreams
  ([official `reverse_proxy` documentation](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)).
- Start single-node with in-memory presence/routing and no Redis content snapshots.
  Reserve the sshx owner-node/Redis pub-sub design for horizontal scale. When added,
  store device→owner leases and opaque routing state, use a stable cluster secret, and
  keep all nodes privately reachable for proxying.
- Add explicit `/healthz` readiness, connection/frame metrics, high-water disconnects,
  and graceful drain. sshx's Fly check is TCP-only and its source has no application
  readiness route (`crates/sshx-server/src/web.rs:26-34`; `fly.toml:31-35`).
- Caddy config reloads can churn long-lived sockets; use Caddy's stream-close-delay/drain
  capability and codegent reconnect jitter so a release does not create a synchronized
  reconnect herd. sshx's browser uses a fixed 500 ms delay with no jitter
  (`src/lib/srocket.ts:10-15,94-99`), which should not be copied at codegent scale.

## 7. Signed/verified client delivery and honest-but-curious trust

sshx does **not** address the served-client problem:

- The relay serves whichever `build/` files are on disk and falls back to `spa.html`;
  there is no signature or pinned manifest check (`crates/sshx-server/src/web.rs:14-29`).
- `src/app.html` has no CSP or subresource-integrity trust anchor
  (`src/app.html:1-32`). The SvelteKit build is merely stamped with a short Git commit
  string for display (`vite.config.ts:1-11`).
- CI tests and deploys `main` directly to Fly after `flyctl deploy`; there is no signing
  job (`.github/workflows/ci.yaml:55-90`).
- The `curl | sh` installer downloads a mutable S3 tarball and immediately extracts or
  runs it without a checksum or signature (`static/get:32-80`).
- The only “signature” in the application is the relay's HMAC token for backend room
  control. It does not authenticate web assets to the browser
  (`crates/sshx-server/src/grpc.rs:65-71,124-133`).

A malicious relay can therefore serve JavaScript that reads the fragment, plaintext,
and keystrokes. sshx's E2E story assumes at least an honest served UI, in addition to an
honest-but-curious data relay.

codegent's signed UI manifest + pinned bootstrap is a real improvement and must ship in
v0.3 as specified. The trust anchor must genuinely be outside the mutable relay response
(for example shipped with the daemon/local UI and retained in an already-installed
bootstrap); a “pinned bootstrap” freshly delivered by the same untrusted relay on every
first load is not a pin. The bootstrap should verify asset hashes, protocol version,
publisher signature, and rollback/version policy before any verified code receives the
fragment. Self-hosting remains a separate operator-trust choice, not a substitute for
authenticated frames.

sshx also has no Web Push/service worker notification channel in this tree. codegent's
§11 path—daemon directly to browser push services, content-minimal payloads, independent
of relay health—is a separate subsystem and should not be routed through or modeled on
sshx.

## 8. Verdict for codegent

### (a) Crypto construction

- **Reject verbatim:** Argon2id(19 MiB, t=2, p=1) → AES-128-CTR, deterministic
  encrypted-zero verifier, random shared input offsets, and relay-enforced write
  password. It has no integrity, active-relay protection, device identity, per-device
  revoke, or cryptographic replay rejection.
- **Keep and finish:** authenticated X25519 device pairing → distinct per-direction
  connection keys → one XChaCha20-Poly1305 secretstream in each direction. Bind protocol
  version, device IDs/roles, both public keys, connection epoch, and the pairing
  capability into the authenticated handshake/transcript. Pin the daemon identity and
  authorize each browser key. Specify whether static-only keys are acceptable or an
  authenticated ephemeral exchange is required for forward secrecy.
- **Use Argon2 only for passwords.** A high-entropy fragment capability should be random,
  single-use, expiring, and never represented to the relay by a reusable deterministic
  verifier.

### (b) Relay mechanics to steal

- One long-lived outbound host connection; multiplex logical streams by integer ID.
- Bounded queues at every handoff and awaitable backpressure.
- `Sync({stream_id: received_seq})`,
  `Subscribe(stream_id, last_applied_chunk_or_seq)`, and
  `Chunks(stream_id, base_seq, frames[])` for reconnect repair.
- Idempotent append of only the unseen suffix of daemon output; keep enough daemon-owned
  history to retransmit after relay state loss.
- Slow metadata consumers disconnect and resume rather than silently missing a broadcast.
- Owner-node lookup + non-owner byte proxy + transfer notification for later horizontal
  scale.

Put all stream IDs, message types, PTY offsets, card/session semantics, user metadata,
errors, and push-relevant events **inside** the authenticated encrypted frame. The relay's
outer envelope should be only version/routing necessities such as source/destination
device ID, connection ID/epoch, opaque ciphertext, and length. Treat even policy notices
as encrypted peer-to-peer messages unless the relay itself is necessarily the policy
speaker; authenticate relay-originated policy separately from daemon-originated content.

### (c) Server/deployment for c4a + Caddy

- Ship the planned ARM multi-stage image with a small private listener and Caddy in front.
- Start without Redis on one VM; preserve sshx's owner/lease abstraction so Redis pub-sub
  or equivalent can be added without changing the E2E frame format.
- Do not store terminal snapshots at the relay. The daemon already owns durable state and
  can replay over a newly authenticated stream after reconnect.
- Enforce frame size, connection/device rate, total buffered bytes, and slow-consumer
  limits server-side even while hosted policy defaults to unlimited.
- Use jittered reconnect, graceful socket drain, observable queue depths, and stable
  routing leases. Do not copy fixed 500 ms browser reconnect or 2-second fleet-wide
  application heartbeats unchanged.

### (d) Model conflicts

sshx has anonymous ephemeral rooms, shared bearer identity, optional server-enforced
read/write classes, plaintext collaboration metadata/chat, server-persisted room state,
and temporary pinning to one relay node. codegent has no accounts too, but its unit is a
long-lived daemon with separately identifiable/revocable browser devices; its daemon owns
state; its relay must not decode semantic control; and its notification path bypasses the
relay. The projects share outbound-only connectivity and link-based bootstrap, not the
same authorization or persistence model.

### (e) LAN-direct

sshx provides none. For codegent, make WebRTC DataChannel the v0.3 LAN-direct spike with
E2E relay signaling and WSS fallback; keep one encrypted application protocol above both
transports. Do not block core relay shipping on direct-path success, and do not attempt to
reuse a secretstream state while changing transport—start a new authenticated connection
epoch and resume by application sequence.
