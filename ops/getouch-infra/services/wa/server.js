const http = require('http');

const PORT = process.env.PORT || 3000;
const VERSION = process.env.VERSION || '1.0.0';

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => data += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(data)); }
      catch { resolve({ raw: data }); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      service: 'wa',
      status: 'ok',
      version: VERSION,
      engine: 'baileys',
      timestamp: new Date().toISOString()
    }));
  }

  // Webhook receiver stub — will be connected to Baileys later
  if (req.url === '/webhook' && req.method === 'POST') {
    const body = await readBody(req);
    console.log('[wa] webhook received:', JSON.stringify(body).slice(0, 200));

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      status: 'received',
      timestamp: new Date().toISOString()
    }));
  }

  if (req.url === '/webhook' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      service: 'wa',
      webhook: 'active',
      usage: 'POST /webhook with message payload',
      engine: 'baileys (stub — not yet connected)'
    }));
  }

  // Status endpoint — will show Baileys connection status
  if (req.url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      connected: false,
      engine: 'baileys',
      note: 'Stub service — Baileys integration pending',
      timestamp: new Date().toISOString()
    }));
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[wa] listening on port ${PORT} (Baileys stub)`);
});
