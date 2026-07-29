-- ============================================================
-- Rent 2 Go — renter deposit rules
-- Paste into the SQL editor and Run. Safe to re-run.
--
-- RULES
--   base deposit                                    $150
--   + out of town  (home address not Charlotte, NC) $150
--   + young renter (age 21–24)                      $150
--   age 25+                                         base only
--   under 21                                        NOT ELIGIBLE
--
-- The renter's typed address gives a provisional figure at sign-up. Stripe
-- Identity then returns a VERIFIED dob and address and the deposit is
-- recalculated from those — so the final bill rests on proof, not claims.
--
-- Implemented as a trigger rather than inside the edge functions so every
-- path (renter-intake, id-verify, id-webhook, an admin edit in renters.html)
-- stays consistent. Nothing can forget to apply it.
--
-- SAFETY: additive columns + two functions + one trigger. No data removed.
-- ============================================================

alter table renters
  add column if not exists dob                 date,     -- as entered at sign-up
  add column if not exists home_address        text,
  add column if not exists home_city           text,
  add column if not exists home_state          text,
  add column if not exists home_postal         text,
  add column if not exists age_years           int,
  add column if not exists is_local            boolean,  -- Charlotte, NC?
  add column if not exists eligibility         text,     -- eligible | under_21 | pending
  add column if not exists deposit_base        numeric default 150,
  add column if not exists deposit_out_of_town numeric default 0,
  add column if not exists deposit_young       numeric default 0,
  add column if not exists deposit_total       numeric,
  add column if not exists deposit_breakdown   jsonb default '{}'::jsonb;

comment on column renters.deposit_total is
  'Computed by trigger from verified dob/address where available, else the typed ones.';
comment on column renters.eligibility is
  'under_21 = must be refused; minimum rental age is 21.';

-- ------------------------------------------------------------
-- The rule, in one place. Callable for testing or quoting a price.
-- ------------------------------------------------------------
create or replace function r2g_deposit_for(p_dob date, p_addr text)
returns jsonb language plpgsql immutable as $$
declare
  v_age int; v_local boolean;
  base numeric := 150; oot numeric := 0; young numeric := 0;
begin
  if p_dob is not null then
    v_age := extract(year from age(current_date, p_dob))::int;
  end if;

  if coalesce(p_addr,'') <> '' then
    v_local := (p_addr ilike '%charlotte%')
           and (p_addr ilike '%NC%' or p_addr ilike '%north carolina%');
  end if;

  if v_local is false then oot := 150; end if;
  if v_age between 21 and 24 then young := 150; end if;

  return jsonb_build_object(
    'base',         base,
    'out_of_town',  oot,
    'young_renter', young,
    'total',        base + oot + young,
    'age',          v_age,
    'is_local',     v_local,
    'eligibility',  case when v_age is null then 'pending'
                         when v_age < 21    then 'under_21'
                         else 'eligible' end
  );
end $$;

-- ------------------------------------------------------------
-- Keep every renter row in step with the rule
-- ------------------------------------------------------------
create or replace function r2g_renter_deposit() returns trigger as $$
declare d jsonb; v_addr text; src text := 'entered';
begin
  if new.verified_dob is not null or nullif(new.verified_address,'') is not null then
    src := 'verified';
  end if;
  v_addr := coalesce(nullif(new.verified_address,''),
                     nullif(concat_ws(', ', new.home_address, new.home_city,
                                            new.home_state, new.home_postal), ''),
                     '');
  d := r2g_deposit_for(coalesce(new.verified_dob, new.dob), v_addr);

  new.age_years           := (d->>'age')::int;
  new.is_local            := (d->>'is_local')::boolean;
  new.deposit_base        := (d->>'base')::numeric;
  new.deposit_out_of_town := (d->>'out_of_town')::numeric;
  new.deposit_young       := (d->>'young_renter')::numeric;
  new.deposit_total       := (d->>'total')::numeric;
  new.eligibility         := d->>'eligibility';
  new.deposit_breakdown   := d || jsonb_build_object('source', src, 'computed_at', now());
  return new;
end $$ language plpgsql;

drop trigger if exists trg_renter_deposit on renters;
create trigger trg_renter_deposit
  before insert or update of dob, verified_dob, home_address, home_city,
                             home_state, home_postal, verified_address
  on renters for each row execute function r2g_renter_deposit();

-- ------------------------------------------------------------
-- Verify the rules behave as intended
-- ------------------------------------------------------------
with cases(scenario, dob, addr) as (values
  ('25+, Charlotte',  date '1990-01-01',                        '900 S Tryon St, Charlotte, NC 28202'),
  ('22, Charlotte',   (current_date - interval '22 years')::date,'900 S Tryon St, Charlotte, NC 28202'),
  ('30, Atlanta',     date '1995-06-01',                        '100 Peachtree St, Atlanta, GA 30303'),
  ('22, Atlanta',     (current_date - interval '22 years')::date,'100 Peachtree St, Atlanta, GA 30303'),
  ('19, Charlotte',   (current_date - interval '19 years')::date,'900 S Tryon St, Charlotte, NC 28202'),
  ('24, Concord NC',  (current_date - interval '24 years')::date,'123 Main St, Concord, NC 28027')
)
select scenario,
       (r2g_deposit_for(dob, addr)->>'total')       as deposit,
       (r2g_deposit_for(dob, addr)->>'age')         as age,
       (r2g_deposit_for(dob, addr)->>'is_local')    as local,
       (r2g_deposit_for(dob, addr)->>'eligibility') as eligibility
from cases;
