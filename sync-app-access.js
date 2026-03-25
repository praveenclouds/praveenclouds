/**
 * sync-app-access.js
 * Reads app→user mappings from the Google Sheet CSV data and updates
 * each user's appAccess field in MongoDB to include the matched software csvIds.
 */

const mongoose = require('mongoose');
const { MONGO_URI } = require('./config');
const User     = require('./db/models/User');
const Software = require('./db/models/Software');

/* ── Sheet data (parsed from Google Sheet) ────────────────────────────────── */
const SHEET_DATA = [
  { app: 'Zoom',               users: ['Praveen M','Brandon Card','Kevin Charector','Pradeep'] },
  { app: 'Adobe Acrobat',      users: ['Praveen M'] },
  { app: 'Asana',              users: ['Praveen M','Pradeep','Stephanie Yaacoub','Luke Ashworth','Kevin Charector','Brandon Card'] },
  { app: 'Jira Atlassian',     users: ['Mohanraja','Vasanth','Melany Dalgado'] },
  { app: 'GitHub',             users: ['Vasanth','Mohanraja'] },
  { app: 'Gsuite',             users: ['Praveen M','Gowtham','Brandon Card','Pradeep','Ragav','Harish','Kristen Pritchett'] },
  { app: 'HubSpot',            users: ['Brandon Card','Brody Elkin','Kevin Charector','Heather Silverman'] },
  { app: 'IntelliJ IDEA',      users: ['Mohanraja'] },
  { app: 'Loom',               users: ['Praveen M','Brandon Card'] },
  { app: 'Microsoft 365',      users: ['Praveen M','Pradeep','Brandon Card','Ragav'] },
  { app: 'Slack',              users: ['Praveen M','Kioka Bynum','Gowtham','Kevin Redwine','Pradeep','Ragav','Brandon Card'] },
  { app: 'Mosyle MDM',         users: ['Praveen M'] },
  { app: 'OpenVPN',            users: ['Praveen M'] },
  { app: 'Canva',              users: ['Praveen M','Brandon Card','Brad Grabowski'] },
];

/* ── Helpers ─────────────────────────────────────────────────────────────── */
function normalize(str) {
  return (str || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
}

function findSoftware(allSoftware, appName) {
  const n = normalize(appName);
  // Exact match first
  let match = allSoftware.find(s => normalize(s.name) === n);
  if (match) return match;
  // Contains match
  match = allSoftware.find(s => normalize(s.name).includes(n) || n.includes(normalize(s.name)));
  return match || null;
}

function findUser(allUsers, nameStr) {
  const n = normalize(nameStr);
  const parts = n.split(/\s+/);
  const firstName = parts[0];

  // Full name match
  let match = allUsers.find(u => normalize(`${u.first} ${u.last}`) === n);
  if (match) return match;

  // First name + partial last name
  match = allUsers.find(u => {
    const full = normalize(`${u.first} ${u.last}`);
    return full.startsWith(firstName) && (parts.length === 1 || full.includes(parts[1] || ''));
  });
  if (match) return match;

  // First name only
  match = allUsers.find(u => normalize(u.first) === firstName);
  return match || null;
}

/* ── Main ─────────────────────────────────────────────────────────────────── */
async function main() {
  await mongoose.connect(MONGO_URI);
  console.log('✅ Connected to MongoDB\n');

  const [allUsers, allSoftware] = await Promise.all([
    User.find({}),
    Software.find({}),
  ]);

  console.log(`📦 Found ${allSoftware.length} software records, ${allUsers.length} users\n`);

  // Build a map: userId → Set of csvIds to add
  const userAccessMap = new Map(); // userId → Set<csvId>

  let unmatchedApps  = [];
  let unmatchedUsers = [];

  for (const row of SHEET_DATA) {
    const sw = findSoftware(allSoftware, row.app);
    if (!sw) {
      unmatchedApps.push(row.app);
      console.log(`⚠️  Software not found: "${row.app}"`);
      continue;
    }
    console.log(`✅ Software matched: "${row.app}" → ${sw.name} (${sw.csvId})`);

    for (const nameStr of row.users) {
      const user = findUser(allUsers, nameStr.trim());
      if (!user) {
        unmatchedUsers.push(`${nameStr} (for ${row.app})`);
        console.log(`   ⚠️  User not found: "${nameStr}"`);
        continue;
      }
      const uid = user._id.toString();
      if (!userAccessMap.has(uid)) userAccessMap.set(uid, new Set(Array.isArray(user.appAccess) ? user.appAccess : []));
      userAccessMap.get(uid).add(sw.csvId);
      console.log(`   👤 ${user.first} ${user.last} → +${sw.csvId}`);
    }
  }

  // Update each user
  console.log(`\n🔄 Updating ${userAccessMap.size} users...\n`);
  let updated = 0;
  for (const [uid, csvIdSet] of userAccessMap) {
    const newAccess = Array.from(csvIdSet);
    await User.findByIdAndUpdate(uid, { appAccess: newAccess });
    const u = allUsers.find(x => x._id.toString() === uid);
    console.log(`   ✅ ${u?.first} ${u?.last}: [${newAccess.join(', ')}]`);
    updated++;
  }

  console.log(`\n🎉 Done! Updated appAccess for ${updated} users.`);
  if (unmatchedApps.length)  console.log(`\n⚠️  Unmatched apps:  ${unmatchedApps.join(', ')}`);
  if (unmatchedUsers.length) console.log(`⚠️  Unmatched users: ${[...new Set(unmatchedUsers)].join(', ')}`);

  await mongoose.disconnect();
}

main().catch(err => { console.error('❌ Error:', err.message); process.exit(1); });
