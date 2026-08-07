import { describe, expect, it } from 'vitest';
import {
  isValidTopicTransition,
  markTopicStaleOnSourceUpdate,
  isTopicUserTouched,
  classifySuggestionRisk,
  isLocalOnlyPolicy,
  isAiDisabledPolicy,
  allowsCloudProcessing
} from './domain';

describe('Topic lifecycle state machine', () => {
  it('allows user to accept a suggested topic', () => {
    expect(isValidTopicTransition('suggested', 'accepted')).toBe(true);
  });

  it('allows archiving from any non-archived state', () => {
    expect(isValidTopicTransition('suggested', 'archived')).toBe(true);
    expect(isValidTopicTransition('accepted', 'archived')).toBe(true);
    expect(isValidTopicTransition('user_edited', 'archived')).toBe(true);
    expect(isValidTopicTransition('stale', 'archived')).toBe(true);
  });

  it('allows editing an accepted topic to user_edited', () => {
    expect(isValidTopicTransition('accepted', 'user_edited')).toBe(true);
  });

  it('allows accepted/user_edited to go stale on source update', () => {
    expect(isValidTopicTransition('accepted', 'stale')).toBe(true);
    expect(isValidTopicTransition('user_edited', 'stale')).toBe(true);
  });

  it('allows stale to return to accepted or user_edited', () => {
    expect(isValidTopicTransition('stale', 'accepted')).toBe(true);
    expect(isValidTopicTransition('stale', 'user_edited')).toBe(true);
  });

  it('rejects skipping the accept step (suggested -> user_edited)', () => {
    expect(isValidTopicTransition('suggested', 'user_edited')).toBe(false);
  });

  it('rejects direct transition from suggested to stale', () => {
    expect(isValidTopicTransition('suggested', 'stale')).toBe(false);
  });

  it('rejects transition from archived to stale', () => {
    expect(isValidTopicTransition('archived', 'stale')).toBe(false);
  });
});

describe('markTopicStaleOnSourceUpdate', () => {
  it('marks accepted as stale', () => {
    expect(markTopicStaleOnSourceUpdate('accepted')).toBe('stale');
  });

  it('marks user_edited as stale', () => {
    expect(markTopicStaleOnSourceUpdate('user_edited')).toBe('stale');
  });

  it('leaves suggested untouched', () => {
    expect(markTopicStaleOnSourceUpdate('suggested')).toBe('suggested');
  });

  it('leaves archived untouched', () => {
    expect(markTopicStaleOnSourceUpdate('archived')).toBe('archived');
  });

  it('leaves stale untouched', () => {
    expect(markTopicStaleOnSourceUpdate('stale')).toBe('stale');
  });
});

describe('isTopicUserTouched', () => {
  it('returns true only for user_edited', () => {
    expect(isTopicUserTouched('user_edited')).toBe(true);
    expect(isTopicUserTouched('accepted')).toBe(false);
    expect(isTopicUserTouched('suggested')).toBe(false);
  });
});

describe('classifySuggestionRisk', () => {
  it('classifies overwrite of user-edited content as high risk', () => {
    expect(classifySuggestionRisk('overwrite_user_edited')).toBe('high');
  });

  it('classifies deletion as high risk', () => {
    expect(classifySuggestionRisk('delete_topic')).toBe('high');
  });

  it('classifies topic update as medium risk', () => {
    expect(classifySuggestionRisk('update_topic')).toBe('medium');
  });

  it('classifies summary update as medium risk', () => {
    expect(classifySuggestionRisk('update_summary')).toBe('medium');
  });

  it('classifies new topic creation as low risk', () => {
    expect(classifySuggestionRisk('create_topic')).toBe('low');
  });

  it('classifies edge addition as low risk', () => {
    expect(classifySuggestionRisk('add_edge')).toBe('low');
  });
});

describe('Space AI privacy policy helpers', () => {
  it('identifies local_only policy', () => {
    expect(isLocalOnlyPolicy('local_only')).toBe(true);
    expect(isLocalOnlyPolicy('cloud_allowed')).toBe(false);
    expect(isLocalOnlyPolicy('inherit_workspace')).toBe(false);
  });

  it('identifies disabled policy', () => {
    expect(isAiDisabledPolicy('disabled')).toBe(true);
    expect(isAiDisabledPolicy('local_only')).toBe(false);
  });

  it('allows cloud processing only for inherit_workspace and cloud_allowed', () => {
    expect(allowsCloudProcessing('inherit_workspace')).toBe(true);
    expect(allowsCloudProcessing('cloud_allowed')).toBe(true);
    expect(allowsCloudProcessing('local_only')).toBe(false);
    expect(allowsCloudProcessing('disabled')).toBe(false);
  });
});
