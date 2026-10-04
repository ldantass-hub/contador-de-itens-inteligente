BEGIN;

ALTER TABLE public.users
  ADD COLUMN auth_version integer NOT NULL DEFAULT 1,
  ADD CONSTRAINT users_auth_version_positive CHECK (auth_version >= 1);

COMMIT;