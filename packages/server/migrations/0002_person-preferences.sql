-- Each person's appearance and language choices. They belong to the person,
-- not to a deployment or a browser, so every device they sign in from shows
-- the same dashboard. The revision makes a concurrent change a conflict
-- rather than a silent overwrite.
create table person_preferences (
  person_id text primary key references people (id),
  language text not null check (language in ('en', 'zh')),
  theme text not null check (theme in ('system', 'light', 'dark')),
  font_scale integer not null check (font_scale between 90 and 150),
  rail_collapsed boolean not null default false,
  revision integer not null default 1 check (revision >= 1),
  created_at timestamptz not null,
  updated_at timestamptz not null
);
