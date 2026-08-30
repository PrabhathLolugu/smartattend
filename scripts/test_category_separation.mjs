import assert from 'assert';

function getSessionCategory(sessionType) {
  const t = (sessionType || '').toLowerCase();
  if (t.includes('yoga') || t.includes('practical') || t.includes('lab') || t.includes('activity')) {
    return 'yoga_practical';
  }
  return 'theory_lecture';
}

function calculateStudentSummaries(sessions, records, student) {
  // Map records for this student
  const studentRecsMap = new Map();
  for (const r of records) {
    const matchId = r.student_id && r.student_id === student.id;
    const matchRoll = r.roll_number && r.roll_number.toUpperCase() === student.roll_number.toUpperCase();
    if (matchId || matchRoll) {
      studentRecsMap.set(r.session_id, r);
    }
  }

  // Separate sessions into rounds and standalone sessions
  const standaloneSessions = [];
  const roundMap = new Map(); // round_id -> Session[]

  for (const s of sessions) {
    if (s.round_id) {
      const list = roundMap.get(s.round_id) || [];
      list.push(s);
      roundMap.set(s.round_id, list);
    } else {
      standaloneSessions.push(s);
    }
  }

  let theoryTot = 0;
  let theoryPres = 0;
  let practicalTot = 0;
  let practicalPres = 0;
  let excusedTot = 0;
  let manualTot = 0;
  let overrideTot = 0;

  // 1. Process Standalone Sessions
  for (const s of standaloneSessions) {
    const applicable = !s.group_filter || s.group_filter === student.group_label;
    const rec = studentRecsMap.get(s.id);
    const attended = rec && ['present', 'manual', 'override'].includes(rec.status);
    const isExcused = rec && rec.status === 'excused';
    const cat = getSessionCategory(s.session_type);

    if (isExcused) {
      excusedTot += 1;
    }

    if (!applicable && !attended) {
      continue;
    }

    if (cat === 'theory_lecture') {
      theoryTot += 1;
      if (attended) {
        theoryPres += 1;
        if (rec.method === 'manual' || rec.status === 'manual') manualTot += 1;
        if (['override_code', 'instructor_approved', 'gps_flagged'].includes(rec.method) || rec.status === 'override') overrideTot += 1;
      }
    } else {
      practicalTot += 1;
      if (attended) {
        practicalPres += 1;
        if (rec.method === 'manual' || rec.status === 'manual') manualTot += 1;
        if (['override_code', 'instructor_approved', 'gps_flagged'].includes(rec.method) || rec.status === 'override') overrideTot += 1;
      }
    }
  }

  // 2. Process Activity Rounds (Parallel sessions under same round count as 1 slot)
  for (const [roundId, roundSessions] of roundMap.entries()) {
    const cat = getSessionCategory(roundSessions[0]?.session_type);
    const appliesToStudent = roundSessions.some((s) => !s.group_filter || s.group_filter === student.group_label);
    const attendedAny = roundSessions.some((s) => {
      const rec = studentRecsMap.get(s.id);
      return rec && ['present', 'manual', 'override'].includes(rec.status);
    });
    const excusedAny = roundSessions.some((s) => {
      const rec = studentRecsMap.get(s.id);
      return rec && rec.status === 'excused';
    });

    if (excusedAny && !attendedAny) {
      excusedTot += 1;
    }

    if (!appliesToStudent && !attendedAny) {
      continue;
    }

    if (cat === 'theory_lecture') {
      theoryTot += 1;
      if (attendedAny) theoryPres += 1;
    } else {
      practicalTot += 1;
      if (attendedAny) practicalPres += 1;
    }
  }

  const totalHeld = theoryTot + practicalTot;
  const totalPres = theoryPres + practicalPres;

  return {
    theory_present_count: theoryPres,
    theory_total_sessions: theoryTot,
    theory_percentage: theoryTot === 0 ? (theoryPres > 0 ? 100 : 0) : Math.round((theoryPres / theoryTot) * 1000) / 10,
    practical_present_count: practicalPres,
    practical_total_sessions: practicalTot,
    practical_percentage: practicalTot === 0 ? (practicalPres > 0 ? 100 : 0) : Math.round((practicalPres / practicalTot) * 1000) / 10,
    present_count: totalPres,
    excused_count: excusedTot,
    manual_count: manualTot,
    override_count: overrideTot,
    total_sessions: totalHeld,
    attendance_percentage: totalHeld === 0 ? (totalPres > 0 ? 100 : 0) : Math.round((totalPres / totalHeld) * 1000) / 10,
  };
}

console.log('--- TEST 1: Parallel Sessions for Different Groups in the Same Slot ---');
const studentGroupA = { id: 'sa', roll_number: 'B26001', name: 'Alice', group_label: 'A' };
const studentGroupB = { id: 'sb', roll_number: 'B26002', name: 'Bob', group_label: 'B' };

const parallelSessions = [
  // Two parallel Yoga sessions for Group A and Group B
  { id: 'sess_yoga_a', session_type: 'Yoga', group_filter: 'A', round_id: null },
  { id: 'sess_yoga_b', session_type: 'Yoga', group_filter: 'B', round_id: null },
  // One general Theory Lecture for all
  { id: 'sess_theory_all', session_type: 'Lecture', group_filter: null, round_id: null },
];

const parallelRecords = [
  // Alice attended Group A Yoga & Theory
  { session_id: 'sess_yoga_a', student_id: 'sa', roll_number: 'B26001', status: 'present', method: 'gps' },
  { session_id: 'sess_theory_all', student_id: 'sa', roll_number: 'B26001', status: 'present', method: 'gps' },
  // Bob attended Group B Yoga only
  { session_id: 'sess_yoga_b', student_id: 'sb', roll_number: 'B26002', status: 'present', method: 'gps' },
];

const resAlice = calculateStudentSummaries(parallelSessions, parallelRecords, studentGroupA);
console.log('Alice (Group A):', resAlice);
assert.strictEqual(resAlice.theory_total_sessions, 1, 'Alice has 1 theory session');
assert.strictEqual(resAlice.theory_present_count, 1, 'Alice attended theory');
assert.strictEqual(resAlice.practical_total_sessions, 1, 'Alice has 1 practical session (Group B practical is NOT counted in her denominator)');
assert.strictEqual(resAlice.practical_present_count, 1, 'Alice attended her practical session');
assert.strictEqual(resAlice.practical_percentage, 100.0);
assert.strictEqual(resAlice.attendance_percentage, 100.0);

const resBob = calculateStudentSummaries(parallelSessions, parallelRecords, studentGroupB);
console.log('Bob (Group B):', resBob);
assert.strictEqual(resBob.theory_total_sessions, 1, 'Bob has 1 theory session');
assert.strictEqual(resBob.theory_present_count, 0, 'Bob missed theory');
assert.strictEqual(resBob.practical_total_sessions, 1, 'Bob has 1 practical session (Group A practical is NOT counted in his denominator)');
assert.strictEqual(resBob.practical_present_count, 1, 'Bob attended his practical session');
assert.strictEqual(resBob.practical_percentage, 100.0);
assert.strictEqual(resBob.theory_percentage, 0.0);
assert.strictEqual(resBob.attendance_percentage, 50.0);

console.log('\n--- TEST 2: Parallel Sessions under the Same Activity Round ---');
const roundSessions = [
  // Round 1 has 3 parallel sessions for Group A, B, C
  { id: 'r1_a', session_type: 'Yoga', group_filter: 'A', round_id: 'round_1' },
  { id: 'r1_b', session_type: 'Yoga', group_filter: 'B', round_id: 'round_1' },
  { id: 'r1_c', session_type: 'Yoga', group_filter: 'C', round_id: 'round_1' },
];
// Alice is in group A, attends session r1_a
const roundRecs = [
  { session_id: 'r1_a', student_id: 'sa', roll_number: 'B26001', status: 'present', method: 'gps' },
];
const resAliceRound = calculateStudentSummaries(roundSessions, roundRecs, studentGroupA);
console.log('Alice Round 1:', resAliceRound);
assert.strictEqual(resAliceRound.practical_total_sessions, 1, 'Round 1 with 3 parallel sessions counts as 1 practical session total');
assert.strictEqual(resAliceRound.practical_present_count, 1);
assert.strictEqual(resAliceRound.practical_percentage, 100.0);

console.log('\n--- ALL PARALLEL SESSION CONFLICT CHECKS PASSED! ---');
