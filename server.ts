import { WebSocketServer, WebSocket } from "ws";
import Redis from "ioredis";
import type { SerializedEditorState } from "lexical";
import { isPeerMessage, isSyncMessageClient } from "./src/Collab/Messages";
import type {
  PeerMessage,
  SyncMessageClient,
  SyncMessageServer,
} from "./src/Collab/Messages";
import parseArgs from "minimist";

// @todo: run real webserver and have this be in path, or put in every message
// @todo: also put the lastId the client saw in a query param or something
const defaultDocumentId = "documentId";

// The number of messages every stream
const STREAM_COUNT = "10";
// The time between stream reads per client in milliseconds
const STREAM_DELAY_MS = 250;
// The max length of the stream. Set this to a low number to test desync.
const STREAM_MAXLEN = "10000";

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
  messages: PeerMessage[];
  lastId: string;
  firstId: string;
};

const readStreamChunk = async (
  documentId: string,
  lastId: string,
  count: string,
): Promise<null | RedisStreamChunk> => {
  const results = await redis.xread(
    "COUNT",
    count,
    "STREAMS",
    `streams:${documentId}`,
    lastId,
  );
  if (!results) {
    return null;
  }

  const [_, messagesRaw] = results[0];

  const messages: PeerMessage[] = [];
  messagesRaw.forEach(([id, messageRaw]) => {
    const message: PeerMessage = JSON.parse(messageRaw[1]);
    if (!isPeerMessage(message)) {
      console.error(`Redis contains non-peer message: ${messageRaw[1]}`);
      return;
    }
    if (message.type != "cursor") {
      message.streamId = id;
    }
    messages.push(message);
  });

  return {
    messages: messages,
    lastId: messagesRaw[messagesRaw.length - 1][0],
    firstId: messagesRaw[0][0],
  };
};

const addtoStream = async (
  documentId: string,
  message: PeerMessage,
): Promise<string | null> => {
  return redis.xadd(
    `streams:${documentId}`,
    "MAXLEN",
    "~",
    STREAM_MAXLEN,
    "*",
    "message",
    JSON.stringify(message),
  );
};

// Websocket operations

const sendMessage = (ws: WebSocket, message: SyncMessageServer) => {
  ws.send(JSON.stringify(message));
};

const sendInitMessage = async (ws: WebSocket, documentId: string) => {
  const document = await getDocument(documentId);
  const chunk = await readStreamChunk(documentId, "0", "1");
  sendMessage(ws, {
    type: "init",
    editorState: document.editorState,
    lastId: document.lastId,
    firstId: chunk?.firstId,
  });
};

const delay = (time: number) => new Promise((res) => setTimeout(res, time));

const listenForMessage = async (
  ws: WebSocket,
  documentId: string,
  lastId: string,
) => {
  const chunk = await readStreamChunk(documentId, lastId, STREAM_COUNT);
  if (!chunk || chunk.messages.length === 0) {
    await delay(STREAM_DELAY_MS);
    await listenForMessage(ws, documentId, lastId);
    return;
  }

  sendMessage(ws, {
    type: "peer-chunk",
    messages: chunk.messages,
  });

  await delay(STREAM_DELAY_MS);
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
    const clientMessage: SyncMessageClient = JSON.parse(data.toString());
    if (!isSyncMessageClient(clientMessage)) {
      console.error(`Client sent non-client message: ${str}`);
      return;
    }

    // Some messages are not meant to be broadcast
    // @todo Probably should make this clear in types
    switch (clientMessage.type) {
      // Begin streaming when client is ready.
      case "init-received":
        listenForMessage(ws, defaultDocumentId, clientMessage.lastId);
        return;
      // Persist document from whatever client wants us to (YOLO).
      case "persist-document":
        setDocument(defaultDocumentId, {
          editorState: clientMessage.editorState,
          lastId: clientMessage.lastId,
        });
        return;
      case "peer-chunk":
        clientMessage.messages.forEach((message) => {
          if (!isPeerMessage(message)) {
            console.error(
              `Client sent a non-peer message, possibly trying to spoof other clients: ${message}`,
            );
            return;
          }
          addtoStream(defaultDocumentId, message);
        });
        return;
    }
  });

  sendInitMessage(ws, defaultDocumentId);
});
