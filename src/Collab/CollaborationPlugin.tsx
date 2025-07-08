import { useEffect, useState } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { CollabInstance } from "./Collab";

export default function CollaborationPlugin() {
  const [editor] = useLexicalComposerContext();
  const [cursors, setCursors] = useState();
  useEffect(() => {
    editor.setEditable(false);
    const userId = "user_" + Math.floor(Math.random() * 100);
    const collab = new CollabInstance(userId, editor);
    collab.start();
    return () => collab.stop();
  }, [editor]);
  return (
    <>
      <div
        id="highlight"
        style={{
          width: "2px",
          background: "blue",
          opacity: 0.2,
          zIndex: 999,
          position: "absolute",
        }}
      ></div>
    </>
  );
}
