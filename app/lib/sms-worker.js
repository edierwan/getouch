/**
 * SMS Gateway — Background Worker
 *
 * Polls sms_outbound_messages for queued messages, locks them,
 * picks a device using routing rules, sends via android-sms-gateway,
 * and updates message status + timeline.
 *
 * Runs as part of the same process but in a background setInterval loop.
 * Worker health is exposed via sms_worker_health table.
 */

const {
  getQueuedMessages,
  markMessageSent,
  markMessageFailed,
  pickDevice,
  updateWorkerHealth,
  markWorkerStopped,
  markStaleDevicesOffline,
  getHealthMetrics,
} = require('./sms-db');

const { adapter, fireWebhooksForEvent } = require('./sms-android-adapter');

let workerTimer = null;
let staleDeviceTimer = null;
let isProcessing = false;
const POLL_INTERVAL = process.env.SMS_WORKER_POLL_MS ? parseInt(process.env.SMS_WORKER_POLL_MS) : 5000;
const BATCH_SIZE = process.env.SMS_WORKER_BATCH_SIZE ? parseInt(process.env.SMS_WORKER_BATCH_SIZE) : 5;

/**
 * Process a single message: pick device, send, update status
 */
async function processMessage(msg) {
  const requestId = `wrk_${Date.now()}_${msg.id.substring(0, 8)}`;

  try {
    // 1. Pick a device
    const device = await pickDevice(msg.tenant_id, msg.sender_device_id);
    if (!device) {
      console.warn(`[sms-worker] ${requestId} No online device for message ${msg.id}`);
      await markMessageFailed(msg.id, 'No online device available', 'NO_DEVICE', false);
      return;
    }

    console.log(`[sms-worker] ${requestId} Sending msg=${msg.id} via device=${device.name} to=${msg.to_number}`);

    // 2. Send via android-sms-gateway adapter
    const result = await adapter.sendSms({
      to: msg.to_number,
      message: msg.message_body,
      deviceId: device.id,
    });

    // 3. Mark as sent
    await markMessageSent(msg.id, result.id || result.correlationId, device.id);
    console.log(`[sms-worker] ${requestId} Sent: msg=${msg.id} ext=${result.id}`);

    // 4. Fire webhooks (fire-and-forget)
    fireWebhooksForEvent(msg.tenant_id, 'sms.sent', {
      message_id: msg.id,
      to: msg.to_number,
      device_id: device.id,
      external_id: result.id,
    }).catch(() => {});

    return true;
  } catch (err) {
    console.error(`[sms-worker] ${requestId} Error processing msg=${msg.id}:`, err.message);

    const isPermanent = err.code === 'INVALID_NUMBER' || err.status === 400;
    const errorCode = err.code || 'SEND_ERROR';

    await markMessageFailed(msg.id, err.message, errorCode, isPermanent);

    if (isPermanent) {
      // Fire failure webhook
      fireWebhooksForEvent(msg.tenant_id, 'sms.failed', {
        message_id: msg.id,
        to: msg.to_number,
        error: err.message,
        error_code: errorCode,
      }).catch(() => {});
    }

    return false;
  }
}

/**
 * Main worker loop: poll and process queued messages
 */
async function pollAndProcess() {
  if (isProcessing) return; // Skip if still processing previous batch
  isProcessing = true;

  try {
    const messages = await getQueuedMessages(BATCH_SIZE);

    if (messages.length > 0) {
      console.log(`[sms-worker] Processing ${messages.length} queued message(s)`);

      const results = await Promise.allSettled(
        messages.map(msg => processMessage(msg))
      );

      const succeeded = results.filter(r => r.status === 'fulfilled' && r.value).length;
      await updateWorkerHealth(succeeded);
    } else {
      // Still update heartbeat even with no messages
      await updateWorkerHealth(0);
    }
  } catch (err) {
    console.error('[sms-worker] Poll error:', err.message);
  } finally {
    isProcessing = false;
  }
}

/**
 * Mark stale devices offline (devices that haven't sent heartbeat)
 */
async function cleanupStaleDevices() {
  try {
    const stale = await markStaleDevicesOffline(120000); // 2 minutes threshold
    if (stale.length > 0) {
      console.log(`[sms-worker] Marked ${stale.length} device(s) as offline:`, stale.map(d => d.name).join(', '));
    }
  } catch (err) {
    console.error('[sms-worker] Stale device cleanup error:', err.message);
  }
}

/**
 * Start the SMS worker
 */
function startWorker() {
  if (workerTimer) {
    console.log('[sms-worker] Worker already running');
    return;
  }

  console.log(`[sms-worker] Starting worker (poll: ${POLL_INTERVAL}ms, batch: ${BATCH_SIZE})`);

  // Initial run
  pollAndProcess();
  cleanupStaleDevices();

  // Set up intervals
  workerTimer = setInterval(pollAndProcess, POLL_INTERVAL);
  staleDeviceTimer = setInterval(cleanupStaleDevices, 60000); // Every minute

  // Update worker health to running
  updateWorkerHealth(0).catch(() => {});
}

/**
 * Stop the SMS worker
 */
function stopWorker() {
  if (workerTimer) {
    clearInterval(workerTimer);
    workerTimer = null;
  }
  if (staleDeviceTimer) {
    clearInterval(staleDeviceTimer);
    staleDeviceTimer = null;
  }

  markWorkerStopped().catch(() => {});
  console.log('[sms-worker] Worker stopped');
}

/**
 * Get worker status for health endpoint
 */
async function getWorkerStatus() {
  return getHealthMetrics();
}

module.exports = {
  startWorker,
  stopWorker,
  getWorkerStatus,
  pollAndProcess,
};
