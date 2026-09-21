-- Read-path index for the durable import worker queue.
-- list_import_work() filters to non-terminal batches and returns the oldest
-- work first. Keep terminal rows out of the index so normal retention history
-- does not increase the worker's queue scan or write cost.

create index if not exists import_batches_work_queue_idx
  on public.import_batches (created_at, id)
  where status in (
    'AWAITING_UPLOAD', 'UPLOADED', 'PARSING',
    'VALIDATING', 'VALIDATED', 'APPLYING'
  );
