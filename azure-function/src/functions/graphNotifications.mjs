/**
 * graphNotifications.mjs - Azure Function HTTP trigger for Microsoft Graph change notifications.
 * 
 * Handles:
 * 1. Subscription validation (echoes validationToken)
 * 2. Incoming message notifications (pushes to Service Bus queue)
 * 3. Lifecycle notifications (subscription renewal)
 */

import { app } from "@azure/functions";
import { ServiceBusClient } from "@azure/service-bus";

const QUEUE_NAME = "teams-messages";
const CLIENT_STATE = process.env.GRAPH_CLIENT_STATE || "teams-monitor-secret";

let sbClient = null;
let sbSender = null;

function getServiceBusSender() {
  if (!sbSender) {
    const connStr = process.env.ServiceBusConnection;
    if (!connStr) throw new Error("ServiceBusConnection not configured");
    sbClient = new ServiceBusClient(connStr);
    sbSender = sbClient.createSender(QUEUE_NAME);
  }
  return sbSender;
}

// Main webhook handler
app.http("graphNotifications", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "graphNotifications",
  handler: async (request, context) => {
    // Step 1: Handle subscription validation
    const validationToken = request.query.get("validationToken");
    if (validationToken) {
      context.log("Subscription validation received");
      return {
        status: 200,
        headers: { "Content-Type": "text/plain" },
        body: validationToken
      };
    }

    // Step 2: Parse notification payload
    let payload;
    try {
      payload = await request.json();
    } catch (e) {
      context.error("Failed to parse notification body:", e.message);
      return { status: 400, body: "Invalid JSON" };
    }

    if (!payload.value || !Array.isArray(payload.value)) {
      return { status: 202, body: "No notifications" };
    }

    const sender = getServiceBusSender();

    for (const notification of payload.value) {
      // Validate clientState
      if (notification.clientState && notification.clientState !== CLIENT_STATE) {
        context.warn("Invalid clientState, skipping notification");
        continue;
      }

      // Handle lifecycle notifications
      if (notification.lifecycleEvent) {
        context.log(`Lifecycle event: ${notification.lifecycleEvent}`);

        if (notification.lifecycleEvent === "reauthorizationRequired") {
          // Push a lifecycle message to the queue so the local bridge can handle renewal
          await sender.sendMessages({
            body: {
              type: "lifecycle",
              event: "reauthorizationRequired",
              subscriptionId: notification.subscriptionId,
              tenantId: notification.tenantId
            }
          });
        }
        continue;
      }

      // Handle message notifications
      const resource = notification.resource || "";
      const changeType = notification.changeType || "created";

      // Extract IDs from resource path: teams('id')/channels('id')/messages('id')
      const teamMatch = resource.match(/teams\('([^']+)'\)/);
      const channelMatch = resource.match(/channels\('([^']+)'\)/);
      const messageMatch = resource.match(/messages\('([^']+)'\)/);

      const message = {
        type: "message",
        changeType,
        teamId: teamMatch?.[1] || null,
        channelId: channelMatch?.[1] || null,
        messageId: messageMatch?.[1] || null,
        resource,
        subscriptionId: notification.subscriptionId,
        tenantId: notification.tenantId,
        receivedAt: new Date().toISOString()
      };

      // If includeResourceData was used and content is encrypted, pass it through
      if (notification.encryptedContent) {
        message.encryptedContent = notification.encryptedContent;
      }

      // If resource data is included unencrypted (rare but possible in dev)
      if (notification.resourceData) {
        message.resourceData = notification.resourceData;
      }

      context.log(`Message notification: ${changeType} in channel ${message.channelId}`);

      // Push to Service Bus
      try {
        await sender.sendMessages({ body: message });
      } catch (e) {
        context.error(`Failed to send to Service Bus: ${e.message}`);
      }
    }

    // Must respond within 3 seconds
    return { status: 202, body: "Accepted" };
  }
});

// Lifecycle notification handler (separate endpoint for clarity)
app.http("lifecycleNotifications", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "lifecycleNotifications",
  handler: async (request, context) => {
    const validationToken = request.query.get("validationToken");
    if (validationToken) {
      return { status: 200, headers: { "Content-Type": "text/plain" }, body: validationToken };
    }

    let payload;
    try { payload = await request.json(); } catch { return { status: 400 }; }

    if (payload.value) {
      for (const n of payload.value) {
        context.log(`Lifecycle: ${n.lifecycleEvent} for subscription ${n.subscriptionId}`);
      }
    }

    return { status: 202, body: "Accepted" };
  }
});
