import { sql } from 'drizzle-orm';
import { db } from '../db/client';
import { workspaces, workspaceMembers, spaces, spaceMembers, pages } from '@zhipane/db';
import { env } from '../env';
import { enqueueJob } from './job-runner';
import { extractTextFromProseMirrorJson, tokenizeChineseFriendly } from '../utils/text';

export const WELCOME_CONTENT = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: '欢迎使用 ZhiPane 知织' }] },
    {
      type: 'paragraph',
      content: [{
        type: 'text',
        text: '这是你的第一篇笔记。ZhiPane 是 LLM-first 知识创作系统：写下的内容会自动进入 LLM Wiki 处理队列，并支持语义搜索与带引用的问答。'
      }]
    },
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: '试试这些' }] },
    {
      type: 'bulletList',
      content: [
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '输入 / 唤起命令菜单，插入标题、表格、代码块、流程图等。' }] }] },
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '选中文字会浮出工具栏，可加粗、高亮、改颜色、加链接。' }] }] },
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '直接粘贴或拖拽图片即可上传并插入。' }] }] },
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '编辑会自动保存，无需手动点击保存。' }] }] }
      ]
    },
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: '知识流转' }] },
    {
      type: 'mermaid',
      attrs: { code: 'graph LR\n  A[写作] --> B[自动切块 / 向量化]\n  B --> C[LLM Wiki]\n  B --> D[语义搜索 / Ask]' }
    },
    {
      type: 'callout',
      attrs: { emoji: '💡', color: 'blue' },
      content: [
        {
          type: 'paragraph',
          content: [{
            type: 'text',
            text: '输入 / 唤起命令菜单，还能插入标注(Callout)、折叠(Toggle)、KaTeX 公式、网页嵌入、Draw.io 流程图与 Excalidraw 白板。'
          }]
        }
      ]
    },
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: '支持行内公式，例如质能方程 ' },
        { type: 'mathInline', attrs: { latex: 'E = mc^2' } },
        { type: 'text', text: '，以及块级公式：' }
      ]
    },
    { type: 'mathBlock', attrs: { latex: '\\int_{a}^{b} f(x)\\,dx = F(b) - F(a)' } },
    {
      type: 'drawio',
      attrs: { xml: '', preview: '' }
    },
    {
      type: 'excalidraw',
      attrs: { elements: [], appState: {}, files: {}, preview: '' }
    },
    {
      type: 'paragraph',
      content: [{
        type: 'text',
        text: '保存后稍候，切到「搜索」用语义模式，或「Ask」提问，即可看到带引用的回答。'
      }]
    }
  ]
} as const;

/**
 * Creates a default workspace + space + welcome page for a user who does not
 * belong to any workspace yet. Idempotent: if the user already has a workspace
 * membership it returns null and does nothing. Used both on registration and
 * on-demand (e.g. an existing account created before auto-provisioning existed).
 */
export async function provisionDefaultWorkspace(userId: string, userName: string): Promise<{ workspace: typeof workspaces.$inferSelect; space: typeof spaces.$inferSelect } | null> {
  const existing = await db.execute<{ workspace_id: string }>(
    sql`SELECT workspace_id FROM workspace_members WHERE user_id = ${userId} LIMIT 1`
  );
  if (existing.rows.length > 0) return null;

  const [workspace] = await db.insert(workspaces).values({
    name: `${userName} 的知识库`,
    embeddingDimension: env.EMBEDDING_DIMENSION,
    embeddingModel: env.AI_EMBEDDING_MODEL
  }).returning();
  await db.insert(workspaceMembers).values({ workspaceId: workspace.id, userId, role: 'owner' });

  const [space] = await db.insert(spaces).values({
    workspaceId: workspace.id,
    name: '快速开始',
    aiPrivacyPolicy: 'inherit_workspace'
  }).returning();
  await db.insert(spaceMembers).values({ spaceId: space.id, userId, role: 'admin' });

  const welcomeText = extractTextFromProseMirrorJson(WELCOME_CONTENT);
  const [page] = await db.insert(pages).values({
    workspaceId: workspace.id,
    spaceId: space.id,
    title: '欢迎使用 ZhiPane',
    contentJson: WELCOME_CONTENT,
    textContent: welcomeText,
    ftsTokens: tokenizeChineseFriendly(`欢迎使用 ZhiPane\n${welcomeText}`),
    createdById: userId,
    updatedById: userId,
    llmProcessStatus: 'pending',
    llmDirtyReason: 'page_created'
  }).returning();
  await enqueueJob({ workspaceId: workspace.id, spaceId: space.id, entityType: 'page', entityId: page.id, type: 'page.process_llm', runAfterSeconds: 30 });

  return { workspace, space };
}
