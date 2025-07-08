import { WebSocketServer, WebSocket } from "ws";
import Redis from "ioredis";
import type { SerializedEditorState } from "lexical";
import { isSyncMessagePeer } from "./src/Collab/Messages";
import type { SyncMessagePeer, SyncMessage } from "./src/Collab/Messages";
import parseArgs from "minimist";

// @todo: run real webserver and have this be in path, or put in every message
// @todo: also put the lastId the client saw in a query param or something
const defaultDocumentId = "documentId";

console.log("Connecting to Redis...");
const redis = new Redis();
await redis.ping();
console.log("Connected to Redis!");

const args = parseArgs(process.argv.slice(2));

if (args["wipe"]) {
  await redis.del(`streams:${defaultDocumentId}`);
  await redis.del(`documents:${defaultDocumentId}`);
  console.log("Wiped default document from Redis");
}

const wss = new WebSocketServer({ port: 9045, host: "127.0.0.1" });

console.log("Serving websockets on 127.0.0.1:9045");

// Redis operations

type RedisDocument = {
  editorState: SerializedEditorState;
  lastId: string;
};

// In my head this helps with race conditions, I don't really want to wait for
// a client to give me a document.
let defaultRedisDocument: RedisDocument = {
  lastId: "0",
  editorState: {
    root: {
      children: [],
      direction: null,
      format: "",
      indent: 0,
      type: "root",
      version: 1,
    },
  },
};

const getDocument = async (documentId: string): Promise<RedisDocument> => {
  const document = await redis.get(`documents:${documentId}`);
  if (document !== null) {
    return JSON.parse(document);
  }
  return defaultRedisDocument;
};

const setDocument = (
  documentId: string,
  document: RedisDocument,
): Promise<"OK"> => {
  return redis.set(`documents:${documentId}`, JSON.stringify(document));
};

type RedisStreamChunk = {
  messages: SyncMessage[];
  lastId: string;
};

const readStreamChunk = async (
  documentId: string,
  lastId: string,
): Promise<null | RedisStreamChunk> => {
  const results = await redis.xread(
    "COUNT",
    "50",
    "STREAMS",
    `streams:${documentId}`,
    lastId,
  );
  if (!results) {
    return null;
  }

  const [_, messagesRaw] = results[0];

  const messages: SyncMessage[] = [];
  messagesRaw.forEach(([id, messageRaw]) => {
    const message: SyncMessage = JSON.parse(messageRaw[1]);
    if (!isSyncMessagePeer(message)) {
      console.error(`Redis contains non-peer message: ${messageRaw[1]}`);
      return;
    }
    message.id = id;
    messages.push(message);
  });

  return {
    messages: messages,
    lastId: messagesRaw[messagesRaw.length - 1][0],
  };
};

const addtoStream = async (
  documentId: string,
  message: SyncMessagePeer,
): Promise<string | null> => {
  return redis.xadd(
    `streams:${documentId}`,
    "*",
    "message",
    JSON.stringify(message),
  );
};

// Websocket operations

const sendMessage = (ws: WebSocket, message: SyncMessage) => {
  ws.send(JSON.stringify(message));
};

const sendInitMessage = async (ws: WebSocket, documentId: string) => {
  const document = await getDocument(documentId);
  sendMessage(ws, {
    type: "init",
    editorState: document.editorState,
    lastId: document.lastId,
  });
};

const delay = (time: number) => new Promise((res) => setTimeout(res, time));

const listenForMessage = async (
  ws: WebSocket,
  documentId: string,
  lastId: string,
) => {
  const chunk = await readStreamChunk(documentId, lastId);
  if (!chunk || chunk.messages.length === 0) {
    // Some delay is fine when no results are returned given that we track lastId.
    await delay(100);
    await listenForMessage(ws, documentId, lastId);
    return;
  }

  chunk.messages.forEach((message) => {
    ws.send(JSON.stringify(message));
  });

  await listenForMessage(ws, documentId, chunk.lastId);
};

wss.on("connection", (ws) => {
  ws.on("error", console.error);

  ws.on("message", (data, isBinary) => {
    const str = data.toString();
    if (isBinary) {
      console.error(`Unexpected binary message: ${str}`);
      return;
    }
    const messages: SyncMessage[] = JSON.parse(data.toString());

    // Some messages are not meant to be broadcast
    // @todo Probably should make this clear in types
    if (messages.length === 1) {
      switch (messages[0].type) {
        // Begin streaming when client is ready.
        case "init-received":
          listenForMessage(ws, defaultDocumentId, messages[0].lastId);
          return;
        // Persist document from whatever client wants us to (YOLO).
        case "persist-document":
          setDocument(defaultDocumentId, {
            editorState: messages[0].editorState,
            lastId: messages[0].lastId,
          });
          return;
      }
    }

    messages.forEach((message) => {
      if (!isSyncMessagePeer(message)) {
        console.error(
          `Client sent a non-peer message, possibly trying to spoof other clients: ${message}`,
        );
        return;
      }
      addtoStream(defaultDocumentId, message);
    });
  });

  sendInitMessage(ws, defaultDocumentId);
});
