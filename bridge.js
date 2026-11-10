require('dotenv').config();

const fs = require('fs');
const path = require('path');
const Zkteco = require('zkteco-js');
const { createClient } = require('@supabase/supabase-js');

const required = ['DEVICE_1_IP', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`Missing required env var ${key}. Copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
}

const DEVICE_PORT = Number(process.env.DEVICE_PORT || 4370);
const DEVICE_TIMEOUT_MS = Number(process.env.DEVICE_TIMEOUT_MS || 10000);
const DEVICE_INPORT = Number(process.env.DEVICE_INPORT || 4000);
const POLL_INTERVAL_MINUTES = Number(process.env.POLL_INTERVAL_MINUTES || 5);

const DEVICES = [
  { label: process.env.DEVICE_1_NAME || 'Device 1', ip: process.env.DEVICE_1_IP },
  process.env.DEVICE_2_IP
    ? { label: process.env.DEVICE_2_NAME || 'Device 2', ip: process.env.DEVICE_2_IP }
    : null,
].filter(Boolean);

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const logDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir);
const logFile = path.join(logDir, 'bridge.log');

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  fs.appendFile(logFile, line + '\n', () => {});
}

// zkteco-js throws ZkError objects ({ err, command, ip }, possibly nested)
// rather than real Errors, so err.message is undefined. Unwrap to the cause.
function errMsg(err) {
  let e = err;
  while (e && !e.message && e.err) e = e.err;
  return (e && (e.message || e.code)) || String(err);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withDevice(device, fn) {
  const zk = new Zkteco(device.ip, DEVICE_PORT, DEVICE_TIMEOUT_MS, DEVICE_INPORT);
  await zk.createSocket();
  try {
    await fn(zk);
  } finally {
    try {
      await zk.disconnect();
    } catch {
      // device already dropped the connection, nothing to do
    }
  }
}

// Pulls attendance logs off the device, writes them to Supabase, and only
// clears the on-device log once the write is confirmed. Leaving the clear
// out of the write's try/catch means a failed upload never loses punches.
async function syncAttendance(device, zk) {
  // The F22 never answers an attendance download when its log is empty, and
  // zkteco-js then crashes the process with an uncatchable TypeError. Check the
  // log count first and skip the download when there is nothing to fetch.
  try {
    const info = await zk.getInfo();
    if (info && info.logCounts === 0) return;
  } catch (err) {
    log(`[${device.label}] getInfo failed, trying attendance download anyway: ${errMsg(err)}`);
  }

  const { data: logs } = await zk.getAttendances();
  if (!logs || logs.length === 0) return;

  const deviceUserIds = [...new Set(logs.map((entry) => String(entry.user_id)))];
  const numericUids = deviceUserIds.map(Number).filter(Number.isFinite);

  const { data: members, error: lookupError } = await supabase
    .from('members')
    .select('id, biometric_uid')
    .in('biometric_uid', numericUids);
  if (lookupError) throw lookupError;

  const uidToMemberId = new Map((members ?? []).map((m) => [String(m.biometric_uid), m.id]));

  const rows = logs.map((entry) => ({
    device_ip: device.ip,
    device_user_id: String(entry.user_id),
    member_id: uidToMemberId.get(String(entry.user_id)) ?? null,
    punch_time: new Date(entry.record_time).toISOString(),
    verify_type: entry.type ?? null,
    io_state: entry.state ?? null,
  }));

  const { error: insertError } = await supabase
    .from('biometric_attendance')
    .upsert(rows, { onConflict: 'device_ip,device_user_id,punch_time', ignoreDuplicates: true });
  if (insertError) throw insertError;

  log(`[${device.label}] synced ${rows.length} attendance record(s)`);

  try {
    await zk.clearAttendanceLog();
  } catch (err) {
    log(`[${device.label}] could not clear on-device attendance log: ${errMsg(err)}`);
  }
}

async function getEnrolledMemberIds(deviceIp) {
  const { data, error } = await supabase
    .from('biometric_device_enrollment')
    .select('member_id')
    .eq('device_ip', deviceIp)
    .eq('enrolled', true);
  if (error) throw error;
  return new Set(data.map((row) => row.member_id));
}

async function setEnrollment(memberId, deviceIp, enrolled) {
  const { error } = await supabase.from('biometric_device_enrollment').upsert({
    member_id: memberId,
    device_ip: deviceIp,
    enrolled,
    synced_at: new Date().toISOString(),
  });
  if (error) throw error;
}

// The bridge has no heartbeat, so the webapp infers "device online" from how
// recently synced_at moved. Bump it for every row on this device after a
// successful contact. Logs instead of throwing so it never blocks a sync.
async function touchDeviceEnrollments(device) {
  const { error } = await supabase
    .from('biometric_device_enrollment')
    .update({ synced_at: new Date().toISOString() })
    .eq('device_ip', device.ip);
  if (error) log(`[${device.label}] could not update synced_at: ${error.message}`);
}

async function syncMembership(device, zk) {
  const today = new Date().toISOString().slice(0, 10);
  const enrolledIds = await getEnrolledMemberIds(device.ip);

  if (enrolledIds.size > 0) {
    const { data: candidates, error } = await supabase
      .from('members')
      .select('id, biometric_uid, expiry_date, deleted_at, biometric_active')
      .in('id', [...enrolledIds]);
    if (error) throw error;

    for (const member of candidates) {
      const expired = member.expiry_date < today;
      const removed = member.deleted_at != null;
      // Strict false: null means "never set", not "turned off" in the app.
      const deactivated = member.biometric_active === false;
      if (!(expired || removed || deactivated) || !member.biometric_uid) continue;

      try {
        await zk.deleteUser(member.biometric_uid);
      } catch (err) {
        log(`[${device.label}] deleteUser(${member.biometric_uid}) failed: ${errMsg(err)}`);
        continue; // leave enrollment row as-is, retry next cycle
      }
      await setEnrollment(member.id, device.ip, false);
      log(`[${device.label}] removed member ${member.id} (uid ${member.biometric_uid})`);
    }
  }

  const { data: active, error: activeError } = await supabase
    .from('members')
    .select('id, full_name, biometric_uid')
    .is('deleted_at', null)
    .gte('expiry_date', today)
    .not('biometric_uid', 'is', null)
    .eq('biometric_active', true);
  if (activeError) throw activeError;

  for (const member of active) {
    if (enrolledIds.has(member.id)) continue;

    const uid = member.biometric_uid;

    try {
      await zk.setUser(uid, String(uid), member.full_name.slice(0, 24), '', 0, 0);
    } catch (err) {
      log(`[${device.label}] setUser(${uid}) failed: ${errMsg(err)}`);
      continue;
    }
    await setEnrollment(member.id, device.ip, true);

    const { error: activeUpdateError } = await supabase
      .from('members')
      .update({ biometric_active: true })
      .eq('id', member.id);
    if (activeUpdateError) {
      log(`[${device.label}] could not set biometric_active for member ${member.id}: ${activeUpdateError.message}`);
    }

    log(`[${device.label}] enrolled member ${member.id} (uid ${uid})`);
  }
}

async function runCycle() {
  for (const device of DEVICES) {
    // Attendance and membership use separate connections: a timed-out
    // attendance download can leave the device session unusable, and it must
    // never block enrollments/removals.
    let attendanceFailed = false;
    try {
      await withDevice(device, (zk) => syncAttendance(device, zk));
      await touchDeviceEnrollments(device);
    } catch (err) {
      attendanceFailed = true;
      log(`[${device.label}] attendance download failed, continuing with membership sync: ${errMsg(err)}`);
    }

    if (attendanceFailed) await sleep(2000); // give the device a moment to drop the stale session

    try {
      await withDevice(device, (zk) => syncMembership(device, zk));
      await touchDeviceEnrollments(device);
    } catch (err) {
      log(`[${device.label}] membership sync failed: ${errMsg(err)}`);
    }
  }
}

// zkteco-js bug (src/ztcp.js readWithBuffer): on a timeout it rejects, then
// keeps going and calls reply.subarray() on null inside an async Promise
// executor. That TypeError becomes a stray unhandled rejection that would kill
// the process even though the caller already caught the timeout. Swallow only
// that known case; anything else still exits so start-bridge.bat restarts us.
function isKnownZktecoStrayError(err) {
  return (
    err instanceof TypeError &&
    /reading 'subarray'/.test(err.message) &&
    /zkteco-js[\\/]src[\\/]ztcp\.js/.test(err.stack || '')
  );
}

process.on('unhandledRejection', (err) => {
  if (isKnownZktecoStrayError(err)) {
    log(`Ignored stray zkteco-js error after a device timeout: ${errMsg(err)}`);
    return;
  }
  log(`Unhandled rejection: ${(err && err.stack) || err}`);
  process.exit(1);
});

async function main() {
  log(`Bridge starting. Polling every ${POLL_INTERVAL_MINUTES} minute(s).`);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await runCycle();
    await sleep(POLL_INTERVAL_MINUTES * 60 * 1000);
  }
}

main().catch((err) => {
  log(`Fatal error: ${err.stack || err.message}`);
  process.exit(1);
});
