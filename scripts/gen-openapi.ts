import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import {
  ApiErrorEnvelope,
  AttachmentsPage,
  ChatWithMessages,
  ChatsPage,
  PublicRunStatus,
  RunTool,
  RunToolResult,
  SendMessage,
  SendMessageResult,
  ToolsPage,
  WebhookPayload,
} from "../src/contracts/index.js";

/**
 * Generates the OpenAPI document the Mintlify site renders from the same Zod contracts the routes
 * parse, so the published API reference cannot drift from what the server enforces.
 *
 * `io: "input"` on request bodies and `"output"` on responses: a schema with defaults or a
 * transform has two different shapes, and documenting the wrong one tells a caller to send fields
 * the server will reject.
 */
const OUT = resolve(import.meta.dirname, "../docs-site/openapi.json");

const schema = (value: z.ZodType, io: "input" | "output") =>
  z.toJSONSchema(value, { io, unrepresentable: "any" });

const errorResponses = {
  "400": errorResponse("The request failed validation."),
  "401": errorResponse("The API key is missing, malformed, revoked or unknown."),
  "404": errorResponse("No such resource, or it belongs to another account."),
  "409": errorResponse("That chat already has an active run."),
  "429": errorResponse("Rate limited."),
};

function errorResponse(description: string) {
  return {
    description,
    content: { "application/json": { schema: schema(ApiErrorEnvelope, "output") } },
  };
}

function ok(description: string, body: z.ZodType) {
  return {
    "200": {
      description,
      content: {
        "application/json": {
          schema: {
            type: "object",
            required: ["data"],
            properties: { data: schema(body, "output") },
          },
        },
      },
    },
    ...errorResponses,
  };
}

const jsonBody = (body: z.ZodType) => ({
  required: true,
  content: { "application/json": { schema: schema(body, "input") } },
});

const chatIdParam = {
  name: "chatId",
  in: "path",
  required: true,
  schema: { type: "string" },
  description: 'The chat id, or `new` to start a conversation.',
};

const document = {
  openapi: "3.1.0",
  info: {
    title: "Magica Agent Chat API",
    version: "1.0.0",
    description:
      "Submit messages to a long-running agent, run Magica media tools directly, and read " +
      "conversations back. Every response is wrapped in `{ data }`; every failure is " +
      "`{ error: { code, message, traceId } }`.",
  },
  servers: [{ url: "{baseUrl}/api/public/v1", variables: { baseUrl: { default: "" } } }],
  security: [{ apiKey: [] }],
  components: {
    securitySchemes: {
      apiKey: {
        type: "http",
        scheme: "bearer",
        description:
          "An API key issued from the app: `Authorization: Bearer mk_live_…`. Only the key's " +
          "hash is stored, so a lost key is replaced rather than recovered.",
      },
    },
    schemas: { WebhookPayload: schema(WebhookPayload, "output") },
  },
  paths: {
    "/chats": {
      get: {
        summary: "List conversations",
        operationId: "listChats",
        parameters: [
          { name: "cursor", in: "query", schema: { type: "string" } },
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 50 } },
          { name: "search", in: "query", schema: { type: "string" } },
          { name: "filter", in: "query", schema: { type: "string", enum: ["all", "pinned"] } },
        ],
        responses: ok("A page of conversations, most recently active first.", ChatsPage),
      },
    },
    "/chats/{chatId}": {
      get: {
        summary: "Read a conversation",
        operationId: "getChat",
        parameters: [
          chatIdParam,
          { name: "messagesCursor", in: "query", schema: { type: "string" } },
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 50 } },
        ],
        responses: ok("The conversation and a page of its messages.", ChatWithMessages),
      },
    },
    "/chats/{chatId}/messages": {
      post: {
        summary: "Submit a message",
        operationId: "sendMessage",
        description:
          "Returns as soon as the turn is durably dispatched — the agent keeps working after " +
          "the response. Poll `GET /runs/{runId}` for its status.",
        parameters: [chatIdParam],
        requestBody: jsonBody(SendMessage),
        responses: ok("The turn was accepted and dispatched.", SendMessageResult),
      },
    },
    "/runs/{runId}": {
      get: {
        summary: "Get run status",
        operationId: "getRun",
        description:
          "Terminal statuses are `completed`, `failed` and `cancelled`. A direct tool run also " +
          "carries its `result` once finished.",
        parameters: [{ name: "runId", in: "path", required: true, schema: { type: "string" } }],
        responses: ok("The run's current status.", PublicRunStatus),
      },
    },
    "/tools": {
      get: {
        summary: "List runnable tools",
        operationId: "listTools",
        description:
          "Each tool's `inputSchema` is generated from the schema the server validates against.",
        responses: ok("The runnable Magica tools.", ToolsPage),
      },
    },
    "/tools/{toolName}/run": {
      post: {
        summary: "Run a tool directly",
        operationId: "runTool",
        description:
          "Executes one Magica tool outside a conversation. Accepted-then-poll: the response " +
          "carries a `runId`, and the output appears on `GET /runs/{runId}` as `result`.",
        parameters: [{ name: "toolName", in: "path", required: true, schema: { type: "string" } }],
        requestBody: jsonBody(RunTool),
        responses: ok("The tool run was accepted.", RunToolResult.partial()),
      },
    },
    "/attachments": {
      get: {
        summary: "List media",
        operationId: "listAttachments",
        parameters: [
          { name: "cursor", in: "query", schema: { type: "string" } },
          { name: "source", in: "query", schema: { type: "string", enum: ["uploaded", "generated"] } },
          { name: "chatId", in: "query", schema: { type: "string" } },
        ],
        responses: ok("A page of uploaded and generated media.", AttachmentsPage),
      },
    },
  },
  webhooks: {
    "agent.started": webhook("Emitted when an agent turn begins working."),
    "agent.completed": webhook("Emitted when an agent turn finishes successfully."),
    "agent.failed": webhook("Emitted when an agent turn ends in failure."),
    "tool.completed": webhook("Emitted when one tool call finishes successfully."),
  },
};

function webhook(description: string) {
  return {
    post: {
      summary: description,
      description:
        "Signed with HMAC-SHA256 over `{svix-id}.{svix-timestamp}.{body}`, sent as " +
        "`svix-signature: v1,<base64>`. Verify before trusting the body, answer 2xx immediately, " +
        "and be idempotent — a delivery is retried up to five times with exponential backoff.",
      requestBody: {
        content: {
          "application/json": { schema: { $ref: "#/components/schemas/WebhookPayload" } },
        },
      },
      responses: { "200": { description: "Acknowledged." } },
    },
  };
}

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, `${JSON.stringify(document, null, 2)}\n`);

console.log(`openapi written to ${OUT}`);
