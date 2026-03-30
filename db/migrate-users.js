/**
 * db/migrate-users.js
 * Syncs the users collection from "Terzo Employees List - employees.csv"
 *
 * Strategy:
 *  - Match existing DB users by email first, then by full name (to preserve
 *    asset assignments / ObjectIds).
 *  - Update matched users with fresh data from the CSV.
 *  - Insert brand-new employees.
 *  - Mark employees no longer in the CSV as Inactive (never hard-delete).
 *
 * Run:  node db/migrate-users.js
 */

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const { connect, disconnect, User } = require('./index');

// ── 1. CSV path ────────────────────────────────────────────────────────────────
const CSV_PATH = path.join(__dirname, 'employees.csv');

// ── 2. Department mapping ──────────────────────────────────────────────────────
function mapDept(raw = '') {
  const d = raw.trim();
  if (/data science.*engineering|engineering.*data science/i.test(d)) return 'Engineering';
  if (/engineering/i.test(d)) return 'Engineering';
  if (/data science/i.test(d)) return 'Data Science';
  if (/ai service/i.test(d)) return 'AI-Service';
  if (/product/i.test(d))     return 'Product';
  if (/human resource|^hr$/i.test(d)) return 'HR';
  if (/account.*finance|india accounts/i.test(d)) return 'Accounts';
  if (/accounting.*finance/i.test(d)) return 'Accounts';
  if (/^it$/i.test(d))        return 'IT';
  if (/customer support/i.test(d)) return 'Customer Support';
  if (/customer operation/i.test(d)) return 'Customer Support';
  if (/operation/i.test(d))   return 'Operations';
  if (/sale/i.test(d))        return 'Sales';
  if (/market/i.test(d))      return 'Marketing';
  if (/legal/i.test(d))       return 'Legal';
  if (/executive/i.test(d))   return 'Executive';
  if (/finance/i.test(d))     return 'Finance';
  if (/qa|quality/i.test(d))  return 'QA';
  return 'Other';
}

// ── 3. Portal role mapping: Admin > Manager > Staff (Editor/Viewer removed) ───
function mapRole(title = '', email = '') {
  const t = title.toLowerCase();
  if (/it.*admin|admin.*it/i.test(title)) return 'Admin';
  if (email === 'praveen.m@terzocloud.com') return 'Admin';
  if (/chief|president|officer|general counsel|controller/i.test(t)) return 'Manager';
  if (/director|^manager|head of|general manager|vice president|^vp /i.test(t)) return 'Manager';
  if (/senior manager|lead analyst|engagement director|engagement manager|program manager/i.test(t)) return 'Manager';
  return 'Staff';
}

// ── 3b. Extract reporting manager name (strip title after " - ") ──────────────
function extractManager(raw = '') {
  if (!raw || !raw.trim()) return '';
  // Format examples:
  //  - "Name - Title" -> "Name"
  //  - "Name (Title)" -> "Name"
  const fromDash = raw.split(' - ')[0].trim();
  return fromDash.replace(/\s*\(.*\)\s*$/g, '').trim();
}

// ── 4. Location heuristic ─────────────────────────────────────────────────────
// CSV doesn't carry location — preserve existing DB value; default India
// employees to Chennai, everyone else to Remote.
const INDIA_EMAILS = new Set([
  'ajay@terzocloud.com','karthi@terzocloud.com','ahamed@terzocloud.com',
  'kavipriya@terzocloud.com','ananya@terzocloud.com','shunmugavel@terzocloud.com',
  'prasanna@terzocloud.com','hariharan@terzocloud.com','paventhan@terzocloud.com',
  'vinotha@terzocloud.com','mythilipriya@terzocloud.com','divyar@terzocloud.com',
  'dinesh.v@terzocloud.com','dinesh@terzocloud.com','vp@terzocloud.com',
  'mohanamala@terzocloud.com','divya@terzocloud.com','gowthamv@terzocloud.com',
  'iyyappan@terzocloud.com','ragav@terzocloud.com','harshni@terzocloud.com',
  'priyadharshini@terzocloud.com','aswini@terzocloud.com','dharshini@terzocloud.com',
  'kavimitraa@terzocloud.com','nivetha@terzocloud.com','dhanusha.a@terzocloud.com',
  'sowmiya@terzocloud.com','harish@terzocloud.com','praveen.m@terzocloud.com',
  'karthick@terzocloud.com','leo@terzocloud.com','gowtham@terzocloud.com',
  'himalaya@terzocloud.com','yogesh@terzocloud.com','mohan@terzocloud.com',
  'urvasi@terzocloud.com','pradeep@terzocloud.com','niranjan@terzocloud.com',
  'revathi@terzocloud.com','kavipriya@terzocloud.com',
]);
const COIMBATORE_EMAILS = new Set([
  'shunmugavel@terzocloud.com','vinotha@terzocloud.com','iyyappan@terzocloud.com',
  'ragav@terzocloud.com','harshni@terzocloud.com','priyadharshini@terzocloud.com',
  'aswini@terzocloud.com','dharshini@terzocloud.com','kavimitraa@terzocloud.com',
  'dhanusha.a@terzocloud.com','sowmiya@terzocloud.com','leo@terzocloud.com',
  'yogesh@terzocloud.com',
]);
function defaultLocation(email) {
  if (COIMBATORE_EMAILS.has(email)) return 'Coimbatore';
  if (INDIA_EMAILS.has(email))      return 'Chennai';
  return 'Remote';
}

// ── 5. Parse CSV ──────────────────────────────────────────────────────────────
function parseCSV(filePath) {
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  const employees = [];
  for (let i = 1; i < lines.length; i++) {           // skip header
    const line = lines[i].trim();
    if (!line) continue;
    // Simple CSV split (handles quoted fields with commas)
    const cols = [];
    let cur = '', inQ = false;
    for (const ch of line + ',') {
      if (ch === '"') { inQ = !inQ; }
      else if (ch === ',' && !inQ) { cols.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    // Columns: h, Emp.ID, Name, Role(jobTitle), Manager(reportingMgr), Department, Email, EmploymentType
    const [, empId, name, jobTitle, manager, dept, email, empType] = cols;
    if (!name || !email) continue;
    employees.push({ empId: empId||'', name, jobTitle, manager: manager||'', dept, email, empType });
  }
  return employees;
}

// ── 6. Main ───────────────────────────────────────────────────────────────────
async function migrate() {
  await connect();

  const csvEmployees = parseCSV(CSV_PATH);
  console.log(`📄  Parsed ${csvEmployees.length} employees from CSV`);

  // Build existing-user maps for fast lookup
  const existingByEmail = new Map();
  const existingByName  = new Map();
  const allExisting = await User.find();
  allExisting.forEach(u => {
    existingByEmail.set(u.email.toLowerCase(), u);
    existingByName.set(`${u.first} ${u.last}`.toLowerCase().trim(), u);
  });

  const csvEmailSet = new Set(csvEmployees.map(e => e.email.toLowerCase()));

  let updated = 0, inserted = 0, deactivated = 0;

  for (const emp of csvEmployees) {
    const emailLC  = emp.email.toLowerCase();
    const nameParts = emp.name.trim().split(' ');
    const first     = nameParts[0];
    const last      = nameParts.slice(1).join(' ');
    const fullLC    = `${first} ${last}`.toLowerCase().trim();

    const dept   = mapDept(emp.dept);
    const role   = mapRole(emp.jobTitle, emailLC);
    const empType = (emp.empType||'').trim();
    const employmentType = empType.includes('Contractor') ? 'Contractor'
                         : empType.includes('Part')       ? 'Part Time'
                         : 'Full Time';
    const status = employmentType === 'Contractor' ? 'Active' : 'Active';

    // Try to match existing user
    let existing = existingByEmail.get(emailLC) || existingByName.get(fullLC);

    const updateData = {
      empId: emp.empId || '',
      first, last,
      email: emailLC,
      jobTitle: emp.jobTitle || '',
      reportingManager: extractManager(emp.manager),
      dept,
      role,
      employmentType,
      status,
    };

    if (existing) {
      // Preserve location if already set; otherwise infer
      updateData.location = existing.location || defaultLocation(emailLC);
      await User.findByIdAndUpdate(existing._id, updateData, { runValidators: true });
      updated++;
    } else {
      // New employee
      updateData.location = defaultLocation(emailLC);
      updateData.joined   = new Date();
      await User.create(updateData);
      inserted++;
    }
  }

  // Mark users no longer in CSV as Inactive
  for (const u of allExisting) {
    if (!csvEmailSet.has(u.email.toLowerCase())) {
      await User.findByIdAndUpdate(u._id, { status: 'Inactive' });
      deactivated++;
    }
  }

  // Summary
  const total  = await User.countDocuments();
  const active = await User.countDocuments({ status: 'Active' });
  console.log('\n✅  Migration complete');
  console.log(`   Updated   : ${updated}`);
  console.log(`   Inserted  : ${inserted}`);
  console.log(`   Deactivated (no longer in CSV): ${deactivated}`);
  console.log(`   Total users in DB : ${total}  (Active: ${active})`);

  await disconnect();
}

migrate().catch(err => { console.error('Migration failed:', err); process.exit(1); });
