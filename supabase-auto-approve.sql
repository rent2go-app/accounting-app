-- Clear a renter to book as soon as both checks have actually passed.
--
-- There were two gates: Stripe's identity check, and a human reading the proof of
-- address by hand. The second existed because nothing else was reading the
-- document. Now the proof is checked automatically at upload, so making the
-- applicant wait a business day for a person to repeat that check adds delay and
-- no safety - and it silently blocks the sale, because checkout refuses anyone
-- who is not approved.
--
-- Approval is still earned, not assumed. Both must be true:
--   status = 'verified'        Stripe confirmed the licence and selfie
--   proof_verdict = 'accept'   the document proved the name and address
--
-- Anything less is untouched: a 'review' verdict, an unreadable file or no
-- document at all still waits for a person, and a 'reject' is already refused
-- at intake.

create or replace function public.r2g_auto_approve()
returns trigger language plpgsql as $$
begin
  if new.status = 'verified'
     and new.proof_verdict = 'accept'
     and coalesce(new.decision,'') not in ('approved','rejected') then
    new.decision    := 'approved';
    new.decision_at := now();
    new.needs_review := false;
    new.review_reason := null;
  end if;
  return new;
end $$;

drop trigger if exists trg_r2g_auto_approve on public.renters;
create trigger trg_r2g_auto_approve
  before insert or update of status, proof_verdict on public.renters
  for each row execute function public.r2g_auto_approve();
