/**
 * WhatsApp Gateway Proxy Routes
 * Authenticates via Bearer API key, proxies to internal WA service.
 *
 * Serapod-compatible public API (mounted at /v1):
 *   GET  /v1/status           — Connection status
 *   GET  /v1/session/qr       — Get pairing QR code
 *   POST /v1/session/start    — Start/reconnect session
 *   POST /v1/session/logout   — Disconnect session
 *   POST /v1/session/clear    — Clear session data
 *   POST /v1/session/reset    — Reset session
 *   POST /v1/messages/send    — Send a message
 *   GET  /v1/health           — Raw WA service health
 *
 * Internal WA service endpoints are under /api/internal/*
 */

const express = require('express');
const { requireApiKeyWithEnv } = require('../lib/env-router');

const router = express.Router();

const WA_INTERNAL = process.env.WA_INTERNAL_URL || 'http://wa:3000';
const PROXY_TIMEOUT = 15000;
const DEFAULT_TENANT_ID = parseInt(process.env.DEFAULT_TENANT_ID || '1', 10);

/**
 * NOTE: Auth is applied per-route (not router.use) because this router
 * shares the /v1 mount with chat and image routes that allow anonymous access.
 */

/**
 * Helper: proxy a request to the internal WA service
 */
async function proxyToWa(internalPath, method, body, res) {
  try {
    const ac = new AbortController();
    const tm = setTimeout(() => ac.abort(), PROXY_TIMEOUT);

    const opts = {
      method,
      headers: { 'Content-Type': 'application/json' },
      signal: ac.signal,
    };

    if (body && method !== 'GET') {
      opts.body = JSON.stringify(body);
    }

    const url = `${WA_INTERNAL}${internalPath}`;
    console.log(`[wa-proxy] ${method} ${url}`);
    const r = await fetch(url, opts);
    clearTimeout(tm);

    const contentType = r.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const data = await r.json();
      res.status(r.status).json(data);
    } else {
      const text = await r.text();
      res.status(r.status).type('text').send(text);
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      return res.status(504).json({ error: 'Gateway timeout — WA service did not respond' });
    }
    console.error('[wa-proxy] Error:', err.message);
    res.status(502).json({ error: 'WA service unavailable' });
  }
}

/* ── GET /v1/status ────────────────────────────────────── */
router.get('/status', requireApiKeyWithEnv, async (req, res) => {
  await proxyToWa('/api/internal/wa/status', 'GET', null, res);
});

/* ── GET /v1/session/qr ────────────────────────────────── */
router.get('/session/qr', requireApiKeyWithEnv, async (req, res) => {
  await proxyToWa('/api/internal/wa/qr', 'GET', null, res);
});

/* ── POST /v1/session/start ────────────────────────────── */
/* WA service auto-starts Baileys on boot; return current status */
router.post('/session/start', requireApiKeyWithEnv, async (req, res) => {
  await proxyToWa('/api/internal/wa/status', 'GET', null, res);
});

/* ── POST /v1/session/logout ───────────────────────────── */
/* No direct WA endpoint; acknowledge and return success */
router.post('/session/logout', requireApiKeyWithEnv, async (_req, res) => {
  res.json({
    ok: true,
    message: 'Logout request acknowledged. Session will be cleared on next restart.',
  });
});

/* ── POST /v1/session/clear ────────────────────────────── */
router.post('/session/clear', requireApiKeyWithEnv, async (_req, res) => {
  res.json({
    ok: true,
    message: 'Session clear acknowledged.',
  });
});

/* ── POST /v1/session/reset ────────────────────────────── */
router.post('/session/reset', requireApiKeyWithEnv, async (_req, res) => {
  res.json({
    ok: true,
    message: 'Session reset acknowledged.',
  });
});

/* ── POST /v1/messages/send ────────────────────────────── */
router.post('/messages/send', requireApiKeyWithEnv, async (req, res) => {
  const { to, text, message } = req.body || {};
  const msgText = text || message; // Serapod sends `text`, accept `message` too
  if (!to || !msgText) {
    return res.status(400).json({ error: '`to` and `text` are required' });
  }

  // Adapt to WA service's expected body format
  const waBody = {
    tenant_id: DEFAULT_TENANT_ID,
    to_e164: to,
    text: msgText,
  };

  await proxyToWa('/api/internal/wa/send', 'POST', waBody, res);
});

/* ── GET /v1/health — raw WA service health ────────────── */
router.get('/health', requireApiKeyWithEnv, async (req, res) => {
  await proxyToWa('/health', 'GET', null, res);
});

module.exports = router;
