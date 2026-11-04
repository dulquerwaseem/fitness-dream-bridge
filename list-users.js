// Lists all users registered on the F22 devices (both floors by default).
// Usage: node list-users.js [ip]   (pass an IP to check just that device)
const Zkteco = require('zkteco-js');

const DEVICES = process.argv[2]
  ? [{ label: process.argv[2], ip: process.argv[2] }]
  : [
      { label: '2nd Floor', ip: '192.168.1.202' },
      { label: '1st Floor', ip: '192.168.1.7' },
    ];
const PORT = 4370;
const TIMEOUT_MS = 10000;
// Different from bridge.js's 4000 so this can run while the bridge is running.
const INPORT = 5201;

async function listUsers({ label, ip }) {
  console.log(`\n=== ${label} (${ip}) ===`);
  const zk = new Zkteco(ip, PORT, TIMEOUT_MS, INPORT);
  console.log(`Connecting to ${ip}:${PORT}...`);
  await zk.createSocket();
  try {
    // The F22 never answers a users download when it has no users, and
    // zkteco-js then crashes the process. Check the count first.
    const info = await zk.getInfo();
    if (info && info.userCounts === 0) {
      console.log(`Total users on ${label}: 0`);
      return;
    }

    const result = await zk.getUsers();
    const users = (result && result.data) || [];
    if (result && result.err) console.warn('Device reported an error:', result.err);

    users.sort((a, b) => Number(a.userId ?? a.uid) - Number(b.userId ?? b.uid));
    console.table(
      users.map((u) => ({
        uid: u.uid,
        userId: u.userId,
        name: u.name,
        role: u.role,
        cardno: u.cardno,
      })),
    );
    console.log(`Total users on ${label}: ${users.length}`);
  } finally {
    try {
      await zk.disconnect();
    } catch {
      // already disconnected
    }
  }
}

async function main() {
  let failed = false;
  // One at a time: both use the same INPORT.
  for (const device of DEVICES) {
    try {
      await listUsers(device);
    } catch (err) {
      failed = true;
      console.error(`Failed (${device.label}):`, err && err.message ? err.message : err);
    }
  }
  if (failed) process.exit(1);
}

main();
