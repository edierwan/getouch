/**
 * Android SMS Gateway — Adapter Module
 *
 * Integrates with android-sms-gateway API to:
 * - Register and authorize Android devices
 * - Send SMS via connected devices
 * - Receive inbound SMS + delivery callbacks
 * - Handle device heartbeats and errors
 *
 * Supports multiple devices concurrently with correlation IDs.
 */

const crypto = require('crypto');

/**
 * Android SMS Gateway adapter
 * Connects to the android-sms-gateway service running on the device/server
 */
class AndroidSmsAdapter {
  /**
   * @param {Object} opts
   * @param {string} opts.baseUrl - android-sms-gateway API base URL
   * @param {string} [opts.apiKey] - API key for gateway auth
   * @param {number} [opts.timeoutMs] - Request timeout (default: 15000)
   */
  constructor(opts = {}) {
    this.baseUrl = opts.baseUrl || process.env.ANDROID_SMS_GATEWAY_URL || 'http://localhost:8080';
    this.apiKey = opts.apiKey || process.env.ANDROID_SMS_GATEWAY_KEY || '';
    this.timeoutMs = opts.timeoutMs || 15000;
  }

  /**
   * Generate a correlation ID for request tracing
   */
  _correlationId() {
    return `sms_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  }

  /**
   * Make an authenticated request to the android-sms-gateway
   */
  async _request(method, path, body = null) {
    const correlationId = this._correlationId();
    const url = `${this.baseUrl}${path}`;

    const opts = {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Correlation-ID': correlationId,
      },
    };

    if (this.apiKey) {
      opts.headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    if (body && method !== 'GET') {
      opts.body = JSON.stringify(body);
    }

    const ac = new AbortController();
    const tm = setTimeout(() => ac.abort(), this.timeoutMs);
    opts.signal = ac.signal;

    console.log(`[sms-adapter] ${method} ${url} cid=${correlationId}`);

    try {
      const r = await fetch(url, opts);
      clearTimeout(tm);

      const contentType = r.headers.get('content-type') || '';
      let data;
      if (contentType.includes('application/json')) {
        data = await r.json();
      } else {
        data = await r.text();
      }

      if (!r.ok) {
        const error = new Error(`Gateway returned HTTP ${r.status}`);
        error.status = r.status;
        error.data = data;
        error.correlationId = correlationId;
        throw error;
      }

      return { data, correlationId, status: r.status };
    } catch (err) {
      clearTimeout(tm);

      if (err.name === 'AbortError') {
        const error = new Error('Gateway request timeout');
        error.code = 'TIMEOUT';
        error.correlationId = correlationId;
        throw error;
      }

      if (!err.correlationId) {
        err.correlationId = correlationId;
      }

      // Connection refused / network error
      if (err.cause?.code === 'ECONNREFUSED' || err.message?.includes('fetch failed')) {
        const error = new Error('Device offline or unreachable');
        error.code = 'DEVICE_OFFLINE';
        error.correlationId = correlationId;
        throw error;
      }

      throw err;
    }
  }

  /**
   * Check gateway health
   * @returns {Promise<{ok: boolean, version?: string}>}
   */
  async health() {
    try {
      const { data } = await this._request('GET', '/health');
      return { ok: true, version: data.version || null, data };
    } catch (err) {
      return { ok: false, error: err.message, code: err.code };
    }
  }

  /**
   * Send an SMS message through a specific device
   *
   * @param {Object} params
   * @param {string} params.to - Phone number in E.164 format
   * @param {string} params.message - Message body
   * @param {string} [params.deviceId] - Specific device to use
   * @param {string} [params.simSlot] - SIM slot (0 or 1)
   * @returns {Promise<{id: string, status: string, correlationId: string}>}
   */
  async sendSms({ to, message, deviceId, simSlot }) {
    const body = {
      phoneNumbers: [to],
      message: message,
    };

    if (deviceId) body.deviceId = deviceId;
    if (simSlot !== undefined) body.simNumber = parseInt(simSlot);

    const { data, correlationId } = await this._request('POST', '/message', body);

    return {
      id: data.id || data.messageId || null,
      status: data.state || data.status || 'pending',
      correlationId,
      raw: data,
    };
  }

  /**
   * Get message status/delivery receipt
   * @param {string} messageId - External message ID from gateway
   * @returns {Promise<Object>}
   */
  async getMessageStatus(messageId) {
    const { data, correlationId } = await this._request('GET', `/message/${messageId}`);
    return {
      id: data.id,
      status: data.state || data.status,
      recipients: data.recipients || [],
      correlationId,
      raw: data,
    };
  }

  /**
   * Register a new device with the gateway
   * @param {Object} params
   * @param {string} params.name - Device name
   * @param {string} [params.pushToken] - FCM push token
   * @returns {Promise<Object>}
   */
  async registerDevice({ name, pushToken }) {
    const body = { name };
    if (pushToken) body.pushToken = pushToken;

    const { data, correlationId } = await this._request('POST', '/device', body);
    return {
      deviceId: data.id || data.deviceId,
      token: data.token || data.loginToken,
      correlationId,
      raw: data,
    };
  }

  /**
   * Get list of connected devices
   * @returns {Promise<Array>}
   */
  async listDevices() {
    try {
      const { data } = await this._request('GET', '/device');
      return Array.isArray(data) ? data : (data.devices || []);
    } catch (err) {
      console.error('[sms-adapter] List devices error:', err.message);
      return [];
    }
  }

  /**
   * Get device info
   * @param {string} deviceId
   * @returns {Promise<Object|null>}
   */
  async getDevice(deviceId) {
    try {
      const { data } = await this._request('GET', `/device/${deviceId}`);
      return data;
    } catch {
      return null;
    }
  }

  /**
   * Delete/deregister a device
   * @param {string} deviceId
   */
  async deleteDevice(deviceId) {
    await this._request('DELETE', `/device/${deviceId}`);
  }
}

/**
 * Fire a webhook for an event, with HMAC signing
 *
 * @param {Object} webhook - Webhook config from DB
 * @param {Object} payload - Event payload
 */
async function fireWebhook(webhook, payload) {
  const body = JSON.stringify(payload);
  const signature = crypto
    .createHmac('sha256', webhook.signing_secret)
    .update(body)
    .digest('hex');

  const ac = new AbortController();
  const tm = setTimeout(() => ac.abort(), 10000);

  try {
    const r = await fetch(webhook.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Signature': `sha256=${signature}`,
        'X-Webhook-Event': payload.event,
        'X-Webhook-ID': crypto.randomUUID(),
      },
      body,
      signal: ac.signal,
    });
    clearTimeout(tm);

    // Update webhook last triggered
    const { smsQuery } = require('./sms-db');
    await smsQuery(
      `UPDATE sms_webhooks SET last_triggered = NOW(), last_status = $1 WHERE id = $2`,
      [r.status, webhook.id]
    ).catch(() => {});

    return { ok: r.ok, status: r.status };
  } catch (err) {
    clearTimeout(tm);
    console.error(`[sms-webhook] Fire failed for ${webhook.url}:`, err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Fire webhooks for a given event type across a tenant
 */
async function fireWebhooksForEvent(tenantId, eventType, payload) {
  const { getActiveWebhooks } = require('./sms-db');
  const webhooks = await getActiveWebhooks(tenantId, eventType);

  const results = await Promise.allSettled(
    webhooks.map(wh => fireWebhook(wh, { event: eventType, ...payload }))
  );

  return results;
}

// Singleton adapter instance
const adapter = new AndroidSmsAdapter();

module.exports = {
  AndroidSmsAdapter,
  adapter,
  fireWebhook,
  fireWebhooksForEvent,
};
