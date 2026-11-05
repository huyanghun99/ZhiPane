import { describe, expect, it } from 'vitest';
import { applyRagEvent, finishTurn, startTurn } from './chat';
import type { StreamRagEvent } from '@zhipane/shared';

const sources = [{ pageId: 'p1', title: '笔记 A', excerpt: '摘要 A' }];

function turn() {
  return startTurn([], 't1', '这个空间讲了什么？');
}

describe('chat turn state', () => {
  it('appends a user message and a pending assistant message', () => {
    const msgs = turn();
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toMatchObject({ id: 't1:user', role: 'user', content: '这个空间讲了什么？', status: 'done' });
    expect(msgs[1]).toMatchObject({ id: 't1:assistant', role: 'assistant', content: '', status: 'retrieving' });
  });

  it('keeps earlier turns intact when a new one starts', () => {
    const first = applyRagEvent(turn(), 't1:assistant', { type: 'done', answer: '答案一' });
    const second = startTurn(first, 't2', '继续追问');
    expect(second).toHaveLength(4);
    expect(second[1].content).toBe('答案一');
    expect(second[3].status).toBe('retrieving');
  });
});

describe('applyRagEvent', () => {
  it('replaces citations on sources and moves to streaming', () => {
    const msgs = applyRagEvent(turn(), 't1:assistant', { type: 'sources', citations: sources });
    expect(msgs[1]).toMatchObject({ status: 'streaming', citations: sources });
    expect(msgs[0].role).toBe('user');
  });

  it('appends streamed tokens in order', () => {
    let msgs = turn();
    msgs = applyRagEvent(msgs, 't1:assistant', { type: 'token', text: '你好' });
    msgs = applyRagEvent(msgs, 't1:assistant', { type: 'token', text: '，世界' });
    expect(msgs[1].content).toBe('你好，世界');
    expect(msgs[1].status).toBe('streaming');
  });

  it('keeps accumulated tokens when done carries a full answer', () => {
    let msgs = applyRagEvent(turn(), 't1:assistant', { type: 'token', text: '部分' });
    msgs = applyRagEvent(msgs, 't1:assistant', { type: 'done', answer: '完整答案' });
    expect(msgs[1].content).toBe('部分');
    expect(msgs[1].status).toBe('done');
  });

  it('falls back to the done answer when no token arrived', () => {
    const msgs = applyRagEvent(turn(), 't1:assistant', { type: 'done', answer: '直接答案' });
    expect(msgs[1]).toMatchObject({ content: '直接答案', status: 'done' });
  });

  it('merges a single citation at its 1-based index', () => {
    let msgs = applyRagEvent(turn(), 't1:assistant', { type: 'sources', citations: sources });
    const ev: StreamRagEvent = { type: 'citation', index: 2, citation: { pageId: 'p2', title: '笔记 B', excerpt: '摘要 B' } };
    msgs = applyRagEvent(msgs, 't1:assistant', ev);
    expect(msgs[1].citations).toEqual([
      { pageId: 'p1', title: '笔记 A', excerpt: '摘要 A' },
      { pageId: 'p2', title: '笔记 B', excerpt: '摘要 B' }
    ]);
  });

  it('records the error on that message only', () => {
    const msgs = applyRagEvent(
      startTurn(turn(), 't2', '第二问'), 't2:assistant', { type: 'error', message: '限流' }
    );
    expect(msgs[3]).toMatchObject({ status: 'error', error: '限流' });
    expect(msgs[1].status).not.toBe('error');
  });
});

describe('finishTurn', () => {
  it('marks the assistant done when the stream ends', () => {
    const msgs = finishTurn(turn(), 't1:assistant', 'done');
    expect(msgs[1].status).toBe('done');
  });

  it('marks an aborted turn and never overwrites a real error', () => {
    expect(finishTurn(turn(), 't1:assistant', 'aborted')[1].status).toBe('aborted');
    const errored = applyRagEvent(turn(), 't1:assistant', { type: 'error', message: '失败' });
    expect(finishTurn(errored, 't1:assistant', 'done')[1]).toMatchObject({ status: 'error', error: '失败' });
  });

  it('only touches the matching assistant message', () => {
    let msgs = applyRagEvent(turn(), 't1:assistant', { type: 'done', answer: '答案一' });
    msgs = startTurn(msgs, 't2', '第二问');
    msgs = finishTurn(msgs, 't2:assistant', 'aborted');
    expect(msgs[1].status).toBe('done');
    expect(msgs[3].status).toBe('aborted');
  });
});
