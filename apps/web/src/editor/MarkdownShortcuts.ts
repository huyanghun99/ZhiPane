import { Extension, InputRule, wrappingInputRule } from '@tiptap/core';

/**
 * Markdown shortcut input (Phase4 — task 5).
 *
 * StarterKit already ships the common markdown input rules (# / ## / ###,
 * > , - , 1. , ``` , --- , **bold** , *italic* , ~~strike~~ ,
 * `code` and the TaskList [ ] rule). We add the one common variant
 * StarterKit omits: an ordered list triggered by a parenthesis, e.g. "1) ".
 */
export const MarkdownShortcuts = Extension.create({
  name: 'markdownShortcuts',

  addInputRules() {
    const orderedList = this.editor?.schema.nodes.orderedList;
    const rules: InputRule[] = [];
    if (orderedList) {
      rules.push(
        wrappingInputRule({
          find: /^\s*(\d+)\)\s$/,
          type: orderedList,
          getAttributes: () => ({ start: 1 })
        })
      );
    }
    // A bare "* " sometimes collides with emphasis; ensure it still makes a list.
    rules.push(
      new InputRule({
        find: /^\s*\*\s$/,
        handler: ({ state, range }) => {
          const editor = this.editor;
          if (!editor) return;
          editor.view.dispatch(state.tr.delete(range.from, range.to));
          editor.chain().focus().toggleBulletList().run();
        }
      })
    );
    return rules;
  }
});
