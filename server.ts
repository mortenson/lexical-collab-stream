import { WebSocketServer } from 'ws';

const wss = new WebSocketServer({ port: 9045, host: '127.0.0.1' });

let initialEditorState = `{
  "root": {
    "children": [
      {
        "children": [],
        "direction": null,
        "format": "",
        "indent": 0,
        "type": "sync-paragraph",
        "version": 1,
        "syncId": "0197dd32-49e6-7509-a786-ed4de759b212",
        "textFormat": 0,
        "textStyle": ""
      }
    ],
    "direction": null,
    "format": "",
    "indent": 0,
    "type": "root",
    "version": 1
  }
}`

let messageStack: any[] = []

wss.on('connection', ws => {
  ws.on('error', console.error);

  ws.on('message', (data, isBinary) => {
    const str = data.toString()
    if (isBinary) {
      console.error(`Unexpected binary message: ${str}`)
      return
    }
    const messages: any[] = JSON.parse(data.toString())
    messageStack.push(...messages)
  });

  ws.send(JSON.stringify({
    type: 'init',
    editorState: initialEditorState,
  }))
});

let timerId = setTimeout(function tick() {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      messageStack.forEach(message => {
        client.send(JSON.stringify(message))
      })
    }
  })
  messageStack = []
  timerId = setTimeout(tick, 100);
}, 100);
