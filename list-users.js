// Lists all users registered on the 2nd floor F22 device.
// Usage: node list-users.js [ip]
const Zkteco = require('zkteco-js');

const IP = process.argv[2] || '192.168.1.202';
const PORT = 4370;
const TIMEOUT_MS = 10000;
// Different from bridge.js's 4000 so this can run while the bridge is running.
const INPORT = 5201;

async function main() {
  const zk = new Zkteco(IP, PORT, TIMEOUT_MS, INPORT);
  console.log(`Connecting to ${IP}:${PORT}...`);
  await zk.createSocket();
  try {
    // The F22 never answers a users download when it has no users, and
    // zkteco-js then crashes the process. Check the count first.
    const info = await zk.getInfo();
    if (info && info.userCounts === 0) {
      console.log(`Total users on ${IP}: 0`);
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
    console.log(`Total users on ${IP}: ${users.length}`);
  } finally {
    try {
      await zk.disconnect();
    } catch {
      // already disconnected
    }
  }
}

main().catch((err) => {
  console.error('Failed:', err && err.message ? err.message : err);
  process.exit(1);
});
