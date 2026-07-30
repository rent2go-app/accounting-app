-- Recovery scheduler.
--
-- Disconnection already tracks the starter signal, grace and restore. What was
-- missing is the step after: when a customer does not pay, does not respond and
-- the car has to be physically collected. That was only ever a free-text note in
-- "Action taken", so nothing showed WHEN a recovery was booked, WHO was going,
-- or whether it actually happened.
--
-- Recovery is keyed the same way as disconnection (account_label + customer_id),
-- so it rides on the existing row rather than needing a second table and a
-- second join.

alter table linda_disconnections
  add column if not exists recovery_status       text,           -- scheduled | en_route | recovered | cancelled
  add column if not exists recovery_scheduled_at timestamptz,    -- when the crew is due
  add column if not exists recovery_location     text,           -- where the car is expected to be
  add column if not exists recovery_assignee     text,           -- who is collecting it
  add column if not exists recovery_reason       text,
  add column if not exists recovery_notes        text,
  add column if not exists recovery_created_at   timestamptz,    -- when it was booked
  add column if not exists recovered_at          timestamptz;    -- when the car was actually taken back

-- Only the four states the UI can produce; anything else is a bug, not data.
do $$
begin
  if not exists (select 1 from pg_constraint where conname='linda_disc_recovery_status_ck') then
    alter table linda_disconnections
      add constraint linda_disc_recovery_status_ck
      check (recovery_status is null or recovery_status in ('scheduled','en_route','recovered','cancelled'));
  end if;
end $$;

-- The scheduler's working list: anything booked and not yet closed out.
create index if not exists linda_disc_recovery_open_idx
  on linda_disconnections (recovery_scheduled_at)
  where recovery_status in ('scheduled','en_route');

select count(*) as rows_on_table,
       count(*) filter (where recovery_status is not null) as with_a_recovery
from linda_disconnections;
