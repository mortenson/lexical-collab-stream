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

interface UpsertedMessage {
  id?: string;
  type: "upserted";
  userId: string;
  node: SerializedLexicalNode;
  previousId?: string;
  nextId?: string;
  parentId?: string;
}

interface DestroyedMessage {
  id?: string;
  type: "destroyed";
  userId: string;
  syncId: string;
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
  lastActivity: string; // ISO 8601
  userId: string;
  anchorId: string;
  anchorOffset: number;
  focusId: string;
  focusOffset: number;
}

// Messages the server should expect peers to send/broadcast
export type SyncMessagePeer =
  | UpsertedMessage
  | DestroyedMessage
  | CursorMessage;

export const isSyncMessagePeer = (
  message: SyncMessage,
): message is SyncMessagePeer => {
  return (
    message.type === "upserted" ||
    message.type === "destroyed" ||
    message.type === "cursor"
  );
};

// Messages clients expect the server to send
export type SyncMessageServer = InitMessage | SyncMessagePeer;

export const isSyncMessageServer = (
  message: SyncMessage,
): message is SyncMessageServer => {
  return isSyncMessagePeer(message) || message.type === "init";
};

// Messages the server expects from clients
export type SyncMessageClient =
  | InitReceivedMessage
  | PersistDocumentMessage
  | SyncMessagePeer;

export const isSyncMessageClient = (
  message: SyncMessage,
): message is SyncMessagePeer => {
  return (
    isSyncMessagePeer(message) ||
    message.type === "init-received" ||
    message.type === "persist-document"
  );
};

export type SyncMessage =
  | SyncMessageServer
  | SyncMessagePeer
  | SyncMessageClient;
