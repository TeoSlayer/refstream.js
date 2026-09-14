# Refstream.js

A standalone JavaScript terminal emulator. Refstream owns the VT parser, screen
buffers, Unicode cells, input protocols and virtualized browser renderer. Use
`Terminal` wherever your application needs to render a shell or terminal process.
It has **zero runtime dependencies** and does not use xterm.js to render.

The optional `refstream.js/files` module adds backed file references and WebRTC
streams. It is an extension to Refstream's terminal, not the main library.

## Use in a browser

Download the compiled JavaScript and CSS from
[Releases](https://github.com/TeoSlayer/refstream.js/releases), or build with
`npm ci && npm run build`. Serve the browser files on any static host. Keep the
`chunks/` directory alongside the JavaScript files.
Consumers need only JavaScript and CSS, with no framework, Node.js or build step.

```html
<link rel="stylesheet" href="/sdk/refstream.css">
<div id="terminal" style="height:400px"></div>
<script type="module">
  import { Terminal } from '/sdk/refstream.js';

  const terminal = new Terminal({ theme: 'midnight', fontSize: 14 });
  terminal.open(document.querySelector('#terminal'));
  terminal.fit();
  terminal.write('Hello, \x1b[32mworld\x1b[0m!\r\n');
</script>
```

For classic script tags, load `refstream.global.js` and use
`new Refstream.Terminal(options)`. The browser modules and global are built from
the same terminal engine.

## Replace xterm in an application

The main API follows familiar terminal conventions: `new Terminal(options)`,
`open`, `write`, `onData`, `onBinary`, `onResize`, `resize`, `focus`, selection,
scrolling and `dispose`. Refstream also includes `fit()` directly.

```js
import { Terminal } from 'refstream.js';
import 'refstream.js/style.css';

const terminal = new Terminal({ cols: 80, rows: 24, scrollback: 10_000 });
terminal.open(container);

// Keep your application's authenticated PTY transport.
const input = terminal.onData(data => transport.send(new TextEncoder().encode(data)));
const binary = terminal.onBinary(data => transport.send(
  Uint8Array.from(data, character => character.charCodeAt(0)),
));
const resize = terminal.onResize(({ cols, rows }) => transport.resize(cols, rows));
transport.onOutput(bytes => terminal.write(bytes));

const observer = new ResizeObserver(() => terminal.fit());
observer.observe(container);
terminal.fit();
terminal.focus();

// On unmount, also detach your transport's output listener.
function dispose() {
  observer.disconnect();
  input.dispose(); binary.dispose(); resize.dispose();
  terminal.dispose();
}
```

`container` and `transport` above belong to your application. Like other terminal
emulators, Refstream displays terminal output and emits input; your PTY or browser
runtime executes commands. Refstream does not install a server or choose one.

**Version 0.1 alpha:** the terminal works independently of xterm. Compatibility
with every xterm escape sequence and addon is not complete. Applications using
xterm addons or private APIs need to adapt them; this is not binary compatibility
with its addon ecosystem. The package includes xterm only as a development test
dependency to compare terminal behavior.

The npm package name is `refstream.js`; it is not published on npm yet. The build
ships browser JavaScript, ESM, CommonJS, TypeScript declarations, CSS and source
maps. `npm pack` produces a self-contained npm distribution without install hooks.

## Terminal features

- Normal and alternate screen buffers, bounded scrollback, resize and reflow,
  cursor movement, colors and text attributes, scrolling regions and tab stops.
- Streaming UTF-8, wide characters and combining sequences; keyboard input,
  IME composition, bracketed paste, selection, mouse reporting and touch input.
- Virtualized DOM rows, native scrolling, batched painting, eight built-in themes
  and runtime appearance options.
- Command markers, searchable output, session snapshots and recording/replay.
- HTTP(S) links and opt-in file previews with a host-provided source of bytes.

`write()` updates the model synchronously and batches painting into an animation
frame. Its callback runs after parsing, not after display refresh. Use `onRender`
to observe rendering. Chunk large output streams and yield between writes to
keep browser input responsive.

## State, search and replay

```js
import { TerminalSession, findInTerminal, terminalTranscript } from 'refstream.js';

const session = new TerminalSession(terminal);
const snapshot = session.snapshot();
session.restore(snapshot);

const matches = findInTerminal(terminal.buffer.active, terminal.cols, 'error');
const text = terminalTranscript(terminal.buffer.active);
const commands = session.read().commands;
// session.dispose() when the session ends.
```

Snapshots retain the parser state, buffers, cursor, modes, command records and
agent handoffs, including their retained answers and logical session identity.
They contain terminal output and should be protected like the underlying session.
`TerminalRecorder` and `replayRecording` record and replay output and resize events.
The optional Bash/Zsh scripts in `shell-integration/` emit OSC 133 command markers
for exit status and command timing; arbitrary plain output cannot supply reliable
command boundaries on its own.

## Agent handoffs

The optional Agent panel creates a private invitation an agent can use with its
ordinary command tool. A connection can be reused across requests. Handoffs have
stable task IDs, draft protection, bounded waits and retained results. Collecting
an answer leaves the connection open; stopping the connector refuses to abandon
uncollected work. The browser owner can revoke access immediately.

Completion comes from shell markers, a host callback, or an explicitly labelled
observation by the visiting agent. Quiet output alone is never completion.
Host integrations can report actual composer contents as empty, placeholder,
suggestion or draft, and expose authentication, working and answer-ready states.
Unintegrated applications retain an explicit unknown state and bounded visual
evidence; terminal colors never authorize input on their own.
See [persistent sessions and agent APIs](docs/agents.md) for usage, host hooks,
retention limits and the distinction between terminal state and a live backend
process.

## Optional interface

```js
import { attachTerminalTools } from 'refstream.js/ui';
import 'refstream.js/ui/style.css';

const tools = await attachTerminalTools({
  terminal, toolbar, overlay, frame,
  ui: {
    toolbar: ['search', 'menu'],
    themes: ['midnight', 'paper', 'shell'],
    labels: { search: 'Find' },
  },
});
// tools.dispose() when removing the interface.
```

Supply your own elements for `toolbar`, `overlay` and `frame`. Controls, menu
items, labels, themes and file-preview rendering are configurable. The engine
does not require this UI module. Custom colors can be set through
`terminal.options.theme`; named themes are exported by `refstream.js/themes`.

## Optional backed files

```js
import { FileRegistry, fileLinks } from 'refstream.js/files';

const files = new FileRegistry();
files.add('reports/build.txt', { body: 'Build passed.\n' });
terminal.options.fileLinks = fileLinks(files);
terminal.write('reports/build.txt\r\n');
// files.dispose() when access ends.
```

Only explicitly backed paths become file links. Hover/focus previews the file;
Download resolves it again so the host can reauthorize the read. Sources can be
strings, Blobs, URLs or lazy streams, including authenticated peer-to-peer streams.
See the [file API](docs/files.md) for WebRTC signaling, limits and authorization.

Detection alone never fetches a path. URL access is opt-in, with exact origin
allowlists, no ambient credentials and no redirects. Active documents are not
executed in previews. Preview bytes and resolved URLs are excluded from terminal
snapshots and recordings. The host still owns authorization for every resource.

## Modules and validation

| Module | Purpose |
| --- | --- |
| `refstream.js` | Terminal renderer, sessions, commands, input and recording |
| `refstream.js/core` | Headless VT parser and screen buffers |
| `refstream.js/search` | Buffer search and transcript helpers |
| `refstream.js/themes` | Built-in themes and theme resolution |
| `refstream.js/ui` | Optional terminal controls |
| `refstream.js/files` | Optional backed references and WebRTC streams |
| `refstream.js/relay` | Optional agent relay configuration |

`npm run check` builds, runs unit/conformance tests and verifies the packed library
in isolated ESM, CommonJS and TypeScript consumers with no xterm installed.
`npm run test:browser` exercises Chromium, Firefox and WebKit, plus Android and iOS
viewport/touch profiles. Mobile profiles are emulation, not physical-device tests.
Local peer tests use direct host ICE candidates; internet NAT traversal and your
signaling/TURN infrastructure require separate deployment checks.

Importing the library starts no network requests, storage or telemetry. Agent
connections and peer connections are explicit, optional operations. Report
security issues through [private vulnerability reporting](https://github.com/TeoSlayer/refstream.js/security/advisories/new).

MIT licensed.
