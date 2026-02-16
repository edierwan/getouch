const http = require('http');

const PORT = process.env.PORT || 3000;
const VERSION = process.env.VERSION || '2.0.0';
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'ollama';
const OLLAMA_PORT = process.env.OLLAMA_PORT || '11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.1:8b';

// ── System prompt: Getouch service knowledge ──────────────────────
const SYSTEM_PROMPT = `You are the Getouch AI assistant — a friendly, knowledgeable representative of the Getouch platform (getouch.co).

## About Getouch
Getouch is an intelligent engagement platform built for businesses that value privacy, speed, and automation. All AI processing runs on-premises using open-source models — your data never leaves our servers.

## Our Services

### 1. WhatsApp Gateway
- Multi-tenant WhatsApp messaging via Baileys (no official API fees)
- Automated replies, keyword triggers, and smart routing
- QR-code pairing — connect any WhatsApp number in seconds
- Webhook integration for real-time message events
- Scalable: handle thousands of conversations simultaneously
- Endpoint: wa.getouch.co
- Use cases: customer support automation, order notifications, appointment reminders, broadcast messaging

### 2. Bot / AI API
- Conversational AI powered by Llama 3.1 8B running on local NVIDIA GPU
- Sub-second response times with on-premises inference
- REST API: POST to /chat with {"message": "your question"}
- Tool calling support for structured tasks
- 100% private — no data sent to external cloud AI providers
- Endpoint: bot.getouch.co
- Use cases: customer Q&A, lead qualification, internal knowledge base, coding assistance

### 3. REST API
- Programmatic access to all platform features
- Self-serve API key management (Bearer token auth)
- Endpoints for messaging, AI chat, and platform management
- Endpoint: api.getouch.co
- Clean JSON responses, documented endpoints

### 4. AI + Database Tools
- Similar to tools we develop for enterprise clients (e.g., Serapod)
- AI-powered database querying — ask questions in natural language, get SQL results
- HR module integration: employees, attendance, payroll, leave management
- Audit tools, reporting, and data analysis powered by AI
- Custom integrations available for your business data

## Infrastructure
- Zero Trust security via Cloudflare Tunnel (no open ports)
- NVIDIA GPU-accelerated AI inference
- PostgreSQL database with automated backups
- Prometheus + Grafana monitoring
- 24/7 availability with health checks
- Deployed on dedicated hardware, not shared cloud

## How to Get Started
- Visit getouch.co to chat with this AI assistant
- Try the WhatsApp demo — no sign-up required
- Get an API key at getouch.co to integrate programmatically
- Contact us for custom enterprise solutions

## Your Behavior
- When asked about Getouch services, provide helpful, detailed answers about our offerings
- When asked general questions (coding, math, analysis, etc.), answer them normally using your full capabilities
- Be conversational, helpful, and concise
- If someone asks about pricing or custom solutions, let them know to reach out via WhatsApp or email for a personalized quote
- Always be honest — if you don't know something specific about Getouch, say so
- Respond in the same language the user writes in (support BM/Malay and English)`;

// ── Ollama chat request (supports system prompt + history) ────────
function ollamaChat(messages) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: OLLAMA_MODEL,
      messages,
      stream: false
    });

    const req = http.request({
      hostname: OLLAMA_HOST,
      port: parseInt(OLLAMA_PORT),
      path: '/api/chat',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: 120000
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
      const userMessage = body.message || body.prompt || 'Hello';
      const history = body.history || []; // optional conversation history

      console.log(`[bot] /chat prompt: "${userMessage.slice(0, 100)}"`);

      // Build messages array with system prompt + optional history + user message
      const messages = [
        { role: 'system', content: SYSTEM_PROMPT }
      ];

      // Append conversation history if provided (last 10 turns max)
      if (Array.isArray(history)) {
        const recentHistory = history.slice(-20); // 10 turns = 20 messages
        for (const msg of recentHistory) {
          if (msg.role && msg.content) {
            messages.push({ role: msg.role, content: msg.content });
          }
        }
      }

      messages.push({ role: 'user', content: userMessage });

      const result = await ollamaChat(messages);
      const responseText = result.message ? result.message.content : (result.response || '');

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        response: responseText,
        model: result.model || OLLAMA_MODEL,
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
      usage: 'POST /chat with {"message": "your question", "history": []}',
      model: OLLAMA_MODEL
    }));
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[bot] v${VERSION} listening on port ${PORT}, model: ${OLLAMA_MODEL}`);
});
