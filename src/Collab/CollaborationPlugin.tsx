import { useEffect } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { CollabInstance } from "./Collab";

export default function CollaborationPlugin() {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    editor.setEditable(false);
    const userId = "user_" + Math.floor(Math.random() * 100);
    const collab = new CollabInstance(userId, editor);
    collab.start();
    return () => collab.stop();
  }, [editor]);
  return <></>;
}
