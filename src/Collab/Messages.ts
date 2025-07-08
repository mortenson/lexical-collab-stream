import { SerializedEditorState } from "lexical";
import { SerializedSyncParagraphNode, SerializedSyncTextNode } from "./Nodes";

export type SerializedSyncNode =
  | SerializedSyncTextNode
  | SerializedSyncParagraphNode;

interface UpsertedMessage {
  id?: string;
  type: "upserted";
  userId: string;
  node: SerializedSyncNode;
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
  lastId: string;
}

interface PersistDocumentMessage {
  type: "persist-document";
  lastId: string;
  editorState: SerializedEditorState;
}

// Messages the server should expect peers to send/broadcast
export type SyncMessagePeer = UpsertedMessage | DestroyedMessage;

export const isSyncMessagePeer = (
  message: SyncMessage,
): message is SyncMessagePeer => {
  return message.type === "upserted" || message.type === "destroyed";
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
