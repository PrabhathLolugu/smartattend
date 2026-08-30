import fs from 'fs';

const records = JSON.parse(fs.readFileSync('scripts/parsed_attendance_records.json', 'utf8'));

console.log(`Total parsed records: ${records.length}`);
const nullStudents = records.filter(r => !r.matchedStudent);
console.log(`Null students: ${nullStudents.length}`);

const uniqueRolls = new Set(records.map(r => r.matchedStudent.roll_number));
console.log(`Unique roll numbers: ${uniqueRolls.size}`);

// Print summary by group
const groupCounts = {};
for (const r of records) {
  const g = r.matchedStudent.group || 'Unassigned';
  groupCounts[g] = (groupCounts[g] || 0) + 1;
}
console.log('Counts by group:', JSON.stringify(groupCounts, null, 2));
