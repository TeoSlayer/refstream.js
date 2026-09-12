const terminal = new Refstream.Terminal({ fontSize: 16 });
terminal.open(document.querySelector('#terminal'));
terminal.fit();
terminal.write('Classic script: \x1b[32mready\x1b[0m 世界');
