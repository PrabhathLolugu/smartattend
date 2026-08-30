import fs from 'fs';

const raw = fs.readFileSync('scripts/raw_attendance_input.txt', 'utf8');
const dbStudents = JSON.parse(fs.readFileSync('scripts/db_students.json', 'utf8'));

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

const lines = raw.split('\n').map(l => l.trim()).filter(l => l.length > 0);
const timestampRegex = /^\d{1,2}\/\d{1,2}\/\d{4}\s+\d{1,2}:\d{2}:\d{2}/;

const entries = [];
let currentEntry = null;

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  if (timestampRegex.test(line)) {
    if (currentEntry) entries.push(currentEntry);
    currentEntry = { timestamp: line, lines: [] };
  } else {
    if (currentEntry) currentEntry.lines.push(line);
  }
}
if (currentEntry) entries.push(currentEntry);

const auditList = [];

for (let i = 0; i < entries.length; i++) {
  const e = entries[i];
  const eLines = e.lines;

  let rollCandidate = null;
  for (const l of eLines) {
    const cleanL = l.trim();
    if (/^(b|im|d|ud|dd)?\d{4,6}$/i.test(cleanL)) {
      rollCandidate = cleanL.toUpperCase();
    }
  }

  let student = null;
  let matchMethod = '';

  if (rollCandidate && byRoll.has(rollCandidate)) {
    student = byRoll.get(rollCandidate);
    matchMethod = 'direct_roll';
  }

  if (!student) {
    for (const l of eLines) {
      const cand = l.toUpperCase().replace(/\s+/g, '');
      if (byRoll.has(cand)) {
        student = byRoll.get(cand);
        matchMethod = 'cleaned_roll';
        break;
      }
    }
  }

  if (!student) {
    for (const l of eLines) {
      const cand = l.toLowerCase().replace(/\[|\]|\(|\)|http:\/\/|https:\/\//g, '').trim();
      if (byEmail.has(cand)) {
        student = byEmail.get(cand);
        matchMethod = 'email';
        break;
      }
      const m = cand.match(/([b|im]\d+)@/i);
      if (m && byRoll.has(m[1].toUpperCase())) {
        student = byRoll.get(m[1].toUpperCase());
        matchMethod = 'email_prefix';
        break;
      }
    }
  }

  if (!student) {
    for (const l of eLines) {
      const cand = l.toLowerCase().trim();
      if (cand.length > 2 && byName.has(cand)) {
        student = byName.get(cand);
        matchMethod = 'name';
        break;
      }
    }
  }

  auditList.push({
    index: i + 1,
    timestamp: e.timestamp,
    inputLines: eLines,
    matchedStudent: student ? {
      id: student.id,
      roll_number: student.roll_number,
      name: student.name,
      email: student.email,
      group: student.group_label
    } : null,
    matchMethod
  });
}

// Find cases where matchMethod was not direct_roll or roll candidate != student.roll_number
const interestingCases = auditList.filter(a => a.matchMethod !== 'direct_roll' || a.inputLines.every(l => l.toUpperCase() !== a.matchedStudent.roll_number));
console.log('Interesting / corrected cases:', JSON.stringify(interestingCases, null, 2));

fs.writeFileSync('scripts/parsed_attendance_records.json', JSON.stringify(auditList, null, 2));
console.log(`Wrote ${auditList.length} records to scripts/parsed_attendance_records.json`);
