# Optional file streams

A small, independent JavaScript library for file references backed by **Web Streams, Blobs, explicit URLs, or WebRTC peer-to-peer streams**. Use it with Shell Terminal or your own interface. No UI framework, runtime dependencies, telemetry, automatic network connections, or filesystem access.

This is an alpha library. Browser JavaScript and npm distribution formats are built and tested here; the npm package has not been published yet.

## Load JavaScript

Copy `dist/browser/` to your static host. The ES module is self-contained:

```js
import { FileRegistry, fileLinks, createFilePeer } from '/vendor/refstream/files.js';
```

Or load `files.global.js` with a regular script tag and use `window.RefstreamFiles`. No bundler or installer is required. Serve JavaScript with its correct MIME type; permit cross-origin module loading only if needed. Run `npm ci && npm run build` to produce the browser files. Keep the MIT license with them.

For npm/bundler use after publication:

```sh
npm install refstream.js
```

```js
import { FileRegistry, fileLinks, createFilePeer } from 'refstream.js/files';
```

## Register actual sources

Only explicit registrations can become file links. Detection and `has()` are local lookups; they never open a stream or fetch a URL.

```js
const files = new FileRegistry({
  allowedOrigins: ['https://files.example.com'],
});

files.add('README.md', { body: '# Project notes\n' });
files.add('report.pdf', { body: reportBlob, mimeType: 'application/pdf' });
files.add('build.log', {
  mimeType: 'text/plain',
  // Return a fresh ReadableStream<Uint8Array> each time.
  stream: ({ signal, purpose }) => openAuthorizedLogStream({ signal, purpose }),
});
const registration = files.add('plots/results.png', {
  url: 'https://files.example.com/opaque-file-id',
  mimeType: 'image/png',
  preview: { body: thumbnailBlob },
  // Check permissions again for every preview and download.
  authorize: ({ purpose }) => sessionMayReadFile('opaque-file-id', purpose),
});

// Withdrawal removes detection and cancels active reads.
registration.dispose();
// On application/session teardown:
files.dispose();
```

Supply exactly one backing per file (and per optional preview): a string/Blob `body`, a `stream` factory, or an absolute HTTP(S) `url`. A preview can be a smaller image, a text excerpt or another supported file. Without a separate preview, previews read the normal backing under their own byte limit.

URL sources require an exact origin allowlist and are fetched without cookies, credentials, referrers, redirects, or caching. For authenticated HTTP endpoints, supply your own stream factory that authorizes the user, session and file on every request. **Never construct a fetch URL or filesystem path from detected text.** Register the mapping from a trusted application catalog.

## Connect a terminal or your own UI

```js
// An existing Shell Terminal instance:
terminal.options.fileLinks = {
  ...fileLinks(files),
  hoverDelayMs: 300,
  ui: { actions: ['download', 'close'] },
};
```

The adapter supplies local availability, resolution and change events. Adding or withdrawing a source updates links automatically; a revoked preview closes. Only registered paths link. The terminal owns its customizable preview/download UI; this library owns the file sources.

For another interface:

```js
import { detectFiles } from '/vendor/refstream/files.js';

const matches = detectFiles('Created plots/results.png and README.md:4', files);
// Each match has start/end UTF-16 offsets, text, file metadata, and optional line/column.

const abort = new AbortController();
const file = await files.resolve('README.md', {
  purpose: 'download',
  signal: abort.signal,
});
if (file) await file.body.pipeTo(yourWritableStream);
// Or consume with new Response(file.body).text()/blob() for bounded small files.
// AbortSignal or file.body.cancel() cancels the upstream read.
```

Render names and text as text, not HTML. `detectFiles()` matches only explicitly registered references, including filenames with spaces and `:line:column`, `#LlineCcolumn`, or `(line,column)` suffixes. It bounds work to 8,192 UTF-16 code units, 256 registered files and 32 results. It does not discover files or grant permission. `list()` exposes display references and metadata, never backing URLs or file contents.

## Peer-to-peer streams

File bytes travel over an encrypted WebRTC data channel. Your application authenticates the two peers and exchanges the offer and answer through its existing HTTPS/WebSocket signaling. No signaling service, STUN server or TURN server is hardcoded into the library.

On the computer/browser sharing files:

```js
const sender = createFilePeer({
  files: filesForThisAuthorizedViewer,
  rtcConfiguration: yourRtcConfiguration,
});
try {
  const offer = await sender.createOffer();
  // Host-defined request: deliver only to the authorized viewer.
  const answer = await authenticatedSignaling.exchangeOffer(offer);
  await sender.acceptAnswer(answer);
  await sender.ready;
} catch (error) {
  sender.dispose();
  throw error;
}
```

On the viewing page:

```js
const viewer = createFilePeer({ rtcConfiguration: yourRtcConfiguration });
try {
  const answer = await viewer.acceptOffer(offerFromAuthenticatedSender);
  await authenticatedSignaling.sendAnswer(answer);
  await viewer.ready;
  terminal.options.fileLinks = fileLinks(viewer);
} catch (error) {
  viewer.dispose();
  throw error;
}

// On disconnect/unmount: viewer.dispose(); sender.dispose();
```

Each peer advertises only its explicitly supplied registry. Create a separate scoped registry when viewers have different permissions. The receiving peer resolves detected references locally against that catalog, then requests the registered opaque file ID. Backing URLs, authentication credentials and unregistered paths never enter the file protocol. `authorize` still runs on the sender for every preview/download.

Offer/answer exchange is **application code**, not a built-in agent tool. Bind signaling to authenticated users and sessions, and do not log or publicly expose descriptions; connection descriptions can contain network addresses. WebRTC encrypts transport but does not replace your application’s authorization. For internet use, explicitly configure your own STUN/TURN infrastructure; some networks require TURN, which relays encrypted traffic. The empty default supports direct connectivity where available. Failed connections fail explicitly; the library never silently uploads a file or falls back to a URL.

If your app already has WebRTC, use `new FileChannel(dataChannel, { files })`. Create the channel with `{ ordered: true, protocol: FILE_CHANNEL_PROTOCOL }` and default reliability. Both endpoints must attach a `FileChannel` before exchanging traffic.

## Bounds and lifecycle

| Option | Registry default | Peer/channel default |
| --- | --- | --- |
| `maxPreviewBytes` | 16 MiB | 16 MiB |
| `maxDownloadBytes` | 128 MiB | 128 MiB |
| `timeoutMs` | 60 seconds idle | 30 seconds idle |
| Concurrency | `maxConcurrentReads: 8` | `maxConcurrentTransfers: 4` in each direction |
| Catalog size | `maxFiles: 256` | 256 shared files |
| `connectionTimeoutMs` | — | 30 seconds, including signaling |

Preview limits can be configured up to 128 MiB; download limits up to 1 GiB. Actual streamed bytes enforce the cap regardless of size metadata. Stream factories should emit moderate chunks; the sender retains at most one upstream chunk per transfer and sends one binary message (at most 16 KiB) for each consumer credit. Readers that stop consuming must cancel the stream, or the idle timeout will release it. Slow consumers never create an unbounded output queue.

Registry disposal withdraws sources and aborts active reads. Peer/channel disposal cancels transfers and closes its connection; it does not dispose an application-owned registry. Connection loss fails outstanding reads. Reconnection and retry require a new peer and freshly authorized stream; there is no silent resume or persistent storage. `FileAccessError.code` reports `UNAVAILABLE`, `DENIED`, `LIMIT`, `ABORTED`, `TIMEOUT`, `DISCONNECTED`, or `PROTOCOL`, without exposing source exception details.

The library uses standard Web Streams, `fetch`, AbortController and WebRTC data channels. Serve peer connections from HTTPS or localhost. Automated browser tests exercise Chromium, Firefox, WebKit and mobile browser profiles; physical devices, internet NAT traversal and your own TURN infrastructure need deployment-specific verification.

## Build and verify

```sh
npm ci
npm run build
npm test
npm run test:package
```

Use Node.js 22 or newer for development. The package contains ESM, CommonJS, standalone browser JS and TypeScript declarations, with no runtime dependencies or install-time compilation. An isolated consumer test verifies the packaged artifacts without source files.

For real WebRTC and browser distribution tests:

```sh
npx playwright install chromium firefox webkit
npm run test:browser
```

Tests include Chromium, Firefox, WebKit, mobile browser profiles, and Chromium-to-Firefox/WebKit transfers. The file submodule is headless; the main Refstream.js module provides the terminal renderer. The browser fixture exercises its public API. Nothing is published to npm by these commands.

Build output belongs in `dist/`; it is not committed. CI verifies packaging on Linux, macOS and Windows, plus real browser transfers.

Keep stable version paths immutable. Self-host with any static server or CDN, correct JavaScript MIME types, `nosniff`, and explicit CORS policy. Return 404 for missing modules instead of an HTML application fallback. No worker or backend is required for file registries; P2P deployment needs your authenticated signaling and any configured ICE services.

Protocol references: [WebRTC data channels](https://www.w3.org/TR/webrtc/#rtcdatachannel), [Web Streams](https://streams.spec.whatwg.org/).

The optional file submodule has no dependency on the renderer, a hosted relay, or Cloudflare. The main [Refstream.js library](../README.md) provides the terminal emulator. Licensed under [MIT](../LICENSE).

Report vulnerabilities through [GitHub private vulnerability reporting](https://github.com/TeoSlayer/refstream.js/security/advisories/new). Do not include credentials or private file contents in public issues.
