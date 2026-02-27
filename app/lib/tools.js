/**
 * Tool Layer — abstraction for external tool integrations
 *
 * Provides a registry of tools that can be called by the AI pipeline.
 * Currently implements stub/mock tools with admin toggles.
 *
 * Planned tools:
 *   - Order lookup
 *   - Points lookup
 *   - QR verify
 *   - DB read (strict allowlist)
 *
 * Each tool has:
 *   - id, name, description
 *   - schema (input parameters)
 *   - execute function
 *   - permissions (guest/registered/admin)
 *   - enabled flag (admin toggle)
 */

const { getSetting } = require('./settings');
const { logUsageEvent } = require('./usage');

/* ── Tool Registry ───────────────────────────────────────── */

const tools = new Map();

/**
 * Register a tool in the registry.
 */
function registerTool({ id, name, description, schema, permissions, execute }) {
  tools.set(id, { id, name, description, schema, permissions, execute, registeredAt: new Date() });
}

/**
 * Get a tool by ID.
 */
function getTool(id) {
  return tools.get(id) || null;
}

/**
 * List all registered tools (for admin UI).
 */
function listTools() {
  return Array.from(tools.values()).map(t => ({
    id: t.id,
    name: t.name,
    description: t.description,
    schema: t.schema,
    permissions: t.permissions,
  }));
}

/**
 * Execute a tool with audit logging.
 *
 * @param {string} toolId
 * @param {object} params - input parameters
 * @param {object} context - { visitorId, userId, environment }
 * @returns {Promise<{ success: boolean, result?: any, error?: string }>}
 */
async function executeTool(toolId, params, context = {}) {
  const tool = tools.get(toolId);
  if (!tool) {
    return { success: false, error: `Tool not found: ${toolId}` };
  }

  // Check if tool is enabled
  const toolEnabled = await getSetting(`tool.${toolId}.enabled`, false);
  if (toolEnabled !== true && toolEnabled !== 'true') {
    return { success: false, error: `Tool is disabled: ${toolId}` };
  }

  const startTime = Date.now();

  try {
    const result = await tool.execute(params, context);
    const durationMs = Date.now() - startTime;

    // Audit log
    logUsageEvent({
      visitorId: context.visitorId || 'system',
      userId: context.userId || null,
      eventType: 'tool_call',
      mode: toolId,
      status: 'ok',
      latencyMs: durationMs,
      environment: context.environment || 'prod',
      meta: { toolId, params: JSON.stringify(params).slice(0, 500), resultPreview: JSON.stringify(result).slice(0, 200) },
    });

    return { success: true, result };
  } catch (err) {
    const durationMs = Date.now() - startTime;

    logUsageEvent({
      visitorId: context.visitorId || 'system',
      userId: context.userId || null,
      eventType: 'tool_call',
      mode: toolId,
      status: 'error',
      latencyMs: durationMs,
      environment: context.environment || 'prod',
      meta: { toolId, error: err.message },
    });

    return { success: false, error: err.message };
  }
}

/* ── Register stub tools ─────────────────────────────────── */

registerTool({
  id: 'order_lookup',
  name: 'Order Lookup',
  description: 'Look up order status by order ID or customer reference',
  schema: {
    type: 'object',
    properties: {
      orderId: { type: 'string', description: 'Order ID to look up' },
      customerRef: { type: 'string', description: 'Customer reference number' },
    },
  },
  permissions: ['registered', 'admin'],
  execute: async (params) => {
    // STUB: Return mock data
    return {
      status: 'mock',
      message: 'Order lookup is not yet connected to a real backend.',
      orderId: params.orderId || 'N/A',
      mockData: { status: 'processing', estimatedDelivery: '3-5 business days' },
    };
  },
});

registerTool({
  id: 'points_lookup',
  name: 'Points Lookup',
  description: 'Check loyalty points balance for a customer',
  schema: {
    type: 'object',
    properties: {
      customerId: { type: 'string', description: 'Customer ID' },
      phone: { type: 'string', description: 'Phone number' },
    },
  },
  permissions: ['registered', 'admin'],
  execute: async (params) => {
    return {
      status: 'mock',
      message: 'Points lookup is not yet connected.',
      mockData: { points: 1250, tier: 'Gold', expiresAt: '2026-12-31' },
    };
  },
});

registerTool({
  id: 'qr_verify',
  name: 'QR Verify',
  description: 'Verify a QR code for authenticity',
  schema: {
    type: 'object',
    properties: {
      qrData: { type: 'string', description: 'QR code content' },
    },
  },
  permissions: ['guest', 'registered', 'admin'],
  execute: async (params) => {
    return {
      status: 'mock',
      message: 'QR verification is not yet connected.',
      mockData: { valid: true, productName: 'Sample Product' },
    };
  },
});

registerTool({
  id: 'db_read',
  name: 'DB Read',
  description: 'Execute a pre-approved read-only database query',
  schema: {
    type: 'object',
    properties: {
      queryName: { type: 'string', description: 'Name of the allowed query', enum: ['recent_orders', 'product_count', 'customer_summary'] },
      params: { type: 'object', description: 'Query parameters' },
    },
  },
  permissions: ['admin'],
  execute: async (params) => {
    return {
      status: 'mock',
      message: 'DB read tool is not yet connected. Only allowlisted queries would be permitted.',
      mockData: { rows: [], queryName: params.queryName },
    };
  },
});

module.exports = {
  registerTool,
  getTool,
  listTools,
  executeTool,
};
