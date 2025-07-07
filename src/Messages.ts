import { SerializedEditorState } from "lexical"
import { SerializedSyncParagraphNode, SerializedSyncTextNode } from "./Nodes"

export type SerializedSyncNode = SerializedSyncTextNode | SerializedSyncParagraphNode

interface  UpsertedMessage {
  id?: string
  type: 'upserted'
  userId: string
  node: SerializedSyncNode
  previousId?: string
  nextId?: string
  parentId?: string
}

interface  DestroyedMessage {
  id?: string
  type: 'destroyed'
  userId: string
  syncId: string
}

interface InitMessage {
  lastId: string
  type: 'init'
  editorState: SerializedEditorState
}

interface InitReceivedMessage {
  type: 'init-received'
  lastId: string
}

export type SyncMessage = UpsertedMessage | DestroyedMessage | InitMessage | InitReceivedMessage
