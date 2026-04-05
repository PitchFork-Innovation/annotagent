create extension if not exists "pgcrypto";

create table if not exists papers (
  id uuid primary key default gen_random_uuid(),
  arxiv_id text not null unique,
  title text not null,
  abstract text not null default '',
  ai_summary text,
  pdf_url text not null,
  page_count integer not null default 0,
  full_text text not null,
  starter_questions text[] not null default '{}',
  created_at timestamptz not null default now()
);

create table if not exists annotations (
  id uuid primary key default gen_random_uuid(),
  paper_id uuid not null references papers(id) on delete cascade,
  page_number integer not null,
  type text not null check (type in ('highlight', 'note', 'definition')),
  text_ref text not null,
  note text not null,
  importance integer not null check (importance between 1 and 3),
  bbox jsonb not null,
  anchor jsonb,
  created_at timestamptz not null default now()
);

alter table papers add column if not exists ai_summary text;
alter table annotations add column if not exists anchor jsonb;

create table if not exists user_papers (
  user_id uuid not null references auth.users(id) on delete cascade,
  paper_id uuid not null references papers(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, paper_id)
);

alter table papers enable row level security;
alter table annotations enable row level security;
alter table user_papers enable row level security;

create policy "users can read linked papers"
on papers
for select
using (
  exists (
    select 1 from user_papers
    where user_papers.paper_id = papers.id
    and user_papers.user_id = auth.uid()
  )
);

create policy "users can read linked annotations"
on annotations
for select
using (
  exists (
    select 1 from user_papers
    where user_papers.paper_id = annotations.paper_id
    and user_papers.user_id = auth.uid()
  )
);

create policy "users can manage their library"
on user_papers
for all
using (user_id = auth.uid())
with check (user_id = auth.uid());
