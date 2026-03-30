#!/usr/bin/env node
/**
 * scripts/license-audit.js — Software License Audit
 *
 * Produces a console report (and optional JSON output) flagging:
 *   1. Over-capacity apps  — usedLicenses > purchasedLicenses
 *   2. Member users consuming a paid seat — Members filling licensed slots
 *      because there weren't enough privileged users to fill them
 *   3. Under-utilised apps — licensed seats < 50% used (configurable)
 *
 * Usage:
 *   node scripts/license-audit.js
 *   node scripts/license-audit.js --json            # output raw JSON
 *   node scripts/license-audit.js --threshold 70    # change utilisation % threshold
 *   node scripts/license-audit.js --json > report.json
 */

require('../config');
const { connect, disconnect, User, Software } = require('../db');

// ── Config ─────────────────────────────────────────────────────────────────
const args            = process.argv.slice(2);
const jsonMode        = args.includes('--json');
const thresholdIdx    = args.indexOf('--threshold');
const UTIL_THRESHOLD  = thresholdIdx >= 0 ? parseInt(args[thresholdIdx + 1], 10) : 50; // %

// ── Helpers ────────────────────────────────────────────────────────────────
function isPrivileged(user, csvId) {
  const role = ((user.appRoles || {})[csvId] || '').toLowerCase();
  return role.includes('super') || role.includes('owner') || role.includes('admin');
}

function getRoleLabel(user, csvId) {
  return (user.appRoles || {})[csvId] || 'Member';
}

// ── Main ───────────────────────────────────────────────────────────────────
async function run() {
  await connect();

  const [allSoftware, allUsers] = await Promise.all([
    Software.find({ status: 'Active' }).lean(),
    User.find({ status: 'Active' }).lean(),
  ]);

  // Index users by the apps they have access to
  const usersByApp = {}; // csvId → [user, ...]
  for (const user of allUsers) {
    for (const csvId of (user.appAccess || [])) {
      if (!usersByApp[csvId]) usersByApp[csvId] = [];
      usersByApp[csvId].push(user);
    }
  }

  const overCapacity   = [];
  const memberOnLicense = [];
  const underUtilised  = [];

  for (const sw of allSoftware) {
    const { csvId, name, purchasedLicenses = 0 } = sw;
    const users = usersByApp[csvId] || [];

    // Skip freeware / unlimited apps (no license tracking)
    if (purchasedLicenses === 0) continue;

    // Mirror portal logic: privileged first, then members
    const privUsers   = users.filter(u =>  isPrivileged(u, csvId));
    const memberUsers = users.filter(u => !isPrivileged(u, csvId));
    const orderedUsers = [...privUsers, ...memberUsers];

    const licensed     = Math.min(purchasedLicenses, orderedUsers.length);
    const unlicensed   = Math.max(0, orderedUsers.length - purchasedLicenses);
    const utilPct      = Math.round((licensed / purchasedLicenses) * 100);

    // 1. Over-capacity
    if (unlicensed > 0) {
      overCapacity.push({
        csvId, name,
        purchasedLicenses,
        totalUsers:   orderedUsers.length,
        overBy:       unlicensed,
        unlicensedUsers: orderedUsers.slice(purchasedLicenses).map(u => ({
          name:  `${u.first} ${u.last}`.trim(),
          email: u.email,
          role:  getRoleLabel(u, csvId),
        })),
      });
    }

    // 2. Members consuming a licensed seat (no spare seats left for future privileged users)
    //    i.e. a Member user falls within the purchasedLicenses window
    const membersWithSeat = memberUsers
      .slice(0, Math.max(0, purchasedLicenses - privUsers.length))
      .map(u => ({
        name:  `${u.first} ${u.last}`.trim(),
        email: u.email,
        role:  getRoleLabel(u, csvId),
      }));

    if (membersWithSeat.length > 0) {
      memberOnLicense.push({ csvId, name, purchasedLicenses, privCount: privUsers.length, membersWithSeat });
    }

    // 3. Under-utilised
    if (utilPct < UTIL_THRESHOLD) {
      underUtilised.push({
        csvId, name,
        purchasedLicenses,
        activeUsers:    orderedUsers.length,
        utilisationPct: utilPct,
        wastedSeats:    purchasedLicenses - licensed,
      });
    }
  }

  // ── Output ──────────────────────────────────────────────────────────────
  if (jsonMode) {
    console.log(JSON.stringify({ generatedAt: new Date().toISOString(), overCapacity, memberOnLicense, underUtilised }, null, 2));
    await disconnect();
    return;
  }

  const sep = '─'.repeat(70);

  console.log('\n╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║              SOFTWARE LICENSE AUDIT REPORT                          ║');
  console.log(`║  Generated: ${new Date().toLocaleString().padEnd(58)}║`);
  console.log(`║  Utilisation threshold: <${UTIL_THRESHOLD}%${''.padEnd(43)}║`);
  console.log('╚══════════════════════════════════════════════════════════════════════╝\n');

  // Section 1: Over-capacity
  console.log(`🔴  OVER-CAPACITY APPS  (${overCapacity.length} found)`);
  console.log(sep);
  if (overCapacity.length === 0) {
    console.log('    ✅  No apps are over-capacity.\n');
  } else {
    for (const app of overCapacity) {
      console.log(`  [${app.csvId}] ${app.name}`);
      console.log(`      Purchased: ${app.purchasedLicenses}  |  Total users: ${app.totalUsers}  |  Over by: ${app.overBy}`);
      console.log('      Users without a license seat:');
      app.unlicensedUsers.forEach(u => console.log(`        • ${u.name} <${u.email}> (${u.role})`));
      console.log();
    }
  }

  // Section 2: Members consuming licensed seats
  console.log(`🟡  MEMBER USERS CONSUMING LICENSED SEATS  (${memberOnLicense.length} apps)`);
  console.log(sep);
  if (memberOnLicense.length === 0) {
    console.log('    ✅  No member users are occupying paid license seats.\n');
  } else {
    for (const app of memberOnLicense) {
      console.log(`  [${app.csvId}] ${app.name}`);
      console.log(`      Purchased: ${app.purchasedLicenses}  |  Privileged users: ${app.privCount}  |  Members on paid seats: ${app.membersWithSeat.length}`);
      app.membersWithSeat.forEach(u => console.log(`        • ${u.name} <${u.email}>`));
      console.log();
    }
  }

  // Section 3: Under-utilised
  console.log(`🔵  UNDER-UTILISED APPS  (<${UTIL_THRESHOLD}% seats used, ${underUtilised.length} found)`);
  console.log(sep);
  if (underUtilised.length === 0) {
    console.log(`    ✅  All licensed apps are above ${UTIL_THRESHOLD}% utilisation.\n`);
  } else {
    for (const app of underUtilised) {
      console.log(`  [${app.csvId}] ${app.name}`);
      console.log(`      Purchased: ${app.purchasedLicenses}  |  Active users: ${app.activeUsers}  |  Used: ${app.utilisationPct}%  |  Wasted seats: ${app.wastedSeats}`);
    }
    console.log();
  }

  console.log(sep);
  console.log(`  Summary: ${overCapacity.length} over-capacity · ${memberOnLicense.length} with members on paid seats · ${underUtilised.length} under-utilised`);
  console.log(sep + '\n');

  await disconnect();
}

run().catch(err => {
  console.error('Audit failed:', err.message);
  process.exit(1);
});
