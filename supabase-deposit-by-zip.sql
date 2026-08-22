-- Decide the out-of-town surcharge from the ZIP, not a wildcard town match.
-- Only the locality block changes; the amounts, the non-stacking rule and the
-- promo handling are exactly as they were.

CREATE OR REPLACE FUNCTION public.r2g_deposit_for(p_dob date, p_addr text, p_promo text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
AS $function$
declare
  v_age int; v_local boolean := null; p record; v_zip text;
  base numeric := 150; oot numeric := 0; young numeric := 0;
  waived boolean := false; applied text := null;
begin
  if p_dob is not null then v_age := extract(year from age(current_date, p_dob))::int; end if;

  if coalesce(p_addr,'') <> '' then
    -- A ZIP is the reliable signal, so it is tried first. Town names match far
    -- too loosely to charge money on: Concord is a town in NC, and also in
    -- California, New Hampshire and Massachusetts, and any address containing
    -- the word matched. The town list is kept only as a fallback for an address
    -- with no ZIP in it.
    v_zip := substring(p_addr from '[0-9]{5}');
    if v_zip is not null then
      select exists (select 1 from service_zips z where z.zip = v_zip and z.active)
        into v_local;
    end if;
    if v_local is null then
      select exists (
        select 1 from service_area sa
        where sa.active and p_addr ilike '%'||sa.town||'%'
          and (p_addr ilike '%'||sa.state||'%'
               or (sa.state='NC' and p_addr ilike '%north carolina%')
               or (sa.state='SC' and p_addr ilike '%south carolina%'))
      ) into v_local;
    end if;
  end if;

  if v_local is false then oot := 150; end if;
  if v_age between 21 and 24 then young := 200; end if;
  -- The surcharges do NOT stack: charge the larger and show only that one,
  -- so the breakdown a renter reads actually adds up.
  if young >= oot then oot := 0; else young := 0; end if;

  if coalesce(p_promo,'') <> '' then
    select * into p from promo_codes
     where upper(code)=upper(p_promo) and active
       and (expires_at is null or expires_at > now())
       and (max_uses is null or uses < max_uses);
    if found then
      applied := p.code;
      if    p.kind='deposit_waiver'  then waived := true;
      elsif p.kind='deposit_amount'  then base := greatest(0, base - coalesce(p.value,0));
      elsif p.kind='deposit_percent' then base := round(base * (1 - coalesce(p.value,0)/100), 2);
      end if;
    end if;
  end if;

  return jsonb_build_object(
    'base', case when waived then 0 else base end,
    'out_of_town', case when waived then 0 else oot end,
    'young_renter', case when waived then 0 else young end,
    'total', case when waived then 0 else base+oot+young end,
    'age', v_age, 'is_local', v_local, 'promo', applied, 'waived', waived,
    'eligibility', case when v_age is null then 'pending'
                        when v_age < 21 then 'under_21' else 'eligible' end);
end $function$

