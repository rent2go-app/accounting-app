-- ============================================================
-- Deposit rules, corrected.
--
--   base                     $150
--   home outside metro CLT   +$150   -> $300
--   aged 21-24               +$200   -> $350
--   both                      $350   (the surcharges do NOT stack)
--
-- Only the larger surcharge is applied, and only that one appears in the
-- breakdown — so a renter reading "base $150 + younger renter $200 = $350"
-- sees arithmetic that actually adds up.
-- ============================================================

create or replace function r2g_deposit_for(p_dob date, p_addr text)
returns jsonb language plpgsql stable as $$
declare
  v_age int; v_local boolean := null;
  base numeric := 150; oot numeric := 0; young numeric := 0;
begin
  if p_dob is not null then
    v_age := extract(year from age(current_date, p_dob))::int;
  end if;
  v_local := r2g_is_local(p_addr);
  if v_local is false then oot := 150; end if;
  if v_age between 21 and 24 then young := 200; end if;
  -- they do not stack: charge the larger, and show only that one
  if young >= oot then oot := 0; else young := 0; end if;
  return jsonb_build_object(
    'base', base, 'out_of_town', oot, 'young_renter', young,
    'total', base + oot + young,
    'age', v_age, 'is_local', v_local,
    'eligibility', case when v_age is null then 'pending'
                        when v_age < 21 then 'under_21' else 'eligible' end);
end $$;

drop function if exists r2g_deposit_for(date, text, text);
create function r2g_deposit_for(p_dob date, p_addr text, p_promo text default null)
returns jsonb language plpgsql stable as $$
declare
  v_age int; v_local boolean := null; p record;
  base numeric := 150; oot numeric := 0; young numeric := 0;
  applied text := null; waived boolean := false;
begin
  if p_dob is not null then
    v_age := extract(year from age(current_date, p_dob))::int;
  end if;
  v_local := r2g_is_local(p_addr);
  if v_local is false then oot := 150; end if;
  if v_age between 21 and 24 then young := 200; end if;
  if young >= oot then oot := 0; else young := 0; end if;

  if p_promo is not null and length(trim(p_promo)) > 0 then
    select * into p from r2g_check_promo(upper(trim(p_promo)));
    if p is not null and coalesce(p.valid, false) then
      applied := upper(trim(p_promo));
      waived  := true;
    end if;
  end if;

  return jsonb_build_object(
    'base',         case when waived then 0 else base  end,
    'out_of_town',  case when waived then 0 else oot   end,
    'young_renter', case when waived then 0 else young end,
    'total',        case when waived then 0 else base + oot + young end,
    'age', v_age, 'is_local', v_local, 'promo', applied, 'waived', waived,
    'eligibility', case when v_age is null then 'pending'
                        when v_age < 21 then 'under_21' else 'eligible' end);
end $$;

-- bring existing renters onto the corrected rule
update renters r
   set deposit_base         = (d->>'base')::numeric,
       deposit_out_of_town  = (d->>'out_of_town')::numeric,
       deposit_young        = (d->>'young_renter')::numeric,
       deposit_total        = (d->>'total')::numeric
  from lateral (
    select r2g_deposit_for(
      coalesce(nullif(r.verified_dob::text,'')::date, r.dob),
      coalesce(r.home_address, '') || ' ' || coalesce(r.home_city,'') || ' ' || coalesce(r.home_state,''),
      r.promo_code) as d
  ) x
 where r.dob is not null or r.verified_dob is not null;

select deposit_total, count(*) as renters
  from renters where deposit_total is not null
 group by deposit_total order by deposit_total;
