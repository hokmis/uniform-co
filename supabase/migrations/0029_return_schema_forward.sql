-- Forward schema patch for environments that already applied 0005.
alter table public.return_lines add column if not exists line_no integer;
with numbered as (
  select id, row_number() over (partition by return_note_id order by id)::integer as n
  from public.return_lines
)
update public.return_lines r
set line_no = numbered.n
from numbered
where numbered.id = r.id and r.line_no is null;
alter table public.return_lines alter column line_no set not null;
alter table public.return_lines drop constraint if exists return_lines_return_note_id_line_no_key;
alter table public.return_lines add constraint return_lines_return_note_id_line_no_key unique (return_note_id, line_no);
