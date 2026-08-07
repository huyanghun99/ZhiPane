import { Extension } from '@tiptap/core';

export interface EditorKeymapOptions {
  /** Cmd/Ctrl+S — manual save. */
  onSave: () => void;
  /** Cmd/Ctrl+K with a non-empty selection — edit link. */
  onLink: () => void;
}

/**
 * Editor keyboard shortcuts (Phase 3 — task 6).
 *
 *  - Mod-s          → manual save (prevents the browser Save dialog)
 *  - Mod-Shift-k    → code block
 *  - Mod-k          → link editor when text is selected (otherwise falls
 *                     through so the global Command Palette can open)
 *  - Mod-/          → open the slash menu at the cursor
 *  - Tab / Shift-Tab→ indent / outdent list items
 */
export const EditorKeymap = Extension.create<EditorKeymapOptions>({
  name: 'editorKeymap',

  addOptions() {
    return { onSave: () => {}, onLink: () => {} };
  },

  addKeyboardShortcuts() {
    return {
      'Mod-s': () => {
        this.options.onSave();
        return true;
      },
      'Mod-Shift-k': () => this.editor.chain().focus().toggleCodeBlock().run(),
      'Mod-k': () => {
        if (this.editor.state.selection.empty) return false; // let the palette open
        this.options.onLink();
        return true;
      },
      'Mod-/': () => this.editor.chain().focus().insertContent('/').run(),
      Tab: () => {
        if (this.editor.isActive('listItem')) return this.editor.chain().focus().sinkListItem('listItem').run();
        if (this.editor.isActive('taskItem')) return this.editor.chain().focus().sinkListItem('taskItem').run();
        return false;
      },
      'Shift-Tab': () => {
        if (this.editor.isActive('listItem')) return this.editor.chain().focus().liftListItem('listItem').run();
        if (this.editor.isActive('taskItem')) return this.editor.chain().focus().liftListItem('taskItem').run();
        return false;
      }
    };
  }
});
