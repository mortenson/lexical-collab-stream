
import { useEffect } from 'react';
import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import { $createSyncParagraphNode, $createSyncTextNode, SerializedSyncParagraphNode, SerializedSyncTextNode, SYNC_ID_UNSET, syncIdState, SyncParagraphNode, SyncTextNode } from '../Nodes';
import { $getNodeByKey, $getRoot, $getState, $isElementNode, LexicalNode, MutationListener, NodeKey, NodeMutation } from 'lexical';
import { SerializedSyncNode, SyncMessage } from '../Messages';
import { $dfs } from '@lexical/utils';

const getNodeSyncId = (node: LexicalNode): string | undefined => {
  const syncId = $getState(node, syncIdState)
  if (syncId === SYNC_ID_UNSET) {
    return
  }
  return syncId
}

export default function CollaborationPlugin() {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    editor.setEditable(false)

    const userId = "user_" + Math.floor(Math.random() * 100);
    // Connect to server
    // @todo: block editing until conencted
    const ws = new WebSocket('ws://127.0.0.1:9045');
    // Map of Sync IDs (UUIDs) to local NodeKeys
    const syncIdToNodeKey: Map<string, NodeKey> = new Map();
    const nodeKeyToSyncId: Map<NodeKey, string> = new Map();
    const mapSyncIdToNodeKey = (syncId: string, nodeKey: NodeKey) => {
      console.log(`${syncId} => ${nodeKey}`)
      if (nodeKey === 'root') {
        console.error(`Attempted to record root ID ${syncId} => ${nodeKey}`)
        return
      }
      if (syncId === SYNC_ID_UNSET) {
        console.error(`Attempted to set default value ${syncId} => ${nodeKey}`)
        return
      }
      const knownNode = syncIdToNodeKey.get(syncId)
      if (!knownNode) {
        syncIdToNodeKey.set(syncId, nodeKey)
        nodeKeyToSyncId.set(nodeKey, syncId)
      } else if (knownNode !== nodeKey) {
        console.error(`Duplicate node keys exist for ${syncId}: mapped=${knownNode}, found=${nodeKey}`)
        return
      }
    }
    const getNodeBySyncId = (syncId: string): LexicalNode | undefined => {
      const nodeKey = syncIdToNodeKey.get(syncId)
      if (!nodeKey) {
        return
      }
      const node = $getNodeByKey(nodeKey)
      if (!node) {
        return
      }
      return node
    }
    // Store of local mutations.
    let messageStack: SyncMessage[] = [];
    const flushStack = () => {
      if (ws.readyState !== WebSocket.OPEN) {
        return
      }
      ws.send(JSON.stringify(messageStack))
      messageStack = []
    }
    let isSyncing = false
    const mutationListener: MutationListener = (nodes: Map<NodeKey, NodeMutation>, payload): void => {
      if (isSyncing) {
        return
      }
      editor.read(() => {
        nodes.forEach((mutation, nodeKey) => {
          console.log(mutation, nodeKey)
          switch (mutation) {
            case 'created':
            case 'updated':
              const node = $getNodeByKey(nodeKey)
              if (!node) {
                return
              }
              const syncId = $getState(node, syncIdState)
              if (syncId === SYNC_ID_UNSET) {
                return
              }
              const previous = node.getPreviousSibling()
              const next = node.getNextSibling()
              const parent = node.getParent()
              messageStack.push({
                type: 'upserted',
                userId: userId,
                node: node.exportJSON() as SerializedSyncNode,
                previousId: previous ? getNodeSyncId(previous) : undefined,
                nextId: next ? getNodeSyncId(next) : undefined,
                parentId: parent ? getNodeSyncId(parent) : undefined,
              })
              break
            case 'destroyed':
              const destroyedSyncId = nodeKeyToSyncId.get(nodeKey)
              if (!destroyedSyncId) {
                console.error(`Node key never mapped for destroy message: ${nodeKey}`)
                return
              }
              messageStack.push({
                type: 'destroyed',
                userId: userId,
                syncId: destroyedSyncId,
              })
              break
          }
        })
        flushStack()
      })
    }
    // Listen to mutations.
    const cleanupListeners: (() => void)[] = []
    cleanupListeners.push(editor.registerMutationListener(SyncParagraphNode, mutationListener))
    cleanupListeners.push(editor.registerMutationListener(SyncTextNode, mutationListener))
    ws.addEventListener('error', console.error);
    ws.addEventListener('open', () => flushStack());
    ws.addEventListener('message', wsMessage => {
      isSyncing = true
      editor.update(() => {
        const message: SyncMessage = JSON.parse(wsMessage.data)
        // Ignore own messages.
        if ('userId' in message && message.userId === userId) {
          return
        }
        switch (message.type) {
          case 'init':
            editor.setEditorState(editor.parseEditorState(message.editorState))
            $dfs().forEach(dfsNode => {
              mapSyncIdToNodeKey($getState(dfsNode.node, syncIdState), dfsNode.node.getKey())
            })
            editor.setEditable(true)
            break
          case 'upserted':
            // Update
            const nodeToUpdate = getNodeBySyncId(message.node.syncId)
            if (nodeToUpdate) {
              nodeToUpdate.updateFromJSON(message.node)
              return
            }
            // Insert
            let messageNode: LexicalNode
            switch (message.node.type) {
              case 'sync-paragraph':
                messageNode = $createSyncParagraphNode().updateFromJSON(message.node as SerializedSyncParagraphNode)
                break
              case 'sync-text':
                messageNode = $createSyncTextNode().updateFromJSON(message.node as SerializedSyncTextNode)
                break
              default:
                console.error(`Got unknown type ${message.node.type}`)
                return
            }
            // @todo: Handle out of order inserts, maybe on the server
            if (message.previousId) {
              const previousNode = getNodeBySyncId(message.previousId)
              if (!previousNode) {
                console.error(`Previous key not found: ${message.previousId}`)
                return
              }
              previousNode.insertAfter(messageNode)
              mapSyncIdToNodeKey(message.node.syncId, messageNode.getKey())
            } else if (message.nextId) {
              const nextNode = getNodeBySyncId(message.nextId)
              if (!nextNode) {
                console.error(`Next key not found: ${message.nextId}`)
                return
              }
              nextNode.insertBefore(messageNode)
              mapSyncIdToNodeKey(message.node.syncId, messageNode.getKey())
            } else if (message.parentId) {
              const parentNode = getNodeBySyncId(message.parentId)
              if (!parentNode) {
                console.error(`Parent key not found: ${message.parentId}`)
                return
              }
              if (!$isElementNode(parentNode)) {
                console.error(`Parent is not an element node, can't append to ${message.parentId}`)
                return
              }
              parentNode.append(messageNode)
              mapSyncIdToNodeKey(message.node.syncId, messageNode.getKey())
            } else {
              if (messageNode.getType() === 'sync-text') {
                console.error('text nodes cannot be appended to root')
                return
              }
              $getRoot().append(messageNode)
              mapSyncIdToNodeKey(message.node.syncId, messageNode.getKey())
            }
            break
          case 'destroyed':
            const nodeToDestroy = getNodeBySyncId(message.syncId)
            if (!nodeToDestroy) {
              console.error(`Destroy key not found: ${message.syncId}`)
              return
            }
            nodeToDestroy.remove(true)
            break
          default:
            console.error(`Unknown message type: ${wsMessage.data}`)
            return
        }
      }, { onUpdate: () => isSyncing = false })
    });
    return () => {
      cleanupListeners.forEach(f => f())
      ws.close()
    }
  }, [editor])
  return <></>
}
