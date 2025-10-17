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
        description: "Send a text message notification to the user. Supports Markdown formatting for messages. Use backticks for code blocks and inline code. Use square brackets for placeholders. This tool sends the notification and returns the message_id. It does NOT wait for a response.",
        inputSchema: {
          type: "object",
          properties: {
            message: {
              type: "string",
              description: "The message to send to the user. Supports Markdown formatting.",
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
            }
          },
          required: ["message", "project"]
        }
      },
      {
        name: "check_notification_response",
        description: "DISABLED: This tool is disabled because a webhook is active for the Telegram bot, which prevents the use of polling (getUpdates). An alternative mechanism is needed to handle responses if webhook is active.",
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
      if (!args?.message || typeof args.message !== 'string') {
        return {
          content: [{ type: "text", text: "Invalid or missing 'message' parameter. Must be a non-empty string." }],
          isError: true,
        };
      }

      if (!args?.project || typeof args.project !== 'string') {
        return {
          content: [{ type: "text", text: "Invalid or missing 'project' parameter. Must be a non-empty string." }],
          isError: true,
        };
      }

      const message = args.message.trim();
      const project = args.project.trim();

      if (!message || !project) {
        return {
          content: [{ type: "text", text: "Message and project cannot be empty." }],
          isError: true,
        };
      }

      // Validate and sanitize urgency
      const urgencyInput = args?.urgency ? String(args.urgency).toLowerCase() : "medium";
      const urgency: UrgencyLevel = VALID_URGENCY_LEVELS.includes(urgencyInput as UrgencyLevel)
        ? (urgencyInput as UrgencyLevel)
        : "medium";

      // Format the message with project name and urgency
      let urgencyPrefix = "";
      if (urgency === "high") {
        urgencyPrefix = "🚨 URGENT: ";
      } else if (urgency === "medium") {
        urgencyPrefix = "⚠️ ";
      }

      const formattedMessage = `${urgencyPrefix}LLM Question (${project}):\n\n${message}`;

      try {
        // Send the message using Telegram Bot API
        const response = await axiosInstance.post(`${TELEGRAM_API_URL}/sendMessage`, {
          chat_id: TELEGRAM_CHAT_ID,
          text: formattedMessage,
          parse_mode: 'Markdown'
        });

        if (!response.data?.ok || !response.data?.result?.message_id) {
          const errorDesc = response.data?.description || 'Unknown Telegram error';
          console.error(`Telegram API error on send: ${errorDesc}`);
          return {
            content: [{
              type: "text",
              text: `Failed to send Telegram notification. Error: ${errorDesc}`
            }],
            isError: true
          };
        }

        const sentMessageId = response.data.result.message_id;
        console.error(`Notification sent via Telegram. Message ID: ${sentMessageId}`);

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
        console.error("Error sending Telegram notification:", error);
        let errorMessage = "Unknown error occurred while sending notification.";

        if (axios.isAxiosError(error)) {
          if (error.code === 'ECONNABORTED') {
            errorMessage = "Request timeout: The Telegram API did not respond in time.";
          } else if (error.response) {
            const telegramError = error.response.data;
            errorMessage = `Telegram API error: ${telegramError?.description || error.message}`;
            console.error(`Telegram error details:`, telegramError);
          } else if (error.request) {
            errorMessage = "Network error: Unable to reach Telegram API.";
          } else {
            errorMessage = `Request error: ${error.message}`;
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
      console.warn(`Tool "check_notification_response" was called, but it is disabled due to an active webhook on the Telegram bot which prevents polling (getUpdates). Message ID: ${request.params.arguments?.message_id}`);

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
      console.error(`Unknown tool called: ${request.params.name}`);
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
  console.error("Telegram MCP server running on stdio. Polling for responses is DISABLED if a webhook is active.");
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});

