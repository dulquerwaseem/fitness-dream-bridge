-- Run this once in the Supabase SQL editor for the fitness-dream-membership project.

-- 1. Give each member a stable numeric ID for the F22 devices.
alter table public.members
  add column if not exists biometric_uid integer unique check (biometric_uid between 1 and 3000);

-- 2. Per-device enrollment state.
create table if not exists public.biometric_device_enrollment (
  member_id uuid not null references public.members(id) on delete cascade,
  device_ip text not null,
  enrolled boolean not null default false,
  synced_at timestamptz,
  primary key (member_id, device_ip)
);

alter table public.biometric_device_enrollment enable row level security;

-- 3. Raw attendance punches pulled from the devices.
create table if not exists public.biometric_attendance (
  id uuid primary key default gen_random_uuid(),
  device_ip text not null,
  device_user_id text not null,
  member_id uuid references public.members(id) on delete set null,
  punch_time timestamptz not null,
  verify_type smallint,
  io_state smallint,
  created_at timestamptz not null default now(),
  unique (device_ip, device_user_id, punch_time)
);

create index if not exists biometric_attendance_member_id_idx
  on public.biometric_attendance (member_id);
create index if not exists biometric_attendance_punch_time_idx
  on public.biometric_attendance (punch_time desc);

alter table public.biometric_attendance enable row level security;

-- Staff read policy for attendance
create policy "staff can read attendance"
  on public.biometric_attendance
  for select to authenticated
  using (
    exists (
      select 1 from public.user_roles
      where user_roles.user_id = auth.uid()
    )
  );

create policy "staff can read enrollment"
  on public.biometric_device_enrollment
  for select to authenticated
  using (
    exists (
      select 1 from public.user_roles
      where user_roles.user_id = auth.uid()
    )
  );
