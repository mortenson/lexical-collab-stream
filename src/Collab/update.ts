import { $getNodeByKey, EditorState, NodeKey } from "lexical";
import { isSerializedSyncNode, UpdatedMessage } from "./Messages";
import { $getNodeBySyncId, SyncIdMap } from "./SyncIdMap";
import { $applyCreatedMessage, $createNodeMessageBase } from "./create";
import { $getNodeSyncId } from "./nodeState";
import { exportNonLatestJSON } from "./exportNonLatestJSON";

export const $applyUpdatedMessage = (
  map: SyncIdMap,
  message: UpdatedMessage,
) => {
  if (!isSerializedSyncNode(message.node)) {
    console.error(`Node is of unknown type: ${JSON.stringify(message.node)}`);
    return;
  }
  const node = $getNodeBySyncId(map, message.node.$.syncId);
  if (!node) {
    console.error(`Update key not found: ${message.node.$.syncId}`);
    return;
  }
  // Check if the node moved, which for some reason isn't performed as a
  // destroy -> create in Lexical
  const parent = node.getParent();
  const parentSyncId = parent ? $getNodeSyncId(parent) : undefined;
  if (parentSyncId && message.parentId && parentSyncId !== message.parentId) {
    map.delete(message.node.$.syncId);
    node.remove(true);
    $applyCreatedMessage(map, message);
  } else {
    node.updateFromJSON(message.node);
  }
};

export const $reverseUpdatedMessage = (
  map: SyncIdMap,
  message: UpdatedMessage,
) => {
  if (!isSerializedSyncNode(message.node)) {
    console.error(`Node is of unknown type: ${JSON.stringify(message.node)}`);
    return;
  }
  const nodeToUpdate = $getNodeBySyncId(map, message.node.$.syncId);
  if (nodeToUpdate) {
    nodeToUpdate.updateFromJSON(message.previousNode);
    return;
  }
};

export const $createUpdatedMessage = (
  map: SyncIdMap,
  prevEditorState: EditorState,
  nodeKey: NodeKey,
  userId: string,
): UpdatedMessage | undefined => {
  const message = $createNodeMessageBase(map, nodeKey, userId);
  if (message) {
    const previousNode = $getNodeByKey(nodeKey, prevEditorState);
    return {
      type: "updated",
      // @ts-ignore
      previousNode: previousNode
        ? exportNonLatestJSON(previousNode)
        : undefined,
      ...message,
    };
  }
};
