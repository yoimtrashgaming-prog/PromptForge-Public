// A port a test server can actually listen on.
//
// The suites used fixed ports, so anything else on the machine holding one
// (4 Oct 2026: another session's `python -m http.server 8095`) failed the
// suite with "server did not start" while the code under test was fine.
// The preferred port is still used when it is free, so logs and habits stay
// the same; when it is taken, the OS picks one.

import net from 'node:net';

const tryListen = (port) =>
  new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(null));
    srv.listen(port, '127.0.0.1', () => {
      const got = srv.address().port;
      srv.close(() => resolve(got));
    });
  });

export async function freePort(preferred) {
  return (await tryListen(preferred)) ?? (await tryListen(0));
}
