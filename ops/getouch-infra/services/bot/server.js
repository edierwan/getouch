const http = require('http');

const PORT = process.env.PORT || 3000;
const VERSION = process.env.VERSION || '1.0.0';
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'ollama';
const OLLAMA_PORT = process.env.OLLAMA_PORT || '11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:7b';

function ollamaRequest(prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: OLLAMA_MODEL,
      prompt,
      stream: false
    });

    const req = http.request({
      hostname: OLLAMA_HOST,
      port: parseInt(OLLAMA_PORT),
      path: '/api/generate',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: 60000
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('Invalid JSON from Ollama: ' + data.slice(0, 200)));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Ollama request timeout')); });
    req.write(body);
    req.end();
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => data += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(data)); }
      catch { resolve({ message: data }); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  // CORS headers
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
      service: 'bot',
      status: 'ok',
      version: VERSION,
      model: OLLAMA_MODEL,
      timestamp: new Date().toISOString()
    }));
  }

  if (req.url === '/chat' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const prompt = body.message || body.prompt || 'Hello';

      console.log(`[bot] /chat prompt: "${prompt.slice(0, 100)}"`);
      const result = await ollamaRequest(prompt);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        response: result.response,
        model: result.model,
        total_duration_ms: Math.round((result.total_duration || 0) / 1e6),
        timestamp: new Date().toISOString()
      }));
    } catch (err) {
      console.error('[bot] /chat error:', err.message);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        error: 'LLM request failed',
        detail: err.message
      }));
    }
  }

  if (req.url === '/chat' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      usage: 'POST /chat with {"message": "your prompt"}',
      model: OLLAMA_MODEL
    }));
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[bot] listening on port ${PORT}, model: ${OLLAMA_MODEL}`);
});
