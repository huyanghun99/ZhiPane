import { describe, expect, it } from 'vitest';
import { countWords, extractText } from './prosemirror';

describe('extractText', () => {
  it('extracts plain text from a ProseMirror doc', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: '标题' }] },
        { type: 'paragraph', content: [{ type: 'text', text: '这是关于机器学习的笔记。' }] }
      ]
    };
    const text = extractText(doc);
    expect(text).toContain('标题');
    expect(text).toContain('这是关于机器学习的笔记。');
  });

  it('returns empty string for empty doc', () => {
    expect(extractText({ type: 'doc', content: [{ type: 'paragraph' }] })).toBe('');
    expect(extractText(null)).toBe('');
  });

  it('separates block nodes with newlines', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: '第一段' }] },
        { type: 'paragraph', content: [{ type: 'text', text: '第二段' }] }
      ]
    };
    expect(extractText(doc)).toBe('第一段\n第二段');
  });
});

describe('countWords', () => {
  it('counts CJK characters individually', () => {
    expect(countWords('机器学习')).toBe(4);
  });

  it('counts latin words by group', () => {
    expect(countWords('hello world foo')).toBe(3);
  });

  it('mixes cjk and latin', () => {
    expect(countWords('学习 machine learning')).toBe(4);
  });

  it('returns 0 for empty', () => {
    expect(countWords('')).toBe(0);
  });
});
