
import { useEffect } from 'react';
import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import { SyncParagraphNode, SyncTextNode } from '../Nodes';
import { EditorState, MutationListener, NodeKey, NodeMutation } from 'lexical';

const mutationListener: MutationListener = (nodes: Map<NodeKey, NodeMutation>, payload: {
    updateTags: Set<string>;
    dirtyLeaves: Set<string>;
    prevEditorState: EditorState;
}): void => {
  console.log(nodes, payload)
}

export default function CollaborationPlugin() {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    editor.registerMutationListener(SyncParagraphNode, mutationListener)
    editor.registerMutationListener(SyncTextNode, mutationListener)
  }, [editor])
  return <></>
}
