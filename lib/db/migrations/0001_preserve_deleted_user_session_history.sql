BEGIN;

ALTER TABLE public.sessions
  ADD COLUMN operator_user_id integer,
  ADD COLUMN operator_username text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.sessions'::regclass
      AND conname = 'sessions_user_id_users_id_fk'
      AND contype = 'f'
      AND pg_get_constraintdef(oid) = 'FOREIGN KEY (user_id) REFERENCES users(id)'
  ) THEN
    RAISE EXCEPTION 'Expected FK public.sessions.sessions_user_id_users_id_fk with NO ACTION was not found';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.sessions AS s
    LEFT JOIN public.users AS u ON u.id = s.user_id
    WHERE u.id IS NULL
  ) THEN
    RAISE EXCEPTION 'Cannot backfill session operator snapshots: a session has no matching user';
  END IF;
END $$;

UPDATE public.sessions AS s
SET operator_user_id = s.user_id,
    operator_username = u.username
FROM public.users AS u
WHERE u.id = s.user_id;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.sessions
    WHERE operator_user_id IS NULL OR operator_username IS NULL
  ) THEN
    RAISE EXCEPTION 'Cannot enforce NOT NULL: one or more session operator snapshots are missing';
  END IF;
END $$;

ALTER TABLE public.sessions
  ALTER COLUMN operator_user_id SET NOT NULL,
  ALTER COLUMN operator_username SET NOT NULL,
  ALTER COLUMN user_id DROP NOT NULL;

ALTER TABLE public.sessions
  DROP CONSTRAINT sessions_user_id_users_id_fk;

ALTER TABLE public.sessions
  ADD CONSTRAINT sessions_user_id_users_id_fk
  FOREIGN KEY (user_id)
  REFERENCES public.users(id)
  ON DELETE SET NULL;

COMMIT;