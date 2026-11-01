# Fitness Dream Biometric Bridge

Runs on the gym's Windows PC. Every `POLL_INTERVAL_MINUTES` (default 5) it:

1. Connects to both ESSL F22 devices and pulls attendance punches into Supabase's
   `biometric_attendance` table, then clears the on-device log (only after a
   confirmed write) so the device doesn't slow down as logs pile up.
2. Removes expired or soft-deleted members from each device.
3. Enrolls newly-active members (new or renewed) on each device, assigning each
   member a permanent device UID the first time they're ever enrolled.

## Why `zkteco-js`, not `zk`

`zk` on npm is an Apache ZooKeeper client - unrelated to biometric devices. The
ZKTeco/F22 ecosystem's only actively maintained package with the `setUser` /
`deleteUser` calls this task needs is `zkteco-js`, so that's what's wired up
here. Its own README flags it as not yet production-hardened; keep an eye on
`logs/bridge.log` after setup. Neither it nor `node-zklib` support an
authenticated (non-zero) comm key, so **both F22 units must have Comm Key = 0
("disabled") set on the device itself** - that's what the "000000" default
usually means.

## One-time setup

1. **Supabase**: open the SQL editor on your project and run `sql/001_biometric_setup.sql`.
   It adds a `biometric_uid` column to `members`, plus two new tables
   (`biometric_device_enrollment`, `biometric_attendance`).
2. **Get a service_role key**: Supabase Dashboard → Project Settings → API →
   `service_role` secret. This script needs to read every member's full row and
   bypass RLS - the publishable/anon key you have is meant to stay restricted,
   so don't reuse it here. The service_role key only ever lives in this local
   `.env` on the gym PC, never in a browser bundle.
3. Copy `.env.example` to `.env` and fill in `SUPABASE_KEY` with that service_role
   key (the URL and device IPs are already filled in).
4. On the gym PC, with Node.js installed: `npm install`.
5. Test it once in the foreground: `npm start` (Ctrl+C to stop). Watch
   `logs/bridge.log` for `synced N attendance record(s)` / `enrolled member ...`
   lines and no connection errors.

## Auto-start on boot

Two options, in `start-bridge.bat` (already wraps `node bridge.js` in a
restart-on-crash loop):

- **Startup folder** (simplest, runs once a user logs in): press `Win+R`, type
  `shell:startup`, and drop a shortcut to `start-bridge.bat` in there.
- **Task Scheduler** (recommended for an unattended PC - runs at boot even
  without a login, and on a background SYSTEM account): right-click
  `install-task-scheduler.bat` → "Run as administrator", once.

## Known limits worth knowing about

- Device UIDs are capped at 1-3000 by `zkteco-js` itself; fine for a single gym's
  membership but won't scale past that without swapping the library.
- UIDs are assigned once and never reused, even after a member is permanently
  removed - simplest to reason about, but it does mean the 3000 cap is really a
  lifetime cap on *distinct members ever enrolled*, not concurrent members.
- Devices are polled one at a time, not in parallel, specifically so UID
  assignment for a brand-new member can't race between the two devices.
