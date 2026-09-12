import { Terminal, TerminalSession } from '../../dist/browser/refstream.js';
import { attachTerminalTools } from '../../dist/browser/ui.js';

const terminal = new Terminal({ fontSize: 16, theme: 'paper' });
terminal.open(document.querySelector('#terminal'));
terminal.fit();
const session = new TerminalSession(terminal);
const tools = await attachTerminalTools({
  terminal, session,
  toolbar: document.querySelector('#toolbar'), overlay: document.querySelector('#overlay'), frame: document.querySelector('#frame'),
  ui: { initialAgentPermission: 'control' },
});
const input = [];
terminal.onData(data => input.push(data));
terminal.write('Browser modules: \x1b[32mready\x1b[0m 世界\r\n');
window.distribution = { terminal, session, tools, input };
