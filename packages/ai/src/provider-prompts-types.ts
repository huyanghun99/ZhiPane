/**
 * P0-6: 共享类型定义，供 prompts.ts 与消费方使用。
 * 单独抽出避免循环依赖（prompts.ts 导入 RoutingAction，wiki.service.ts
 * 也需要这个类型）。
 */

export type RoutingAction =
  | 'update_existing'
  | 'create_emerging'
  | 'attach_as_example'
  | 'keep_as_facet'
  | 'keep_as_reference'
  | 'ignore_duplicate'
  | 'request_review';
