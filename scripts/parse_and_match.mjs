import fs from 'fs';

const raw = fs.readFileSync('scripts/raw_attendance_input.txt', 'utf8');
const dbStudents = JSON.parse(fs.readFileSync('scripts/db_students.json', 'utf8'));

// Build lookup maps
const byRoll = new Map();
const byEmail = new Map();
const byName = new Map();

for (const s of dbStudents) {
  byRoll.set(s.roll_number.toUpperCase().trim(), s);
  if (s.email) {
    byEmail.set(s.email.toLowerCase().trim(), s);
  }
  byName.set(s.name.toLowerCase().trim(), s);
}

// Also parse student_emails.csv if there are additional details
const csvContent = fs.readFileSync('student_emails.csv', 'utf8');
const csvStudents = [];
for (const line of csvContent.split('\n').slice(1)) {
  if (!line.trim()) continue;
  // Parse CSV line handling quotes
  const matches = line.match(/(?:^|,)("(?:[^"]|"")*"|[^,]*)/g);
  if (matches && matches.length >= 3) {
    const clean = matches.map(m => m.replace(/^,?"?|"$/g, '').trim());
    csvStudents.push({
      roll_number: clean[0],
      email: clean[1],
      name: clean[2],
      group: clean[3],
    });
  }
}

console.log(`Loaded ${dbStudents.length} DB students and ${csvStudents.length} CSV students.`);

// Let's parse the lines
const lines = raw.split('\n').map(l => l.trim()).filter(l => l.length > 0);

// Find indices of timestamp lines (e.g. "8/19/2026 12:53:52" or similar regex)
const timestampRegex = /^\d{1,2}\/\d{1,2}\/\d{4}\s+\d{1,2}:\d{2}:\d{2}/;

const entries = [];
let currentEntry = null;

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  if (timestampRegex.test(line)) {
    if (currentEntry) {
      entries.push(currentEntry);
    }
    currentEntry = { timestamp: line, lines: [] };
  } else {
    if (currentEntry) {
      currentEntry.lines.push(line);
    }
  }
}
if (currentEntry) {
  entries.push(currentEntry);
}

console.log(`Parsed ${entries.length} raw timestamped entries.`);

// Let's analyze and match each entry
const matched = [];
const unmatched = [];

for (let i = 0; i < entries.length; i++) {
  const e = entries[i];
  const eLines = e.lines;
  
  // Find roll number, email, name among lines
  let rollCandidate = null;
  let emailCandidate = null;
  let nameCandidate = null;
  
  // Potential roll number regex: /^[BbIiMm\d]{5,8}$/i or contains 'b26...' or 'im26...'
  for (const l of eLines) {
    const cleanL = l.trim();
    // Roll number check: starts with B, IM, etc. like B26227, IM26072, b26032, B2617, B26352, etc.
    if (/^(b|im|d|ud|dd)?\d{4,6}$/i.test(cleanL)) {
      rollCandidate = cleanL.toUpperCase();
    }
    // Email check
    if (cleanL.includes('@')) {
      emailCandidate = cleanL.toLowerCase();
    }
  }

  // Try matching against DB
  let student = null;

  // 1. Try by extracted roll
  if (rollCandidate) {
    student = byRoll.get(rollCandidate);
    // If not found directly, check variations (e.g. B2617 -> B26107?)
  }

  // 2. If not matched, try matching by any line as roll
  if (!student) {
    for (const l of eLines) {
      const cand = l.toUpperCase().replace(/\s+/g, '');
      if (byRoll.has(cand)) {
        student = byRoll.get(cand);
        rollCandidate = cand;
        break;
      }
    }
  }

  // 3. Try matching by email
  if (!student) {
    for (const l of eLines) {
      const cand = l.toLowerCase().replace(/\[|\]|\(|\)|http:\/\/|https:\/\//g, '').trim();
      if (byEmail.has(cand)) {
        student = byEmail.get(cand);
        break;
      }
      // Try if email is like b26xxx@students.iitmandi.ac.in
      const m = cand.match(/([b|im]\d+)@/i);
      if (m && byRoll.has(m[1].toUpperCase())) {
        student = byRoll.get(m[1].toUpperCase());
        break;
      }
    }
  }

  // 4. Try matching by name
  if (!student) {
    for (const l of eLines) {
      const cand = l.toLowerCase().trim();
      if (cand.length > 2 && byName.has(cand)) {
        student = byName.get(cand);
        break;
      }
    }
  }

  if (student) {
    matched.push({
      entryIndex: i + 1,
      timestamp: e.timestamp,
      rawLines: eLines,
      student,
      roll: student.roll_number,
      name: student.name,
    });
  } else {
    unmatched.push({
      entryIndex: i + 1,
      timestamp: e.timestamp,
      rawLines: eLines,
    });
  }
}

console.log(`Matched: ${matched.length}/${entries.length}`);
if (unmatched.length > 0) {
  console.log('UNMATCHED ENTRIES:', JSON.stringify(unmatched, null, 2));
}

// Check for duplicates
const uniqueStudents = new Map();
const duplicates = [];

for (const m of matched) {
  if (uniqueStudents.has(m.student.id)) {
    duplicates.push(m);
  } else {
    uniqueStudents.set(m.student.id, m);
  }
}

console.log(`Unique students: ${uniqueStudents.size}`);
console.log(`Duplicate submissions in sheet: ${duplicates.length}`);
if (duplicates.length > 0) {
  console.log('Duplicates:', duplicates.map(d => `${d.roll} (${d.name}) at ${d.timestamp}`));
}
