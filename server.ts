import { WebSocketServer, WebSocket } from 'ws';
import Redis from 'ioredis'
import type { SerializedEditorState } from 'lexical';
import type { SyncMessage } from './src/Messages'

// @todo: run real webserver and have this be in path, or put in every message
// @todo: also put the lastId the client saw in a query param or something
const defaultDocumentId = 'documentId'

console.log('Connecting to Redis...')
const redis = new Redis();
await redis.ping()
console.log('Connected to Redis!')

// Just easier to demo without state in redis for now
redis.del(`streams:${defaultDocumentId}`)
redis.del(`documents:${defaultDocumentId}`)

const wss = new WebSocketServer({ port: 9045, host: '127.0.0.1' });

console.log('Serving websockets on 127.0.0.1:9045')

type RedisDocument = {
  editorState: SerializedEditorState
  lastId: string
}

let defaultRedisDocument: RedisDocument = {
  lastId: "0",
  editorState: {
    root: {
      children: [],
      direction: null,
      format: "",
      indent: 0,
      type: "root",
      version: 1
    }
  }
}

const sendInitMessage = async (ws: WebSocket, documentId: string) => {
  const result = await redis.get(`documents:${documentId}`);
  const document: RedisDocument = result !== null ? JSON.parse(result) : defaultRedisDocument
  ws.send(JSON.stringify({
    type: 'init',
    editorState: document.editorState,
    lastId: document.lastId,
  }))
}

const delay = (time: number) => new Promise( res => setTimeout(res, time));

async function listenForMessage(ws: WebSocket, documentId: string, lastId = "0") {
  const results = await redis.xread("STREAMS", `streams:${documentId}`, lastId);
  if (results === null || results.length === 0) {
    // Some delay is fine when no results are returned given that we track lastId.
    await delay(50)
    await listenForMessage(ws, documentId, lastId);
    return
  }

  const [_, messages] = results[0];

  messages.forEach(([_, message]) => {
    ws.send(message[1])
  });

  await listenForMessage(ws, documentId, messages[messages.length - 1][0]);
}

wss.on('connection', ws => {
  ws.on('error', console.error);

  ws.on('message', (data, isBinary) => {
    const str = data.toString()
    if (isBinary) {
      console.error(`Unexpected binary message: ${str}`)
      return
    }
    const messages: SyncMessage[] = JSON.parse(data.toString())

    // Special case: begin streaming when client is ready.
    if (messages.length === 1 && messages[0].type === 'init-received') {
      listenForMessage(ws, defaultDocumentId, messages[0].lastId)
      return
    }

    messages.forEach(message => {
      redis.xadd(`streams:${defaultDocumentId}`, '*', 'message', JSON.stringify(message))
    })
  });

  sendInitMessage(ws, defaultDocumentId)
})
