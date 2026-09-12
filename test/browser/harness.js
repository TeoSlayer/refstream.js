import * as library from '../../dist/index.js';

const terminal = new library.Terminal({ cols: 40, rows: 8, fontSize: 16, lineHeight: 1, scrollback: 1000 });
const fixture = { terminal, library, input: [], binary: [], sizes: [], copies: [], titles: [], commands: [] };
window.fixture = fixture;
terminal.onData(data => fixture.input.push(data));
terminal.onBinary(data => fixture.binary.push(data));
terminal.onResize(size => fixture.sizes.push(size));
terminal.onTitleChange(title => fixture.titles.push(title));
terminal.onCommand(marker => fixture.commands.push(marker));
terminal.open(document.querySelector('#terminal'));
terminal.fit();
document.fonts?.ready.then(() => terminal.fit());
document.querySelector('#focus').addEventListener('click', () => terminal.focus());
document.addEventListener('copy', event => fixture.copies.push(event.clipboardData.getData('text/plain')));
document.querySelector('#status').textContent = 'Ready';
