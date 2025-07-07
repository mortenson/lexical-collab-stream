import {
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $getState,
  $isElementNode,
  $isRangeSelection,
  EditorState,
  LexicalEditor,
  LexicalNode,
  NodeKey,
  NodeMutation,
} from "lexical";
import {
  $createSyncParagraphNode,
  $createSyncTextNode,
  getNodeSyncId,
  SerializedSyncParagraphNode,
  SerializedSyncTextNode,
  SYNC_ID_UNSET,
  syncIdState,
  SyncParagraphNode,
  SyncTextNode,
} from "./Nodes";
import { $dfs } from "@lexical/utils";
import { SerializedSyncNode, SyncMessage } from "./Messages";

export const SYNC_TAG = "SYNC_TAG";
export const CLOSE_INTENTIONAL_CODE = 3001;

// Splits TextNodes every time the user types a space.
// This allows users to edit one paragraph without (as many) conflicts.
export const wordSplitTransform = (node: SyncTextNode): void => {
  const text = node.getTextContent();
  if (text.length <= 1) {
    return;
  }
  // Did the user just type (or visit) a space? Split the text to create more nodes.
  const selection = $getSelection();
  let spaceIndex = -1;
  if (
    $isRangeSelection(selection) &&
    selection.anchor.key === node.getKey() &&
    selection.anchor.offset <= text.length &&
    text[selection.anchor.offset - 1] === " "
  ) {
    spaceIndex = selection.anchor.offset - 1;
  }
  if (spaceIndex === -1) {
    return;
  }
  node.splitText(spaceIndex);
};

export class CollabInstance {
  syncIdToNodeKey: Map<string, NodeKey>;
  nodeKeyToSyncId: Map<NodeKey, string>;
  mapsInitialized: boolean;
  editor: LexicalEditor;
  ws?: WebSocket;
  removeListenerCallbacks: (() => void)[];
  reconnectInterval?: NodeJS.Timeout;

  userId: string;

  lastId?: string;

  messageStack: SyncMessage[];

  constructor(userId: string, editor: LexicalEditor) {
    this.editor = editor;
    this.userId = userId;
    this.syncIdToNodeKey = new Map();
    this.nodeKeyToSyncId = new Map();
    this.mapsInitialized = false;
    this.messageStack = [];
    this.removeListenerCallbacks = [];
  }

  start() {
    clearInterval(this.reconnectInterval);
    if (this.ws) {
      this.ws.close();
    }
    this.removeListenerCallbacks = [
      this.editor.registerMutationListener(
        SyncParagraphNode,
        this.onMutation.bind(this),
      ),
      this.editor.registerMutationListener(
        SyncTextNode,
        this.onMutation.bind(this),
      ),
      this.editor.registerNodeTransform(SyncTextNode, wordSplitTransform),
    ];
    this.ws = new WebSocket("ws://127.0.0.1:9045");
    this.ws.addEventListener("error", (error) => {
      console.log(error);
      this.ws?.close();
    });
    this.ws.addEventListener("open", () => this.flushStack());
    this.ws.addEventListener("message", this.onMessage.bind(this));

    this.reconnectInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === this.ws.CLOSED) {
        console.log("websocket closed, reconnecting...");
        this.start();
      }
    }, 1000);
  }

  stop() {
    clearInterval(this.reconnectInterval);
    if (this.ws) {
      this.ws.close();
    }
    this.removeListenerCallbacks.forEach((f) => f());
  }

  mapSyncIdToNodeKey(syncId: string, nodeKey: NodeKey) {
    if (nodeKey === "root") {
      console.error(`Attempted to record root ID ${syncId} => ${nodeKey}`);
      return;
    }
    if (syncId === SYNC_ID_UNSET) {
      console.error(`Attempted to set default value ${syncId} => ${nodeKey}`);
      return;
    }
    const knownNode = this.syncIdToNodeKey.get(syncId);
    if (!knownNode) {
      this.syncIdToNodeKey.set(syncId, nodeKey);
      this.nodeKeyToSyncId.set(nodeKey, syncId);
    } else if (knownNode !== nodeKey) {
      console.error(
        `Duplicate node keys exist for ${syncId}: mapped=${knownNode}, found=${nodeKey}`,
      );
      return;
    }
  }

  getNodeBySyncId(syncId: string): LexicalNode | undefined {
    if (!this.mapsInitialized) {
      $dfs().forEach((dfsNode) => {
        if (dfsNode.node.getKey() === "root") {
          return;
        }
        this.mapSyncIdToNodeKey(
          $getState(dfsNode.node, syncIdState),
          dfsNode.node.getKey(),
        );
      });
      this.mapsInitialized = true;
    }
    const nodeKey = this.syncIdToNodeKey.get(syncId);
    if (!nodeKey) {
      return;
    }
    const node = $getNodeByKey(nodeKey);
    if (!node) {
      return;
    }
    return node;
  }

  flushStack() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    this.ws.send(JSON.stringify(this.messageStack));
    this.messageStack = [];
  }

  onMutation(
    nodes: Map<NodeKey, NodeMutation>,
    {
      updateTags,
    }: {
      updateTags: Set<string>;
      dirtyLeaves: Set<string>;
      prevEditorState: EditorState;
    },
  ) {
    if (updateTags.has(SYNC_TAG)) {
      return;
    }
    this.editor.read(() => {
      nodes.forEach((mutation, nodeKey) => {
        switch (mutation) {
          case "created":
          case "updated":
            const node = $getNodeByKey(nodeKey);
            if (!node) {
              console.error(`Node not found ${nodeKey}`);
              return;
            }
            const syncId = $getState(node, syncIdState);
            if (syncId === SYNC_ID_UNSET) {
              console.error(`Node does not have sync ID ${nodeKey}`);
              return;
            }
            this.mapSyncIdToNodeKey(syncId, nodeKey);
            const previous = node.getPreviousSibling();
            const next = node.getNextSibling();
            const parent = node.getParent();
            this.messageStack.push({
              type: "upserted",
              userId: this.userId,
              node: node.exportJSON() as SerializedSyncNode,
              previousId: previous ? getNodeSyncId(previous) : undefined,
              nextId: next ? getNodeSyncId(next) : undefined,
              parentId: parent ? getNodeSyncId(parent) : undefined,
            });
            break;
          case "destroyed":
            const destroyedSyncId = this.nodeKeyToSyncId.get(nodeKey);
            if (!destroyedSyncId) {
              console.error(
                `Node key never mapped for destroy message: ${nodeKey}`,
              );
              return;
            }
            this.messageStack.push({
              type: "destroyed",
              userId: this.userId,
              syncId: destroyedSyncId,
            });
            break;
        }
      });
      this.flushStack();
    });
  }

  onMessage(wsMessage: MessageEvent) {
    this.editor.update(
      () => {
        const message: SyncMessage = JSON.parse(wsMessage.data);
        // Ignore own messages.
        if ("userId" in message && message.userId === this.userId) {
          return;
        }
        switch (message.type) {
          case "init":
            this.lastId = message.lastId;
            const editorState = this.editor.parseEditorState(
              message.editorState,
            );
            if (!editorState.isEmpty()) {
              this.editor.setEditorState(editorState);
            }
            this.ws?.send(
              JSON.stringify([
                {
                  type: "init-received",
                  lastId: message.lastId,
                },
              ]),
            );
            this.editor.setEditable(true);
            break;
          case "upserted":
            if (message.id) {
              this.lastId = message.id;
            }
            // Update
            const nodeToUpdate = this.getNodeBySyncId(message.node.syncId);
            if (nodeToUpdate) {
              nodeToUpdate.updateFromJSON(message.node);
              return;
            }
            // Insert
            let messageNode: LexicalNode;
            switch (message.node.type) {
              case "sync-paragraph":
                messageNode = $createSyncParagraphNode().updateFromJSON(
                  message.node as SerializedSyncParagraphNode,
                );
                break;
              case "sync-text":
                messageNode = $createSyncTextNode().updateFromJSON(
                  message.node as SerializedSyncTextNode,
                );
                break;
              default:
                console.error(`Got unknown type ${message.node.type}`);
                return;
            }
            // @todo: Handle out of order inserts, maybe on the server
            if (message.previousId) {
              const previousNode = this.getNodeBySyncId(message.previousId);
              if (!previousNode) {
                console.error(`Previous key not found: ${message.previousId}`);
                return;
              }
              previousNode.insertAfter(messageNode);
              this.mapSyncIdToNodeKey(
                message.node.syncId,
                messageNode.getKey(),
              );
            } else if (message.nextId) {
              const nextNode = this.getNodeBySyncId(message.nextId);
              if (!nextNode) {
                console.error(`Next key not found: ${message.nextId}`);
                return;
              }
              nextNode.insertBefore(messageNode);
              this.mapSyncIdToNodeKey(
                message.node.syncId,
                messageNode.getKey(),
              );
            } else if (message.parentId) {
              const parentNode = this.getNodeBySyncId(message.parentId);
              if (!parentNode) {
                console.error(`Parent key not found: ${message.parentId}`);
                return;
              }
              if (!$isElementNode(parentNode)) {
                console.error(
                  `Parent is not an element node, can't append to ${message.parentId}`,
                );
                return;
              }
              parentNode.append(messageNode);
              this.mapSyncIdToNodeKey(
                message.node.syncId,
                messageNode.getKey(),
              );
            } else {
              if (messageNode.getType() === "sync-text") {
                console.error("text nodes cannot be appended to root");
                return;
              }
              $getRoot().append(messageNode);
              this.mapSyncIdToNodeKey(
                message.node.syncId,
                messageNode.getKey(),
              );
            }
            break;
          case "destroyed":
            if (message.id) {
              this.lastId = message.id;
            }
            const nodeToDestroy = this.getNodeBySyncId(message.syncId);
            if (!nodeToDestroy) {
              console.error(`Destroy key not found: ${message.syncId}`);
              return;
            }
            nodeToDestroy.remove(true);
            break;
          default:
            console.error(`Unknown message type: ${wsMessage.data}`);
            return;
        }
      },
      { tag: SYNC_TAG },
    );
  }
}
