import {
  ActionSender,
  BaseRoomConfig,
  RelayConfig,
  Room,
  TargetPeers,
  TurnConfig,
} from "trystero";
import {
  CollabNetwork,
  debugEventSyncMessage,
  DebugListener,
  MessageListener,
  OpenListener,
} from "./CollabNetwork";
import {
  isSyncMessageClient,
  isSyncMessageServer,
  PeerMessage,
  SyncMessageClient,
  SyncMessageServer,
} from "./Messages";
import { joinRoom } from "trystero";
import { SerializedEditorState } from "lexical";

type TrysteroSyncAction = {
  messageJSON: string;
};

// Probably spiritually equivalent to a WebRTC implementation but mostly exists
// so that the project can be demo'd without a websocket server or redis
// running forever.
export class CollabTrystero implements CollabNetwork {
  roomId: string;
  room?: Room;
  sendPeerMessage: ActionSender<TrysteroSyncAction>;
  openListeners: OpenListener[];
  messageListeners: MessageListener[];
  stream: PeerMessage[];
  streamMap: Map<string, number>;
  queuedMessages: SyncMessageClient[];
  lastEditorState: SerializedEditorState;
  lastId: string;
  alreadyInit: boolean;
  connected: boolean;
  config: BaseRoomConfig & RelayConfig & TurnConfig;
  debugListeners: DebugListener[];

  constructor(
    config: BaseRoomConfig & RelayConfig & TurnConfig,
    roomId: string,
  ) {
    this.config = config;
    this.roomId = roomId;
    this.openListeners = [];
    this.messageListeners = [];
    this.sendPeerMessage = async () => [];
    this.stream = [];
    this.streamMap = new Map();
    this.alreadyInit = false;
    this.connected = false;
    this.queuedMessages = [];
    this.debugListeners = [];
    // This probably would be fetched by a persistent DB.
    this.lastId = "0";
    this.lastEditorState = {
      root: {
        children: [],
        direction: null,
        format: "",
        indent: 0,
        type: "root",
        version: 1,
      },
    };
  }

  async connect() {
    await this.close();
    this.debugListeners.forEach((f) => f({ type: "joining-room" }));
    this.room = joinRoom(this.config, this.roomId);
    this.connected = true;

    // Our only WebRTC call is to send peers messages as if we were a server.
    const [sendPeerMessage, getPeerMessage] =
      this.room.makeAction<TrysteroSyncAction>("peerMessage");
    this.sendPeerMessage = sendPeerMessage;

    // A peer joined, send them our version of the editorState.
    this.room.onPeerJoin((peerId) => {
      this.debugListeners.forEach((f) =>
        f({ type: "peer-joined", message: `peerId: ${peerId}` }),
      );
      this.sendAsServer(
        {
          type: "init",
          editorState: this.lastEditorState,
          lastId: this.lastId,
          firstId: this.stream.length > 0 ? this.stream[0].streamId : undefined,
        },
        [peerId],
      );
    });

    // Message listener.
    getPeerMessage((data, peerId) => {
      const message = JSON.parse(data.messageJSON);
      // A peer connected or reconnected.
      if (isSyncMessageClient(message) && message.type === "init-received") {
        console.log(
          `${peerId} wants to catch up from ${message.lastId} to ${this.lastId}`,
        );
        // Peer reconnected and is on an "old" stream ID.
        // Send them a chunk of the remainder of our stream.
        if (message.lastId !== this.lastId) {
          const chunk = this.getStreamSince(message.lastId);
          if (chunk.length > 0) {
            this.sendAsServer(
              {
                type: "peer-chunk",
                messages: chunk,
              },
              [peerId],
            );
          }
        }
        return;
      }
      // Should be unreachable but nice safety.
      if (!isSyncMessageServer(message)) {
        console.error(`Peer sent non-server message: ${data.messageJSON}`);
        return;
      }
      // Peers spam us with their editor state when we connect, CollabInstance
      // isn't really prepared for that and assumes we reconnected.
      if (message.type === "init") {
        if (this.alreadyInit) {
          return;
        } else {
          this.alreadyInit = true;
        }
      }
      // Finally, call into the actual CollabInstance.
      this.messageListeners.forEach((f) => f(message));
      this.debugListeners.forEach((f) =>
        f(debugEventSyncMessage("down", message)),
      );
    });

    this.openListeners.forEach((f) => f());
    this.debugListeners.forEach((f) => f({ type: "open" }));
  }

  isOpen() {
    return this.connected;
  }

  async close() {
    this.alreadyInit = false;
    await this.room?.leave();
    this.connected = false;
    this.debugListeners.forEach((f) => f({ type: "close" }));
  }

  // Normally Redis creates stream IDs on insert, so we have to make some up.
  assignStreamIdsToMessage(message: SyncMessageClient): SyncMessageClient {
    switch (message.type) {
      case "init-received":
      case "persist-document":
        return message;
      case "peer-chunk":
        message.messages = message.messages.map((message) => {
          const newMessage = structuredClone(message);
          newMessage.streamId = (Date.now() + Math.random()).toString();
          return newMessage;
        });
        return message;
    }
  }

  send(rawMessage: SyncMessageClient) {
    const message = this.assignStreamIdsToMessage(rawMessage);
    // While I'm disconnected, store messages in a queue waiting for peers.
    if (!this.room || Object.keys(this.room.getPeers()).length === 0) {
      this.queuedMessages.push(message);
      return;
      // We're back baby, blast peers with our queued edits.
    } else if (this.queuedMessages.length > 0) {
      const queue = this.queuedMessages;
      this.queuedMessages = [];
      queue.forEach((m) => {
        if (m.type === "peer-chunk") {
          m.messages.forEach((pm) => this.addToStream(pm));
        }
        this.send(m);
      });
    }

    switch (message.type) {
      case "persist-document":
        this.lastEditorState = message.editorState;
        // no-op, but I guess might be valuable to other clients subjectively
        return;
      case "peer-chunk":
        message.messages.forEach((message) => {
          this.addToStream(message);
        });
        // Mimic websocket behavior of clients getting their own messages.
        this.messageListeners.forEach((f) => f(message));
        break;
      case "init-received":
        message.lastId = this.lastId;
        break;
    }
    this.sendPeerMessage({ messageJSON: JSON.stringify(message) });
    this.debugListeners.forEach((f) => f(debugEventSyncMessage("up", message)));
  }

  // Adds a message to our stream and map the stream ID to the stream index.
  addToStream(message: PeerMessage) {
    if (!message.streamId) {
      console.error(
        `Cannot add ${JSON.stringify(message)} to stream, no streamId`,
      );
      return;
    }
    this.stream.push(message);
    this.streamMap.set(message.streamId, this.stream.length - 1);
    this.lastId = message.streamId;
  }

  // Gets stream messages since a given ID. Just like Redis?
  getStreamSince(streamId: string): PeerMessage[] {
    if (streamId === "0") {
      return this.stream;
    }
    const index = this.streamMap.get(streamId);
    if (index !== undefined) {
      return this.stream.slice(index);
    }
    console.error(`Don't know how to catch up from ${streamId}`);
    return [];
  }

  sendAsServer(message: SyncMessageServer, targetPeers?: TargetPeers) {
    this.sendPeerMessage({ messageJSON: JSON.stringify(message) }, targetPeers);
    this.debugListeners.forEach((f) => f(debugEventSyncMessage("up", message)));
  }

  registerMessageListener(listener: MessageListener) {
    this.messageListeners.push(listener);
  }

  registerOpenListener(listener: OpenListener) {
    this.openListeners.push(listener);
  }

  registerDebugListener(listener: DebugListener) {
    this.debugListeners.push(listener);
  }
}
