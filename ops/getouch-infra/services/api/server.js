const http = require('http');

const PORT = process.env.PORT || 3000;
const VERSION = process.env.VERSION || '1.0.0';

const server = http.createServer((req, res) => {
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
      service: 'api',
      status: 'ok',
      version: VERSION,
      timestamp: new Date().toISOString()
    }));
  }

  if (req.url === '/version') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      service: 'api',
      version: VERSION,
      node: process.version,
      platform: process.platform,
      uptime: Math.round(process.uptime())
    }));
  }

  if (req.url === '/' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      service: 'getouch-api',
      version: VERSION,
      endpoints: [
        'GET  /health   — Health check',
        'GET  /version  — Version info',
      ],
      docs: 'Coming soon'
    }));
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[api] listening on port ${PORT}`);
});
