-- CHANGELOG
-- Fixes a serious regression: TWO separate trigger functions on the
-- `scores` table both hard-RAISE EXCEPTION when user_id IS NULL (i.e. any
-- anonymous submission). A trigger exception rolls back the ENTIRE
-- transaction, including the INSERT itself -- meaning anonymous scores
-- have not been reaching the database at all, not just failing to show
-- up on a leaderboard. There is nothing to "recover" for past anonymous
-- singers because the row was never written in the first place.
--
-- This directly undoes the anonymous-scoring feature (nullable user_id,
-- IP-based dedup, guest name input) that the client-side code still
-- correctly supports -- some later "hardening" migration re-added strict
-- validation without accounting for the anonymous path.
--
-- Fix: both functions now treat NULL user_id as a valid anonymous
-- submission (silently skip the profile-stats update, since there's no
-- profile to update) instead of raising an exception. All other
-- validation (score range, rating enum) is preserved unchanged.

CREATE OR REPLACE FUNCTION public.update_profile_stats()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_TABLE_SCHEMA <> 'public' OR TG_TABLE_NAME <> 'scores' OR TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Invalid trigger context';
  END IF;

  IF NEW.score IS NULL OR NEW.score < 0 OR NEW.score > 1000 THEN
    RAISE EXCEPTION 'Invalid score data';
  END IF;

  -- Anonymous submission (no signed-in user) -- nothing to update, but
  -- this is a VALID state, not an error. Let the INSERT into scores
  -- succeed; there is simply no profiles row to attribute it to.
  IF NEW.user_id IS NULL THEN
    RETURN NEW;
  END IF;

  UPDATE public.profiles
  SET
    total_score = COALESCE(total_score, 0) + NEW.score,
    songs_performed = COALESCE(songs_performed, 0) + 1,
    updated_at = now()
  WHERE user_id = NEW.user_id;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.validate_score_submission()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  -- NOTE: user_id IS NULL is a valid anonymous submission -- do NOT
  -- reject it. Only score range and rating enum are validated.
  IF NEW.score IS NULL OR NEW.score < 0 OR NEW.score > 1000 THEN
    RAISE EXCEPTION 'Score must be between 0 and 1000';
  END IF;

  IF NEW.rating IS NULL OR NEW.rating NOT IN ('L', 'S', 'A', 'B', 'C', 'D', 'F') THEN
    RAISE EXCEPTION 'Invalid score rating';
  END IF;

  RETURN NEW;
END;
$function$;
