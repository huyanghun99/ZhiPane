import type { PMNode } from './prosemirror';

export type PageTemplate = {
  id: string;
  name: string;
  desc: string;
  icon: string;
  title: string;
  contentJson: PMNode;
};

const h = (level: number, text: string): PMNode => ({
  type: 'heading',
  attrs: { level },
  content: text ? [{ type: 'text', text }] : []
});
const p = (text = ''): PMNode => ({
  type: 'paragraph',
  content: text ? [{ type: 'text', text }] : []
});
const bullet = (text: string): PMNode => ({
  type: 'bulletList',
  content: [{ type: 'listItem', content: [p(text)] }]
});

/**
 * Lightweight page templates (Phase 6 — task 2).
 *
 * A template is nothing more than a pre-filled `contentJson` (+ a default
 * title). Creating a page from a template is just `POST /api/pages` with that
 * body — no new backend endpoint, no schema change.
 */
export const PAGE_TEMPLATES: PageTemplate[] = [
  {
    id: 'blank',
    name: '空白页',
    desc: '从零开始写',
    icon: '📄',
    title: '未命名笔记',
    contentJson: { type: 'doc', content: [p()] }
  },
  {
    id: 'meeting',
    name: '会议记录',
    desc: '议程 · 纪要 · 待办',
    icon: '📝',
    title: '会议记录',
    contentJson: {
      type: 'doc',
      content: [
        h(1, '会议记录'),
        p('📅 时间：    📍 地点：    👥 参会人：'),
        h(2, '议程'),
        bullet('议题一'),
        bullet('议题二'),
        h(2, '讨论纪要'),
        p(''),
        h(2, '行动项'),
        {
          type: 'taskList',
          content: [
            { type: 'taskItem', attrs: { checked: false }, content: [p('负责人 — 截止日期：')] },
            { type: 'taskItem', attrs: { checked: false }, content: [p('负责人 — 截止日期：')] }
          ]
        },
        h(2, '下次会议'),
        p('')
      ]
    }
  },
  {
    id: 'reading',
    name: '读书笔记',
    desc: '摘录 · 感悟 · 书单',
    icon: '📚',
    title: '读书笔记',
    contentJson: {
      type: 'doc',
      content: [
        h(1, '《书名》'),
        p('✍️ 作者：    ⭐ 评分：'),
        h(2, '一句话总结'),
        p(''),
        h(2, '核心观点'),
        bullet('观点一'),
        bullet('观点二'),
        h(2, '精彩摘录'),
        { type: 'blockquote', content: [p('在此粘贴书中原句…')] },
        h(2, '我的思考'),
        p('')
      ]
    }
  },
  {
    id: 'tech',
    name: '技术方案',
    desc: '背景 · 设计 · 风险',
    icon: '🛠️',
    title: '技术方案',
    contentJson: {
      type: 'doc',
      content: [
        h(1, '技术方案：'),
        h(2, '背景与目标'),
        p('要解决的问题，以及衡量成功的指标。'),
        h(2, '方案设计'),
        p('核心思路与架构。'),
        h(3, '接口 / 数据结构'),
        p(''),
        h(3, '关键流程'),
        p(''),
        h(2, '取舍与风险'),
        bullet('风险一及应对'),
        bullet('风险二及应对'),
        h(2, '排期'),
        p('')
      ]
    }
  }
];

export function getTemplate(id: string): PageTemplate {
  return PAGE_TEMPLATES.find((t) => t.id === id) ?? PAGE_TEMPLATES[0];
}
