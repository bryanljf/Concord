# jam-bot internal API (frozen contract)

The jam bot plays each room's jam into LiveKit. It is a dumb player: concord-api owns the
queues, the metadata and every decision; the bot only plays the file it is told to, in the room
it is told to, and reports when a song ends. It never talks to YouTube and never holds the
LiveKit secret (the api mints its tokens).

- Listens on `JAM_BOT_LISTEN` (default `127.0.0.1:3001`; loopback only in production).
- `JAM_BOT_TOKEN` (optional): when set, every request except `GET /healthz` must carry
  `Authorization: Bearer <JAM_BOT_TOKEN>`, else `401`. The api sends it when it has one.
- `JAM_CACHE_DIR` (default `../../infra/jam-cache`, the dev location next to the api's; production
  sets `/var/lib/concord-jam`): the only directory files may be read from. A `file` outside it
  (after cleaning the path; no symlink escapes) is rejected with `400 invalid_file`.
- `/jam-bot healthcheck` (subcommand): exits 0 when `GET /healthz` answers, for the Docker
  healthcheck (the image has no shell or curl).
- JSON bodies, `Content-Type: application/json`. Errors: `{ "error": "<code>", "message": "<text>" }`.

## Audio

Files are WebM (Matroska) with one Opus track, 48 kHz, 1 or 2 channels (YouTube itag 251). The
bot demuxes the Opus packets and sends them as they are (no decode, no re-encode) on one track
per room: identity and name from the token (`@jam` / `Jam`), track name `concord:music:jam`,
source Microphone, **stereo** (`TF_STEREO`), DTX off, paced in real time against an absolute
clock.

## Types

```ts
// idle: connected via /connect (track published, silent), nothing loaded yet; itemId ''.
type RoomState = 'idle' | 'playing' | 'paused' | 'ended' | 'error';

interface RoomStatus {
  room: string;
  itemId: string;
  state: RoomState;
  positionMs: number; // where playback is right now
  durationMs: number; // from the file (so far, while it is still growing)
  message?: string; // with state "error"
}
```

## Endpoints

| Method and path                 | Body                                                                            | Answer                                                                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `GET /healthz`                  | —                                                                               | `200 { "ok": true }`                                                                                                          |
| `POST /v1/probe`                | `{ "file": string, "partial"?: boolean }`                                       | `200 { "durationMs", "channels", "sampleRate", "codec": "opus" }` or `422 invalid_audio` (partial: header only, durationMs 0) |
| `POST /v1/rooms/{room}/connect` | `{ "livekitUrl", "token" }`                                                     | `200 RoomStatus` (`idle` if nothing loaded; idempotent; keeps playing if it is); `502 livekit_error`                          |
| `PUT /v1/rooms/{room}`          | `{ "livekitUrl", "token", "itemId", "file", "offsetMs", "paused", "growing"? }` | `200 RoomStatus` once publishing (connects first if needed); `422 invalid_audio`; `502 livekit_error`                         |
| `POST /v1/rooms/{room}/pause`   | —                                                                               | `200 RoomStatus`; `404 not_playing`                                                                                           |
| `POST /v1/rooms/{room}/resume`  | —                                                                               | `200 RoomStatus`; `404 not_playing`                                                                                           |
| `DELETE /v1/rooms/{room}`       | —                                                                               | `204` (stops, unpublishes, leaves the room; idempotent)                                                                       |
| `GET /v1/rooms`                 | —                                                                               | `200 { "rooms": RoomStatus[] }` (rooms the bot is in)                                                                         |
| `GET /v1/events`                | —                                                                               | Server-Sent Events, below                                                                                                     |
| `POST /v1/files/complete`       | `{ "file": string }`                                                            | `204`: a growing file is whole; rooms playing it go on to its real end                                                        |
| `POST /v1/files/failed`         | `{ "file": string }`                                                            | `204`: a growing file will never finish; rooms playing it stop with an `error` event                                          |

- `PUT /v1/rooms/{room}` replaces whatever the room was playing, without leaving the room or
  republishing the track when already connected. `offsetMs` skips the packets before it;
  `paused: true` loads the file and stays paused at `offsetMs`. The latest `token` is kept for
  reconnections (LiveKit also refreshes it while connected).
- `growing: true`: the file is still being written (the upload streams). At its current end the
  bot waits for more data (sending nothing, no event, position frozen) and resumes in real time
  when it arrives, until `POST /v1/files/complete` (then it plays to the real end and sends
  `ended`) or `POST /v1/files/failed` (`error`). 30 s without new data and no completion is an
  `error` too. `file` is the path given in the PUT (the api may rename it once complete; the bot
  keeps reading what it opened, and opens files so a rename/delete is allowed on Windows too).
  A completion that arrives before or between PUTs counts (kept per path for 10 minutes).
- `POST /v1/rooms/{room}/connect` joins and publishes the (silent) track ahead of the first song,
  so the LiveKit join overlaps the download; the api calls it when a song is queued in an idle room.
- Pause stops sending packets (resume continues from the same packet; no burst to catch up).
- The bot reconnects to LiveKit on its own after a network blip and resumes where it was.

## Events (`GET /v1/events`)

`data: <json>\n\n` per event, and a `: ping` comment every 15 s.

```ts
type BotEvent =
  | { type: 'ended'; room: string; itemId: string } // the file played to the end
  | { type: 'error'; room: string; itemId: string; message: string }; // gave up on this song
```

After an `ended` or `error` the bot stays in the room, silent, until the api sends the next
`PUT` or a `DELETE`. The api reconciles with `GET /v1/rooms` whenever it (re)connects to the
event stream, since events sent while it was away are lost.
