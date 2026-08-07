/**
 * AI text actions (Phase 3).
 *
 * The BubbleMenu (on a text selection) and the Slash menu (AI group) both
 * run one of these actions. There is no dedicated text-transform endpoint on
 * the server (and the backend must not change for this phase), so we reuse the
 * existing RAG streaming endpoint: the instruction dominates the prompt and we
 * scope retrieval to the current page so any context stays relevant.
 */
export type AiActionKind = 'polish' | 'translate' | 'summarize' | 'explain' | 'continue';

export interface AiActionDef {
  kind: AiActionKind;
  label: string;
  icon: string;
  /** Whether replacing the source selection is a sensible primary action. */
  canReplace: boolean;
  buildPrompt: (text: string) => string;
}

const wrap = (t: string) => `"""\n${t.trim()}\n"""`;

export const AI_ACTIONS: Record<AiActionKind, AiActionDef> = {
  polish: {
    kind: 'polish',
    label: '润色',
    icon: '✨',
    canReplace: true,
    buildPrompt: (t) =>
      `请润色下面这段文字，保持原意并使表达更流畅、自然、专业。只输出润色后的文本本身，不要添加任何解释、前后缀或引用标注。\n\n${wrap(t)}`
  },
  translate: {
    kind: 'translate',
    label: '翻译',
    icon: '🌐',
    canReplace: true,
    buildPrompt: (t) =>
      `请翻译下面这段文字：如果是中文就翻译成地道的英文，如果是其他语言就翻译成流畅的中文。只输出译文本身，不要添加任何解释或引用标注。\n\n${wrap(t)}`
  },
  summarize: {
    kind: 'summarize',
    label: '总结',
    icon: '📋',
    canReplace: false,
    buildPrompt: (t) =>
      `请用简洁的中文总结下面内容的核心要点，可用短句或要点列表。只输出总结本身，不要添加任何解释或引用标注。\n\n${wrap(t)}`
  },
  explain: {
    kind: 'explain',
    label: '解释',
    icon: '💬',
    canReplace: false,
    buildPrompt: (t) =>
      `请用通俗易懂的中文解释下面的内容，帮助读者理解其含义。只输出解释本身，不要添加任何引用标注。\n\n${wrap(t)}`
  },
  continue: {
    kind: 'continue',
    label: '续写',
    icon: '✍️',
    canReplace: false,
    buildPrompt: (t) =>
      `请在下面这段内容之后继续写作，保持风格、语气和主题一致。只输出你新续写的内容，不要重复原文，也不要添加任何解释或引用标注。\n\n${wrap(t)}`
  }
};

/** Actions offered on a text selection in the bubble menu. */
export const BUBBLE_AI_ACTIONS: AiActionKind[] = ['polish', 'translate', 'summarize', 'explain'];
