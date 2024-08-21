const express = require("express");
const path = require("path");
const bodyParser = require("body-parser");
const axios = require("axios");
const https = require("https");
const { encode } = require("gpt-3-encoder");
const { randomUUID, randomInt, createHash } = require("crypto");
const { config } = require("dotenv");

config();

// Constants for the server and API configuration
const port = process.env.SERVER_PORT || 3040;
const baseUrl = "https://chat.openai.com";
const apiUrl = `${baseUrl}/backend-api/conversation`;
const refreshInterval = 60000; // Interval to refresh token in ms
const errorWait = 120000; // Wait time in ms after an error
const newSessionRetries = parseInt(process.env.NEW_SESSION_RETRIES) || 5;
const userAgent = process.env.USER_AGENT || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";

// Initialize global variables to store the session token and device ID
let token;
let oaiDeviceId;

// Function to wait for a specified duration
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Function to generate a unique completion ID
function GenerateCompletionId(prefix = "cmpl-") {
  const characters = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const length = 28;

  for (let i = 0; i < length; i++) {
    prefix += characters.charAt(Math.floor(Math.random() * characters.length));
  }

  return prefix;
}

// Async generator to handle chunked responses and extract lines
async function* chunksToLines(chunksAsync) {
  let previous = "";
  for await (const chunk of chunksAsync) {
    const bufferChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    previous += bufferChunk;
    let eolIndex;
    while ((eolIndex = previous.indexOf("\n")) >= 0) {
      // line includes the EOL
      const line = previous.slice(0, eolIndex + 1).trimEnd();
      if (line === "data: [DONE]") break;
      if (line.startsWith("data: ")) yield line;
      previous = previous.slice(eolIndex + 1);
    }
  }
}

// Async generator to extract messages from lines
async function* linesToMessages(linesAsync) {
  for await (const line of linesAsync) {
    const message = line.substring("data :".length);

    yield message;
  }
}

// Async generator to stream completion responses
async function* StreamCompletion(data) {
  yield* linesToMessages(chunksToLines(data));
}

// Setup axios instance for API requests with predefined configurations
const axiosInstance = axios.create({
  httpsAgent: new https.Agent({ rejectUnauthorized: false }),
  headers: {
    accept: "*/*",
    "accept-language": "en-US,en;q=0.9",
    "cache-control": "no-cache",
    "content-type": "application/json",
    "oai-language": "en-US",
    origin: baseUrl,
    pragma: "no-cache",
    referer: baseUrl,
    "sec-ch-ua": '"Google Chrome";v="123", "Not:A-Brand";v="8", "Chromium";v="123"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "user-agent": userAgent,
  },
});

// Function to generate proof token for authentication
function generateProofToken(seed, diff, userAgent) {
  const cores = [8, 12, 16, 24];
  const screens = [3000, 4000, 6000];
  const core = cores[randomInt(0, cores.length)];
  const screen = screens[randomInt(0, screens.length)];
  const now = new Date(Date.now() - 8 * 3600 * 1000);
  const parseTime = now.toUTCString().replace("GMT", "GMT-0500 (Eastern Time)");
  const config = [core + screen, parseTime, 4294705152, 0, userAgent];
  const diffLen = diff.length / 2;
  for (let i = 0; i < 100000; i++) {
    config[3] = i;
    const jsonData = JSON.stringify(config);
    const base = Buffer.from(jsonData).toString("base64");
    const hashValue = createHash("sha3-512")
      .update(seed + base)
      .digest();
    if (hashValue.toString("hex").substring(0, diffLen) <= diff) {
      const result = "gAAAAAB" + base;
      return result;
    }
  }
  const fallbackBase = Buffer.from(`"${seed}"`).toString("base64");
  return "gAAAAABwQ8Lk5FbGpA2NcR9dShT6gYjU7VxZ4D" + fallbackBase;
}

// Function to get a new session ID and token from the OpenAI API
async function getNewSession(retries = 0) {
  let newDeviceId = randomUUID();
  try {
    const response = await axiosInstance.post(
      `${baseUrl}/backend-anon/sentinel/chat-requirements`,
      {},
      {
        headers: { "oai-device-id": newDeviceId },
      }
    );

    let session = response.data;
    session.deviceId = newDeviceId;

    console.log(
      `System: Successfully refreshed session ID and token. ${
        !token ? "(Now it's ready to process requests)" : ""
      }`
    );
    oaiDeviceId = newDeviceId;
    token = session.token;

    return session;
  } catch (error) {
    await wait(500);
    return retries < newSessionRetries ? getNewSession(retries + 1) : null;
  }
}

// Middleware to enable CORS and handle pre-flight requests
function enableCORS(req, res, next) {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }
  next();
}

// Middleware to handle chat completions
async function handleChatCompletion(req, res) {
  console.log(
    "Request:",
    `${req.method} ${req.originalUrl}`,
    `${req.body?.messages?.length ?? 0} messages`,
    req.body.stream ? "(stream-enabled)" : "(stream-disabled)"
  );
  try {
    let session = await getNewSession();
    if (!session) {
      res.write(
        JSON.stringify({
          status: false,
          error: {
            message: `Error getting a new session, please try again later, if the issue persists, please open an issue on the GitHub repository.`,
            type: "invalid_request_error",
          },
        })
      );
      return res.end();
    }
    let proofToken = generateProofToken(
      session.proofofwork.seed,
      session.proofofwork.difficulty,
      userAgent
    );
    const body = {
      action: "next",
      messages: req.body.messages.map((message) => ({
        author: { role: message.role },
        content: { content_type: "text", parts: [message.content] },
      })),
      parent_message_id: randomUUID(),
      model: "text-davinci-002-render-sha",
      timezone_offset_min: -180,
      suggestions: [],
      history_and_training_disabled: true,
      conversation_mode: { kind: "primary_assistant" },
      websocket_request_id: randomUUID(),
    };
    let promptTokens = 0;
    let completionTokens = 0;
    for (let message of req.body.messages) {
      promptTokens += encode(message.content).length;
    }

    const response = await axiosInstance.post(apiUrl, body, {
      responseType: "stream",
      headers: {
        "oai-device-id": session.deviceId,
        "openai-sentinel-chat-requirements-token": session.token,
        "openai-sentinel-proof-token": proofToken,
      },
    });

    // Set the response headers based on the request type
    if (req.body.stream) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
    } else {
      res.setHeader("Content-Type", "application/json");
    }

    let fullContent = "";
    let requestId = GenerateCompletionId("chatcmpl-");
    let created = Math.floor(Date.now() / 1000); // Unix timestamp in seconds
    let finish_reason = null;
    let error;

    for await (const message of StreamCompletion(response.data)) {
      // Skip heartbeat detection
      if (message.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/)) {
        continue;
      }

      const delta = JSON.parse(message);
      if (delta.error) {
        error = delta.error.message || "An error occurred.";
        console.error("System: Error during chat completion: ", error);
        return res.status(500).send({
          status: false,
          error: {
            message: `An error occurred during chat completion: ${error}. Please open an issue on the GitHub repository.`,
            type: "completion_error",
          },
        });
      }

      finish_reason = delta.finish_reason || null;
      let content = delta.message?.content?.parts?.[0];

      if (content) {
        completionTokens += encode(content).length;
        fullContent += content;
        if (req.body.stream) {
          res.write(
            JSON.stringify({
              created: created,
              id: requestId,
              model: "text-davinci-002-render-sha",
              object: "chat.completion.chunk",
              choices: [
                {
                  delta: { content: content },
                  index: 0,
                  finish_reason: null,
                },
              ],
            })
          );
        }
      }
    }
    if (!req.body.stream) {
      res.json({
        id: requestId,
        object: "chat.completion",
        created: created,
        model: "text-davinci-002-render-sha",
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens,
        },
        choices: [
          {
            message: {
              author: { role: "assistant" },
              content: {
                content_type: "text",
                parts: [fullContent],
              },
            },
            finish_reason: finish_reason,
            index: 0,
          },
        ],
      });
    } else {
      res.write(
        JSON.stringify({
          created: created,
          id: requestId,
          model: "text-davinci-002-render-sha",
          object: "chat.completion.chunk",
          choices: [
            {
              delta: {},
              index: 0,
              finish_reason: finish_reason ?? "stop",
            },
          ],
        })
      );
      res.end();
    }
  } catch (error) {
    console.error("System: Error occurred:", error);
    res.status(500).send({
      status: false,
      error: {
        message: `An error occurred: ${error.message}. Please try again later.`,
        type: "request_error",
      },
    });
  }
}

// Initialize the Express application and setup routes
const app = express();

// Enable body parsing middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Enable CORS middleware
app.use(enableCORS);

// Serve static files from the "public" directory
app.use(express.static(path.join(__dirname, 'public')));

// Route to serve the index.html file
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// POST route for chat completions
app.post("/chat/completions", handleChatCompletion);

// Start the Express server and listen on the specified port
app.listen(port, async () => {
  console.log(`System: Server started on port ${port}`);
  console.log("System: Refreshing session ID and token...");
  await getNewSession();
});
