-- Phase 6 (F2): permit 'derive' as a topic_operations.operation_type.
-- 'derive' = a user-confirmed COPY of a Topic into another Space (the original
-- Topic is never moved/deleted, so its history stays intact). The TS schema in
-- packages/db/src/schema.ts already declares the union 'merge' | 'split' | 'derive';
-- this migration aligns the runtime DB CHECK constraint, which only listed
-- 'merge'/'split' and rejected the Phase 6 derive writes.

-- Reversible: to roll back, drop the (now renamed) constraint and restore the
-- original two-value CHECK:
--   ALTER TABLE topic_operations
--     DROP CONSTRAINT IF EXISTS topic_operations_operation_type_check;
--   ALTER TABLE topic_operations
--     ADD CONSTRAINT topic_operations_operation_type_check
--       CHECK (operation_type IN ('merge', 'split'));

ALTER TABLE topic_operations
  DROP CONSTRAINT IF EXISTS topic_operations_operation_type_check;
ALTER TABLE topic_operations
  ADD CONSTRAINT topic_operations_operation_type_check
    CHECK (operation_type IN ('merge', 'split', 'derive'));
