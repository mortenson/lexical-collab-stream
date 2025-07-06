import { WebSocketServer, WebSocket } from 'ws';
import Redis from 'ioredis'

// @todo: run real webserver and have this be in path, or put in every message
const documentId = 'documentId'

console.log('Connecting to Redis...')
const redis = new Redis();
await redis.ping()
console.log('Connected to Redis!')
redis.del(`redisStream:${documentId}`)

const wss = new WebSocketServer({ port: 9045, host: '127.0.0.1' });

console.log('Serving websockets on 127.0.0.1:9045')

let defaultEditorState = `{
  "root": {
    "children": [
    ],
    "direction": null,
    "format": "",
    "indent": 0,
    "type": "root",
    "version": 1
  }
}`

const sendInitMessage = async (ws: WebSocket) => {
  const result = await redis.get(`editorStates:${documentId}`);
  if (result) {
    ws.send(JSON.stringify({
      type: 'init',
      editorState: JSON.parse(result),
    }))
  } else {
    ws.send(JSON.stringify({
      type: 'init',
      editorState: JSON.parse(defaultEditorState),
    }))
  }
}

wss.on('connection', ws => {
  ws.on('error', console.error);

  ws.on('message', (data, isBinary) => {
    const str = data.toString()
    if (isBinary) {
      console.error(`Unexpected binary message: ${str}`)
      return
    }
    const messages: any[] = JSON.parse(data.toString())
    messages.forEach(message => {
      redis.xadd(`editorStreams:${documentId}`, '*', 'message', JSON.stringify(message))
    })
  });

  sendInitMessage(ws)
})

async function listenForMessage(lastId = "0") {
  const results = await redis.xread("STREAMS", `editorStreams:${documentId}`, lastId);
  if (results === null || results.length === 0) {
    await listenForMessage(lastId);
    return
  }

  const [_, messages] = results[0];

  wss.clients.forEach(ws => {
    messages.forEach(([id, message]) => {
      ws.send(message[1])
    });
  })

  // Pass the last id of the results to the next round.
  await listenForMessage(messages[messages.length - 1][0]);
}

listenForMessage();
