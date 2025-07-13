import {
  NODE_STATE_KEY,
  SerializedEditorState,
  SerializedLexicalNode,
} from "lexical";

interface SerializedSyncNode extends SerializedLexicalNode {
  [NODE_STATE_KEY]: {
    syncId: string;
  };
}

export const isSerializedSyncNode = (
  node: SerializedLexicalNode,
): node is SerializedSyncNode => {
  return node.$ !== undefined && "syncId" in node.$;
};

export interface NodeMessageBase {
  streamId?: string;
  userId: string;
  node: SerializedSyncNode;
  previousId?: string;
  parentId?: string;
}

interface CreatedMessage extends NodeMessageBase {
  type: "created";
}

interface UpdatedMessage extends NodeMessageBase {
  type: "updated";
  previousNode: SerializedSyncNode;
}

interface DestroyedMessage extends NodeMessageBase {
  type: "destroyed";
}

interface InitMessage {
  lastId: string;
  type: "init";
  editorState: SerializedEditorState;
}

interface InitReceivedMessage {
  type: "init-received";
  userId: string;
  lastId: string;
}

interface PersistDocumentMessage {
  type: "persist-document";
  lastId: string;
  editorState: SerializedEditorState;
}

interface CursorMessage {
  type: "cursor";
  lastActivity: number; // Date.now()
  userId: string;
  anchorId: string;
  anchorOffset: number;
  focusId: string;
  focusOffset: number;
}

interface TypedMessage {
  type: string;
}

export const isTypedMessage = (message: any): message is TypedMessage => {
  return typeof message === "object" && "type" in message;
};

export type PeerMessage =
  | CreatedMessage
  | UpdatedMessage
  | DestroyedMessage
  | CursorMessage;

export const isPeerMessage = (message: any): message is PeerMessage => {
  return (
    isTypedMessage(message) &&
    ["created", "updated", "destroyed", "cursor"].includes(message.type)
  );
};

// Chunks of peer messages stored in Redis and processed between clients
export type SyncMessagePeerChunk = {
  type: "peer-chunk";
  messages: PeerMessage[];
};

export const isSyncMessagePeerChunk = (
  message: any,
): message is SyncMessagePeerChunk => {
  return isTypedMessage(message) && message.type === "peer-chunk";
};

// Messages clients expect the server to send
export type SyncMessageServer = InitMessage | SyncMessagePeerChunk;

export const isSyncMessageServer = (
  message: any,
): message is SyncMessageServer => {
  return (
    isSyncMessagePeerChunk(message) ||
    (isTypedMessage(message) && message.type === "init")
  );
};

// Messages the server expects clients to send
export type SyncMessageClient =
  | InitReceivedMessage
  | PersistDocumentMessage
  | SyncMessagePeerChunk;

export const isSyncMessageClient = (
  message: any,
): message is SyncMessageClient => {
  return (
    isSyncMessagePeerChunk(message) ||
    (isTypedMessage(message) &&
      ["init-received", "persist-document"].includes(message.type))
  );
};
