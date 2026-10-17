// Fake Eero cloud API for verification. Usage: node mock-eero.mjs [port]
// GET /__state returns device flags plus every API request received, so a run can prove side effects.
import http from 'node:http';

const port = Number(process.argv[2] || 8787);
const NET = '1001';
const dev = (mac, name, ip, o = {}) => ({
  mac, nickname: name, display_name: name, hostname: name, connected: true, paused: false,
  blacklisted: false, ip, manufacturer: 'Mock Co', connection_type: 'wireless', ...o,
});
const devices = [
  dev('aa:00:00:00:00:01', 'Test Laptop', '192.168.9.11'),
  dev('aa:00:00:00:00:02', 'Test Phone', '192.168.9.12'),
  dev('aa:00:00:00:00:03', 'Test Console', '192.168.9.13', { connection_type: 'wired' }),
  dev('aa:00:00:00:00:04', 'Old Tablet', '192.168.9.14', { connected: false }),
];
const log = [];
const find = (mac) => devices.find((d) => d.mac === mac);
const send = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

http
  .createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const p = new URL(req.url, 'http://x').pathname;
      if (p === '/__state') {
        return send(res, 200, { devices: devices.map(({ mac, paused, blacklisted }) => ({ mac, paused, blacklisted })), log });
      }
      log.push({ t: new Date().toISOString(), method: req.method, path: p, body: raw });

      if (req.method === 'POST' && p === '/2.2/login') return send(res, 200, { data: { user_token: 'mock-token' } });
      if (req.method === 'POST' && p === '/2.2/login/verify') {
        return new URLSearchParams(raw).get('code') === '123456'
          ? send(res, 200, { data: {} })
          : send(res, 400, { meta: { error: 'invalid code' } });
      }
      if (req.method === 'GET' && p === '/2.2/networks') return send(res, 200, { data: [{ url: `/2.2/networks/${NET}` }] });
      if (req.method === 'GET' && p === `/2.2/networks/${NET}/devices`) return send(res, 200, { data: devices });

      let m = p.match(new RegExp(`^/2\\.3/networks/${NET}/devices/([0-9a-f:]+)$`));
      if (req.method === 'PUT' && m && find(m[1])) {
        find(m[1]).paused = JSON.parse(raw).paused === true;
        return send(res, 200, { data: {} });
      }
      if (req.method === 'POST' && p === `/2.2/networks/${NET}/blacklist`) {
        const d = find(new URLSearchParams(raw).get('mac'));
        if (d) d.blacklisted = true;
        return send(res, 200, { data: {} });
      }
      m = p.match(new RegExp(`^/2\\.2/networks/${NET}/blacklist/([0-9a-f:]+)$`));
      if (req.method === 'DELETE' && m && find(m[1])) {
        find(m[1]).blacklisted = false;
        return send(res, 200, { data: {} });
      }
      send(res, 404, { meta: { error: `mock has no ${req.method} ${p}` } });
    });
  })
  .listen(port, '127.0.0.1', () => console.log(`mock eero on ${port}`));
