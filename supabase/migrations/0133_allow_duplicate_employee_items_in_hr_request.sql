-- Migration 0133: Allow duplicate employee and item lines in HR requests
-- Drops unique (request_id, employee_id, item_id) constraint from public.hr_issue_lines
-- to allow multiple lines with the same employee and item in a single request.

begin;

alter table public.hr_issue_lines
  drop constraint if exists hr_issue_lines_request_id_employee_id_item_id_key;

commit;
