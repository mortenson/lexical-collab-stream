import { SerializedEditorState } from "lexical"
import { SerializedSyncParagraphNode, SerializedSyncTextNode } from "./Nodes"

export type SerializedSyncNode = SerializedSyncTextNode | SerializedSyncParagraphNode

interface  UpsertedMessage {
  type: 'upserted'
  userId: string
  node: SerializedSyncNode
  previousId?: string
  nextId?: string
  parentId?: string
}

interface  DestroyedMessage {
  type: 'destroyed'
  userId: string
  syncId: string
}

interface InitMessage {
  type: 'init'
  editorState: SerializedEditorState
}

export type SyncMessage = UpsertedMessage | DestroyedMessage | InitMessage
