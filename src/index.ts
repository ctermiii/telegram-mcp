#!/usr/bin/env node

/**
 * This is an MCP server that implements a notification system.
 * It allows the LLM to send notifications to the user via Telegram
 * when it has a question that needs a response.
 *
 * NOTE: Due to Telegram's restriction ("can't use getUpdates method while webhook is active"),
 * all polling-based response checking has been disabled.
 * If a webhook is active for this bot, this server will only send notifications.
 * An alternative mechanism (e.g., a separate webhook handler) would be needed to process responses.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import axios from "axios";

// Environment variables for Telegram configuration
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Validate required environment variables
if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  throw new Error(
    "Missing required environment variables. Please ensure TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are set."
  );
}

// Telegram API base URL
const TELEGRAM_API_URL = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

// Axios instance with timeout configuration
const axiosInstance = axios.create({
  timeout: 10000, // 10 second timeout
  headers: {
    'Content-Type': 'application/json'
  }
});

// Valid urgency levels
type UrgencyLevel = "low" | "medium" | "high";
const VALID_URGENCY_LEVELS: UrgencyLevel[] = ["low", "medium", "high"];

// Valid message formats
type MessageFormat = "plain_text" | "markdown_v2";
const VALID_MESSAGE_FORMATS: MessageFormat[] = ["plain_text", "markdown_v2"];

/**
 * Escape text for Telegram MarkdownV2 format
 * https://core.telegram.org/bots/api#markdownv2-style
 */
function escapeMarkdownV2(text: string): string {
  return text.replace(/[\[\]()~>#+\-=|{}.!]/g, "\\$&");
}

/**
 * Structured logging function
 */
const log = (level: 'info' | 'warn' | 'error', message: string, data?: any) => {
  const timestamp = new Date().toISOString();
  const logEntry = { timestamp, level, message, ...(data || {}) };
  console.error(JSON.stringify(logEntry));
};

/**
 * Create an MCP server with capabilities for tools (to send notifications)
 */
const server = new Server(
  {
    name: "telegram-mcp",
    version: "1.3.1"
  },
  {
    capabilities: {
      tools: {}
    }
  }
);

/**
 * Handler that lists available tools.
 * Exposes tools for sending notifications. Response checking via polling is disabled.
 */
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "send_notification",
        description: "Send a text message notification to the user. Supports both plain text and MarkdownV2 formatting. This tool sends the notification and returns the message_id. It does NOT wait for a response.",
        inputSchema: {
          type: "object",
          properties: {
            message: {
              type: "string",
              description: "The message to send to the user. Supports MarkdownV2 formatting when format is set to markdown_v2.",
              examples: [
                "Here's how to create a storage account:\n\n`az storage account create --name [storage-name] --resource-group [rg-name]`\n\nReplace:\n- `[storage-name]`: Your storage account name\n- `[rg-name]`: Your resource group",
                "Would you like me to help you set up Azure DevOps integration?"
              ]
            },
            project: {
              type: "string",
              description: "The name of the project the LLM is working on",
              examples: ["azure-cli", "devops-setup", "terraform-config"]
            },
            urgency: {
              type: "string",
              enum: ["low", "medium", "high"],
              description: "The urgency of the notification. Affects message formatting:\n- high: Prefixes with 🚨 URGENT\n- medium: Prefixes with ⚠️\n- low: No prefix",
              default: "medium"
            },
            format: {
              type: "string",
              enum: ["plain_text", "markdown_v2"],
              description: "The message format to use. Defaults to plain_text.",
              examples: ["plain_text", "markdown_v2"],
              default: "plain_text"
            }
          },
          required: ["message", "project"]
        }
      },
      {
        name: "check_notification_response",
        description: "Checks if the user has responded to a previously sent notification. DISABLED by default because a webhook is active for the Telegram bot, which prevents the use of polling (getUpdates). To enable, first disable the webhook using: https://api.telegram.org/bot<YOUR_BOT_TOKEN>/deleteWebhook",
        inputSchema: {
          type: "object",
          properties: {
            message_id: {
              type: "number",
              description: "The ID of the message to check for responses.",
              examples: [12345]
            },
            timeout_seconds: {
              type: "number",
              description: "How long to wait for a response (currently ignored).",
              default: 30,
              examples: [30, 60, 120]
            }
          },
          required: ["message_id"]
        }
      }
    ]
  };
});

/**
 * Handler for the notification tools.
 */
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  switch (request.params.name) {
    case "send_notification": {
      const args = request.params.arguments;

      // Validate required parameters
      if (typeof args !== 'object' || args === null) {
        return {
          content: [{ type: "text", text: "Invalid arguments format. Must be an object." }],
          isError: true,
        };
      }

      if (typeof args.message !== 'string' || args.message.trim() === '') {
        return {
          content: [{ type: "text", text: "Invalid or missing 'message' parameter. Must be a non-empty string." }],
          isError: true,
        };
      }

      if (typeof args.project !== 'string' || args.project.trim() === '') {
        return {
          content: [{ type: "text", text: "Invalid or missing 'project' parameter. Must be a non-empty string." }],
          isError: true,
        };
      }

      const message = args.message.trim();
      const project = args.project.trim();

      // Validate and sanitize urgency
      const urgencyInput = args.urgency ? String(args.urgency).toLowerCase() : "medium";
      const urgency: UrgencyLevel = VALID_URGENCY_LEVELS.includes(urgencyInput as UrgencyLevel)
        ? (urgencyInput as UrgencyLevel)
        : "medium";

      // Validate and sanitize message format
      const formatInput = args.format ? String(args.format).toLowerCase() : "plain_text";
      const format: MessageFormat = VALID_MESSAGE_FORMATS.includes(formatInput as MessageFormat)
        ? (formatInput as MessageFormat)
        : "plain_text";

      // Format the message with project name and urgency
      let urgencyPrefix = "";
      if (urgency === "high") {
        urgencyPrefix = "🚨 URGENT: ";
      } else if (urgency === "medium") {
        urgencyPrefix = "⚠️ ";
      }

      let formattedMessage = `${urgencyPrefix}LLM Question (${project}):\n\n${message}`;

      // Prepare Telegram API payload
      const telegramPayload: any = {
        chat_id: TELEGRAM_CHAT_ID,
        text: formattedMessage
      };

      // Apply formatting if needed
      if (format === "markdown_v2") {
        telegramPayload.parse_mode = "MarkdownV2";
        // Escape the entire message for MarkdownV2
        telegramPayload.text = escapeMarkdownV2(formattedMessage);
      }

      try {
        // Send the message using Telegram Bot API
        const response = await axiosInstance.post(`${TELEGRAM_API_URL}/sendMessage`, telegramPayload);

        if (!response.data?.ok || !response.data?.result?.message_id) {
          const errorDesc = response.data?.description || 'Unknown Telegram error';
          log('error', 'Telegram API error on send', { error: errorDesc });
          return {
            content: [{
              type: "text",
              text: `Failed to send Telegram notification. Error: ${errorDesc}`
            }],
            isError: true
          };
        }

        const sentMessageId = response.data.result.message_id;
        log('info', 'Notification sent via Telegram', { message_id: sentMessageId, project, urgency, format });

        // Return success with the message_id
        return {
          content: [{
            type: "text",
            text: `Notification sent successfully. Message ID: ${sentMessageId}`
          }],
          toolMetadata: {
            telegram_message_id: sentMessageId
          }
        };

      } catch (error) {
        // Log detailed error information
        log('error', 'Error sending Telegram notification', { error: String(error) });

        let errorMessage = "Unknown error occurred while sending notification.";

        if (axios.isAxiosError(error)) {
          if (error.code === 'ECONNABORTED') {
            errorMessage = "Request timeout: The Telegram API did not respond in time.";
            log('error', 'Telegram API timeout', { code: error.code });
          } else if (error.response) {
            const telegramError = error.response.data;
            errorMessage = `Telegram API error: ${telegramError?.description || error.message}`;
            log('error', 'Telegram API response error', { response: error.response.data });
          } else if (error.request) {
            errorMessage = "Network error: Unable to reach Telegram API.";
            log('error', 'Telegram network error', { request: String(error.request) });
          } else {
            errorMessage = `Request error: ${error.message}`;
            log('error', 'Telegram request error', { message: error.message });
          }
        } else if (error instanceof Error) {
          errorMessage = error.message;
        }

        return {
          content: [{ type: "text", text: errorMessage }],
          isError: true,
        };
      }
    }

    case "check_notification_response": {
      log('warn', 'Tool "check_notification_response" was called, but it is disabled due to an active webhook on the Telegram bot which prevents polling (getUpdates).', {
        message_id: request.params.arguments?.message_id
      });

      return {
        content: [{
          type: "text",
          text: "Polling for responses is disabled because a webhook is active on the Telegram bot. Please use an alternative method (e.g., a webhook handler) to process user responses."
        }],
        isError: false
      };
    }

    default:
      // It's better to return a structured error for unknown tools
      log('error', 'Unknown tool called', { tool_name: request.params.name });
      return {
          content: [{ type: "text", text: `Error: Unknown tool name '${request.params.name}'.` }],
          isError: true,
      };
  }
});

/**
 * Start the server using stdio transport.
 * This allows the server to communicate via standard input/output streams.
 */
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('info', "Telegram MCP server running on stdio. Polling for responses is DISABLED if a webhook is active.");
}

main().catch((error) => {
  log('error', "Server error", { error: String(error) });
  process.exit(1);
});

