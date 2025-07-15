import { CollabNetwork, MessageListener, OpenListener } from "./CollabNetwork";
import {
  isSyncMessageServer,
  SyncMessageClient,
  SyncMessageServer,
} from "./Messages";

export class CollabWebSocket implements CollabNetwork {
  url: string | URL;
  ws?: WebSocket;
  openListeners: OpenListener[];
  messageListeners: MessageListener[];

  constructor(url: string | URL) {
    this.url = url;
    this.openListeners = [];
    this.messageListeners = [];
  }

  connect() {
    this.ws?.close();
    this.ws = new WebSocket(this.url);
    this.ws.addEventListener("error", (error) => {
      console.error(error);
      this.ws?.close();
    });
    this.ws.addEventListener("open", () =>
      this.openListeners.forEach((f) => f()),
    );
    this.ws.addEventListener("message", (wsMessage) => {
      const message: SyncMessageServer = JSON.parse(wsMessage.data);
      if (!isSyncMessageServer(message)) {
        console.error(`Non-server message sent from server: ${wsMessage.data}`);
        return;
      }
      this.messageListeners.forEach((f) => f(message));
    });
  }

  isOpen() {
    return this.ws !== undefined && this.ws.readyState === this.ws.OPEN;
  }

  close() {
    this.ws?.close();
  }

  send(message: SyncMessageClient) {
    this.ws?.send(JSON.stringify(message));
  }

  registerMessageListener(listener: MessageListener) {
    this.messageListeners.push(listener);
  }

  registerOpenListener(listener: OpenListener) {
    this.openListeners.push(listener);
  }
}
