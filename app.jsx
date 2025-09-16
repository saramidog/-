const { useEffect, useMemo, useRef, useState } = React;

// =============================
// シフト作成アプリ（ベータ）— v7.2
// =============================

// ====== 定数 ======
const EMPTY = "(空)";
const SHIFTS = ["早番", "中遅", "遅番", "通常", "休み", EMPTY];
const FAIRNESS_TARGET_SHIFTS = new Set(["早番", "中遅", "遅番"]);
const CAP_SHIFT_CHOICES = ["*", "早番", "中遅", "遅番", "通常"];
const GAP_SHIFT_CHOICES = ["*", "早番", "中遅", "遅番"];
function capLabel(v) {
  return v === "*" ? "全対象(早/中遅/遅)" : v;
}
function gapLabel(v) {
  return v === "*" ? "全対象(早/中遅/遅)" : v;
}

// デフォルト職員
const DEFAULT_STAFF = [
  { id: "H1", name: "H①" },
  { id: "H2", name: "H②" },
  { id: "H3", name: "H③" },
  { id: "H4", name: "H④" },
  { id: "H5", name: "H⑤" },
  { id: "H6", name: "H⑥" },
];

// 今日からデフォルト年月
const today = new Date();
const DEFAULT_YEAR = today.getFullYear();
const DEFAULT_MONTH = today.getMonth() + 1;

// ====== 汎用関数 ======
function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}
function ymdKey(y, m, d) {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
function weekday(y, m, d) {
  return new Date(y, m - 1, d).getDay();
}
function weekdayLabel(w) {
  return ["日", "月", "火", "水", "木", "金", "土"][w];
}
function csvEscape(s) {
  s = String(s ?? "");
  if (s.includes(",") || s.includes("\n") || s.includes("\"")) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function setToMap(obj) {
  const json = {};
  for (const k of Object.keys(obj)) {
    json[k] = Array.from(obj[k]);
  }
  return json;
}
function mapToSet(json) {
  const obj = {};
  for (const k of Object.keys(json || {})) {
    obj[k] = new Set(json[k]);
  }
  return obj;
}
function toggleSetMap(prev, staffId, key) {
  const next = { ...prev };
  const set = new Set(next[staffId] || []);
  if (set.has(key)) {
    set.delete(key);
  } else {
    set.add(key);
  }
  next[staffId] = set;
  return next;
}

// ====== スケジューリング補助 ======
function requiredShiftsForDay(day) {
  if (day.isHoliday || day.w === 0) return [];
  if (day.w === 6) return ["早番", "遅番"];
  return ["早番", "中遅", "遅番"];
}

function daysSinceSameShiftIn(sched, staffId, dateIndex, shift, daysArr, limitDays) {
  const maxBack = Math.min(limitDays ?? daysArr.length, dateIndex);
  for (let back = 1; back <= maxBack; back++) {
    const prevIdx = dateIndex - back;
    if (prevIdx < 0) break;
    const prevKey = daysArr[prevIdx].key;
    const prevVal = sched[staffId]?.[prevKey] ?? EMPTY;
    if (prevVal === shift) return back;
  }
  return Infinity;
}

function countAssignedInWeek(sched, staffId, daysArr, weekIdx, shiftSet) {
  let n = 0;
  for (const d of daysArr) {
    if (d.week !== weekIdx) continue;
    const v = sched[staffId]?.[d.key] ?? EMPTY;
    if (shiftSet.has(v)) n++;
  }
  return n;
}

// ====== ルールモデル ======
const DEFAULT_RULES = {
  fairnessGapDays: 4,
  absoluteDayOff: true,
  saturdayOthersOff: true,
  restOnlyByRequest: true,
  mustRules: [
    { staffId: "H6", dayOfWeek: 3, must: "早番" },
    { staffId: "H5", dayOfWeek: 3, must: "通常" },
  ],
  cannotRules: [{ staffId: "H2", dayOfWeek: 4, cannot: ["中遅", "遅番"] }],
  pairConflicts: [{ a: "H4", b: "H5", conflictShifts: ["中遅", "遅番"] }],
  weeklyCaps: [],
  minGapRules: [],
};

// ====== ルール編集ヘルパ ======
function updateMust(idx, patch, setRules) {
  return setRules((prev) => {
    const arr = [...prev.mustRules];
    arr[idx] = { ...arr[idx], ...patch };
    return { ...prev, mustRules: arr };
  });
}
function removeMust(idx, setRules) {
  return setRules((prev) => {
    const arr = [...prev.mustRules];
    arr.splice(idx, 1);
    return { ...prev, mustRules: arr };
  });
}
function addMustRule(setRules, staff) {
  return setRules((prev) => ({
    ...prev,
    mustRules: [
      ...prev.mustRules,
      { staffId: staff[0]?.id ?? "", dayOfWeek: 1, must: "早番" },
    ],
  }));
}

function updateCannot(idx, patch, setRules) {
  return setRules((prev) => {
    const arr = [...prev.cannotRules];
    arr[idx] = { ...arr[idx], ...patch };
    return { ...prev, cannotRules: arr };
  });
}
function toggleCannotShift(idx, shift, setRules) {
  return setRules((prev) => {
    const arr = [...prev.cannotRules];
    const r = { ...arr[idx] };
    const set = new Set(r.cannot);
    if (set.has(shift)) set.delete(shift);
    else set.add(shift);
    r.cannot = Array.from(set);
    arr[idx] = r;
    return { ...prev, cannotRules: arr };
  });
}
function removeCannot(idx, setRules) {
  return setRules((prev) => {
    const arr = [...prev.cannotRules];
    arr.splice(idx, 1);
    return { ...prev, cannotRules: arr };
  });
}
function addCannotRule(setRules, staff) {
  return setRules((prev) => ({
    ...prev,
    cannotRules: [
      ...prev.cannotRules,
      { staffId: staff[0]?.id ?? "", dayOfWeek: 4, cannot: ["遅番"] },
    ],
  }));
}

function updatePair(idx, patch, setRules) {
  return setRules((prev) => {
    const arr = [...prev.pairConflicts];
    arr[idx] = { ...arr[idx], ...patch };
    return { ...prev, pairConflicts: arr };
  });
}
function togglePairShift(idx, shift, setRules) {
  return setRules((prev) => {
    const arr = [...prev.pairConflicts];
    const r = { ...arr[idx] };
    const set = new Set(r.conflictShifts);
    if (set.has(shift)) set.delete(shift);
    else set.add(shift);
    r.conflictShifts = Array.from(set);
    arr[idx] = r;
    return { ...prev, pairConflicts: arr };
  });
}
function addPairRule(setRules, staff) {
  return setRules((prev) => {
    if (!staff || staff.length < 2) return { ...prev };
    return {
      ...prev,
      pairConflicts: [
        ...prev.pairConflicts,
        { a: staff[0].id, b: staff[1].id, conflictShifts: ["中遅", "遅番"] },
      ],
    };
  });
}
function removePair(idx, setRules) {
  return setRules((prev) => {
    const arr = [...prev.pairConflicts];
    arr.splice(idx, 1);
    return { ...prev, pairConflicts: arr };
  });
}

function addWeeklyCapRule(setRules, staff) {
  return setRules((prev) => ({
    ...prev,
    weeklyCaps: [
      ...(prev.weeklyCaps || []),
      { staffId: staff[0]?.id ?? "", shift: "*", perWeek: 3 },
    ],
  }));
}
function updateWeeklyCap(idx, patch, setRules) {
  return setRules((prev) => {
    const arr = [...(prev.weeklyCaps || [])];
    arr[idx] = { ...arr[idx], ...patch };
    return { ...prev, weeklyCaps: arr };
  });
}
function removeWeeklyCap(idx, setRules) {
  return setRules((prev) => {
    const arr = [...(prev.weeklyCaps || [])];
    arr.splice(idx, 1);
    return { ...prev, weeklyCaps: arr };
  });
}

function addMinGapRule(setRules, staff) {
  return setRules((prev) => ({
    ...prev,
    minGapRules: [
      ...(prev.minGapRules || []),
      {
        staffId: staff[0]?.id ?? "",
        shift: "*",
        minGapDays: prev.fairnessGapDays ?? 2,
      },
    ],
  }));
}
function updateMinGapRule(idx, patch, setRules) {
  return setRules((prev) => {
    const arr = [...(prev.minGapRules || [])];
    arr[idx] = { ...arr[idx], ...patch };
    return { ...prev, minGapRules: arr };
  });
}
function removeMinGapRule(idx, setRules) {
  return setRules((prev) => {
    const arr = [...(prev.minGapRules || [])];
    arr.splice(idx, 1);
    return { ...prev, minGapRules: arr };
  });
}
function getEffectiveMinGap(rules, staffId, role) {
  const list = rules.minGapRules || [];
  const specific = list.find((r) => r.staffId === staffId && r.shift === role);
  if (specific) return Math.max(0, parseInt(specific.minGapDays || 0, 10));
  const generic = list.find((r) => r.staffId === staffId && r.shift === "*");
  if (generic) return Math.max(0, parseInt(generic.minGapDays || 0, 10));
  return FAIRNESS_TARGET_SHIFTS.has(role) ? rules.fairnessGapDays ?? 0 : 0;
}

// ====== CSV 出力 ======
function buildCsvString(staffList, dayList, sched, nameOf) {
  const headers = ["氏名", ...dayList.map((d) => `${d.d}(${weekdayLabel(d.w)})`)];
  const rows = staffList.map((s) => [
    nameOf(s.id),
    ...dayList.map((d) => {
      const v = sched[s.id]?.[d.key];
      return v === EMPTY ? "" : v || "";
    }),
  ]);
  return [headers, ...rows]
    .map((r) => r.map(csvEscape).join(","))
    .join("\n");
}

function App() {
  const [year, setYear] = useState(DEFAULT_YEAR);
  const [month, setMonth] = useState(DEFAULT_MONTH);
  const [staff, setStaff] = useState(DEFAULT_STAFF);
  const [holidays, setHolidays] = useState({});
  const [dayOff, setDayOff] = useState({});
  const [rules, setRules] = useState(DEFAULT_RULES);
  const [schedule, setSchedule] = useState({});
  const [mode, setMode] = useState("edit");
  const [selectedStaffId, setSelectedStaffId] = useState(staff[0]?.id ?? "");

  const [assignMode, setAssignMode] = useState("cycle");
  const [brushShift, setBrushShift] = useState("通常");
  const [staffFilter, setStaffFilter] = useState("");
  const [highlightIssues, setHighlightIssues] = useState(true);

  const [newStaffName, setNewStaffName] = useState("");
  const [editing, setEditing] = useState({ id: null, name: "" });
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);

  const dlRef = useRef(null);

  const LS_KEY = "shift_app_v7_2";
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(LS_KEY);
      if (!saved) return;
      const j = JSON.parse(saved);
      if (j.year) setYear(j.year);
      if (j.month) setMonth(j.month);
      if (j.staff) setStaff(j.staff);
      if (j.holidays) setHolidays(j.holidays);
      if (j.dayOff) setDayOff(mapToSet(j.dayOff));
      if (j.rules) setRules(j.rules);
      if (j.schedule) setSchedule(j.schedule);
    } catch (e) {
      console.warn("Load from localStorage failed", e);
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        LS_KEY,
        JSON.stringify({
          year,
          month,
          staff,
          holidays,
          dayOff: setToMap(dayOff),
          rules,
          schedule,
        })
      );
    } catch (e) {
      console.warn("LocalStorage unavailable:", e);
    }
  }, [year, month, staff, holidays, dayOff, rules, schedule]);

  useEffect(() => {
    if (!staff.some((s) => s.id === selectedStaffId)) {
      setSelectedStaffId(staff[0]?.id ?? "");
    }
  }, [staff, selectedStaffId]);

  const ndays = useMemo(() => daysInMonth(year, month), [year, month]);
  const days = useMemo(() => {
    const arr = [];
    let week = 0;
    for (let i = 0; i < ndays; i++) {
      const d = i + 1;
      const w = weekday(year, month, d);
      if (i > 0 && w === 0) week++;
      const key = ymdKey(year, month, d);
      arr.push({ d, w, key, isHoliday: !!holidays[key], week });
    }
    return arr;
  }, [year, month, ndays, holidays]);

  const counts = useMemo(() => {
    const c = {};
    for (const s of staff) {
      c[s.id] = { 早番: 0, 中遅: 0, 遅番: 0, 通常: 0, 休み: 0, 空: 0 };
    }
    for (const s of staff) {
      const row = schedule[s.id] || {};
      for (const day of days) {
        const sh = row[day.key] || EMPTY;
        if (sh === EMPTY) c[s.id].空++;
        else if (c[s.id][sh] !== undefined) c[s.id][sh]++;
        else c[s.id].空++;
      }
    }
    return c;
  }, [schedule, staff, days]);

  const viewStaff = useMemo(
    () =>
      staff.filter((s) =>
        s.name.toLowerCase().includes(staffFilter.toLowerCase())
      ),
    [staff, staffFilter]
  );

  function onCellClick(targetStaffId, key) {
    if (mode === "edit") {
      setSchedule((prev) => {
        const row = { ...(prev[targetStaffId] || {}) };
        const current = row[key] || EMPTY;
        let next = current;
        if (assignMode === "cycle") {
          const idx = SHIFTS.indexOf(current);
          next = SHIFTS[(idx + 1) % SHIFTS.length];
        } else {
          next = current === brushShift ? EMPTY : brushShift;
        }
        row[key] = next;
        return { ...prev, [targetStaffId]: row };
      });
    } else if (mode === "off-req") {
      setDayOff((prev) => toggleSetMap(prev, targetStaffId, key));
    }
  }

  function toggleHoliday(key) {
    setHolidays((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  function bulkApply({
    staffId,
    weekIdx = "all",
    shift,
    weekdaysOnly = false,
    excludeHolidays = true,
  }) {
    setSchedule((prev) => {
      const row = { ...(prev[staffId] || {}) };
      for (const d of days) {
        if (weekIdx !== "all" && d.week !== weekIdx) continue;
        if (weekdaysOnly && (d.w === 0 || d.w === 6)) continue;
        if (excludeHolidays && (d.isHoliday || d.w === 0)) continue;
        row[d.key] = shift;
      }
      return { ...prev, [staffId]: row };
    });
  }

  function autoAssign() {
    const newSchedule = {};
    for (const s of staff) {
      newSchedule[s.id] = {};
      for (const day of days) newSchedule[s.id][day.key] = EMPTY;
    }
    for (let i = 0; i < days.length; i++) {
      const day = days[i];
      const req = requiredShiftsForDay(day);
      if (req.length === 0) {
        for (const s of staff) {
          if (rules.absoluteDayOff && dayOff[s.id]?.has(day.key)) {
            newSchedule[s.id][day.key] = "休み";
          }
        }
        continue;
      }
      const tempAssignments = {};
      for (const role of req) {
        const must = rules.mustRules.find(
          (r) => r.dayOfWeek === day.w && r.must === role
        );
        let candidates = staff.filter((s) => {
          if (rules.absoluteDayOff && dayOff[s.id]?.has(day.key)) return false;
          if (Object.prototype.hasOwnProperty.call(tempAssignments, s.id))
            return false;
          const mustOther = rules.mustRules.find(
            (r) => r.staffId === s.id && r.dayOfWeek === day.w
          );
          if (mustOther && mustOther.must !== role) return false;
          const cannotHit = (rules.cannotRules || []).some(
            (r) =>
              r.staffId === s.id &&
              r.dayOfWeek === day.w &&
              (r.cannot || []).includes(role)
          );
          if (cannotHit) return false;
          const other = rules.pairConflicts.find(
            (p) => p.a === s.id || p.b === s.id
          );
          if (other) {
            const mate = other.a === s.id ? other.b : other.a;
            const mateShift = tempAssignments[mate];
            if (
              mateShift &&
              other.conflictShifts.includes(role) &&
              other.conflictShifts.includes(mateShift)
            )
              return false;
          }
          const minGap = getEffectiveMinGap(rules, s.id, role);
          if (minGap > 0) {
            const back = daysSinceSameShiftIn(
              newSchedule,
              s.id,
              i,
              role,
              days,
              minGap
            );
            if (back <= minGap) return false;
          }
          for (const cap of rules.weeklyCaps || []) {
            if (cap.staffId !== s.id) continue;
            const targetSet =
              cap.shift === "*"
                ? new Set(FAIRNESS_TARGET_SHIFTS)
                : new Set([cap.shift]);
            const current = countAssignedInWeek(
              newSchedule,
              s.id,
              days,
              day.week,
              targetSet
            );
            const plus = targetSet.has(role) ? 1 : 0;
            if (current + plus > (cap.perWeek ?? 0)) return false;
          }
          return true;
        });
        if (must) candidates = candidates.filter((c) => c.id === must.staffId);
        candidates.sort((a, b) => {
          const ca = countRole(newSchedule, a.id, role, days);
          const cb = countRole(newSchedule, b.id, role, days);
          if (ca !== cb) return ca - cb;
          const la = lastIndexOfRole(newSchedule, a.id, role, days);
          const lb = lastIndexOfRole(newSchedule, b.id, role, days);
          return la - lb;
        });
        const chosen = candidates[0];
        if (chosen) {
          newSchedule[chosen.id][day.key] = role;
          tempAssignments[chosen.id] = role;
        }
      }
      for (const s of staff) {
        if (newSchedule[s.id][day.key] === EMPTY) {
          if (rules.absoluteDayOff && dayOff[s.id]?.has(day.key)) {
            newSchedule[s.id][day.key] = "休み";
          } else if (!rules.restOnlyByRequest && day.w === 6 && rules.saturdayOthersOff) {
            newSchedule[s.id][day.key] = "休み";
          } else {
            const cannotNormal = (rules.cannotRules || []).some(
              (r) =>
                r.staffId === s.id &&
                r.dayOfWeek === day.w &&
                (r.cannot || []).includes("通常")
            );
            newSchedule[s.id][day.key] = cannotNormal ? EMPTY : "通常";
          }
        }
      }
    }
    setSchedule(newSchedule);
  }
  function countRole(sched, staffId, role, daysArr) {
    let n = 0;
    for (const d of daysArr)
      if ((sched[staffId]?.[d.key] || EMPTY) === role) n++;
    return n;
  }
  function lastIndexOfRole(sched, staffId, role, daysArr) {
    let last = -1;
    for (let i = 0; i < daysArr.length; i++)
      if ((sched[staffId]?.[daysArr[i].key] || EMPTY) === role) {
        last = i;
      }
    return last;
  }

  function getStaffName(id) {
    return staff.find((s) => s.id === id)?.name || id;
  }
  function hasIssueForCell(staffId, key, issues) {
    return (
      highlightIssues &&
      issues.some((p) => p.key === key && (!p.staffId || p.staffId === staffId))
    );
  }
  function resetSchedule() {
    setSchedule({});
  }

  function addStaffInline() {
    const name = newStaffName.trim();
    if (!name) return;
    const newId = `U${Date.now().toString(36)}`;
    setStaff((prev) => [...prev, { id: newId, name }]);
    setNewStaffName("");
  }
  function beginRename(id) {
    setEditing({ id, name: getStaffName(id) });
  }
  function cancelRename() {
    setEditing({ id: null, name: "" });
  }
  function commitRename() {
    const id = editing.id;
    if (!id) return;
    const name = editing.name.trim();
    if (!name) return cancelRename();
    setStaff((prev) => prev.map((s) => (s.id === id ? { ...s, name } : s)));
    cancelRename();
  }
  function askDelete(id) {
    setConfirmDeleteId((prev) => (prev === id ? null : id));
  }
  function doDelete(id) {
    setStaff((prev) => prev.filter((s) => s.id !== id));
    setSchedule((prev) => {
      const n = { ...prev };
      delete n[id];
      return n;
    });
    setDayOff((prev) => {
      const n = { ...prev };
      delete n[id];
      return n;
    });
    setRules((prev) => ({
      ...prev,
      mustRules: prev.mustRules.filter((r) => r.staffId !== id),
      cannotRules: prev.cannotRules.filter((r) => r.staffId !== id),
      pairConflicts: prev.pairConflicts.filter(
        (p) => p.a !== id && p.b !== id
      ),
      weeklyCaps: (prev.weeklyCaps || []).filter((w) => w.staffId !== id),
      minGapRules: (prev.minGapRules || []).filter((g) => g.staffId !== id),
    }));
    if (selectedStaffId === id) {
      setSelectedStaffId(staff.find((s) => s.id !== id)?.id ?? "");
    }
    setConfirmDeleteId(null);
  }

  function exportCSV() {
    const csv = buildCsvString(staff, days, schedule, getStaffName);
    try {
      const blob = new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const filename = `シフト_${year}-${String(month).padStart(2, "0")}.csv`;

      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.rel = "noopener";
      if (typeof a.download === "undefined") a.target = "_blank";
      a.style.position = "fixed";
      a.style.left = "-9999px";
      a.style.top = "-9999px";
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        try {
          document.body.removeChild(a);
        } catch (e) {}
        URL.revokeObjectURL(url);
      }, 0);
    } catch (err) {
      console.error("CSVエクスポート失敗:", err);
      openCsvInNewTab(csv);
    }
  }
  function openCsvInNewTab(csv) {
    const dataUrl = "data:text/csv;charset=utf-8,\uFEFF" + encodeURIComponent(csv);
    const w = window.open(dataUrl, "_blank");
    if (!w)
      window.alert(
        "ポップアップがブロックされました。ポップアップ許可後にもう一度お試しください。"
      );
  }
  async function copyCsvToClipboard() {
    const csv = buildCsvString(staff, days, schedule, getStaffName);
    try {
      await navigator.clipboard.writeText("\uFEFF" + csv);
      window.alert("CSVをクリップボードにコピーしました。");
    } catch (e) {
      console.error("clipboard failed", e);
      window.alert(
        "クリップボードにコピーできませんでした（HTTPSや権限が必要な場合があります）。"
      );
    }
  }

  function printPage() {
    window.print();
  }

  const issues = useMemo(() => validateAll(), [
    schedule,
    rules,
    days,
    staff,
    dayOff,
  ]);
  function validateAll() {
    const problems = [];
    for (let i = 0; i < days.length; i++) {
      const day = days[i];
      const assignments = {};
      for (const s of staff) {
        assignments[s.id] = schedule[s.id]?.[day.key] || EMPTY;
      }
      const req = requiredShiftsForDay(day);
      for (const role of req) {
        const holders = staff.filter((s) => assignments[s.id] === role);
        if (holders.length === 0)
          problems.push({ key: day.key, message: `${day.d}日：${role}不足` });
        if (holders.length > 1)
          problems.push({ key: day.key, message: `${day.d}日：${role}が複数` });
      }
      if (!rules.restOnlyByRequest && (day.isHoliday || day.w === 0)) {
        for (const s of staff) {
          if (assignments[s.id] !== "休み") {
            problems.push({
              key: day.key,
              staffId: s.id,
              message: `${day.d}日：${getStaffName(s.id)}は休みにすべき日`,
            });
          }
        }
      }
      if (rules.absoluteDayOff) {
        for (const s of staff) {
          if (dayOff[s.id]?.has(day.key) && assignments[s.id] !== "休み") {
            problems.push({
              key: day.key,
              staffId: s.id,
              message: `${day.d}日：${getStaffName(s.id)}の希望休が守られていません`,
            });
          }
        }
      }
      for (const s of staff) {
        const sh = assignments[s.id];
        const must = rules.mustRules.find(
          (r) => r.staffId === s.id && r.dayOfWeek === day.w
        );
        if (must && sh !== must.must) {
          problems.push({
            key: day.key,
            staffId: s.id,
            message: `${day.d}日：${getStaffName(s.id)}は${must.must}必須`,
          });
        }
        const cannotHit = (rules.cannotRules || []).some(
          (r) =>
            r.staffId === s.id &&
            r.dayOfWeek === day.w &&
            (r.cannot || []).includes(sh)
        );
        if (cannotHit) {
          problems.push({
            key: day.key,
            staffId: s.id,
            message: `${day.d}日：${getStaffName(s.id)}は${sh}不可`,
          });
        }
      }
      for (const p of rules.pairConflicts) {
        const a = assignments[p.a];
        const b = assignments[p.b];
        if (p.conflictShifts.includes(a) && p.conflictShifts.includes(b)) {
          problems.push({
            key: day.key,
            message: `${day.d}日：${getStaffName(p.a)}と${getStaffName(p.b)}の同時配置NG`,
          });
        }
      }
      for (const s of staff) {
        const sh = assignments[s.id];
        const minGap = getEffectiveMinGap(rules, s.id, sh);
        if (minGap > 0) {
          const back = daysSinceSameShiftIn(schedule, s.id, i, sh, days, minGap);
          if (back <= minGap) {
            problems.push({
              key: day.key,
              staffId: s.id,
              message: `${day.d}日：${getStaffName(s.id)}の${sh}が間隔${back}日（最小${
                minGap + 1
              }日推奨）`,
            });
          }
        }
      }
    }
    const weeks = new Set(days.map((d) => d.week));
    for (const s of staff) {
      for (const cap of rules.weeklyCaps || []) {
        if (cap.staffId !== s.id) continue;
        const targetSet =
          cap.shift === "*"
            ? new Set(FAIRNESS_TARGET_SHIFTS)
            : new Set([cap.shift]);
        for (const wIdx of weeks) {
          const cnt = countAssignedInWeek(schedule, s.id, days, wIdx, targetSet);
          if (cnt > (cap.perWeek ?? 0)) {
            problems.push({
              key: `week-${wIdx}`,
              staffId: s.id,
              message: `第${wIdx + 1}週：${getStaffName(s.id)}の${capLabel(
                cap.shift
              )}が${cnt}回（上限${cap.perWeek}回）`,
            });
          }
        }
      }
    }
    return problems;
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <a
        ref={dlRef}
        style={{ position: "fixed", left: "-9999px", top: "-9999px" }}
        aria-hidden="true"
        tabIndex={-1}
      />

      <header className="p-4 border-b bg-white sticky top-0 z-20">
        <div className="max-w-7xl mx-auto flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
          <div>
            <h1 className="text-2xl font-bold">シフト作成アプリ（ベータ）</h1>
            <p className="text-xs text-slate-500">
              自動割当 → 検証 → 微調整 → CSV/印刷。未割当は「(空)」表示（CSVは空欄）。
            </p>
          </div>
          <div className="flex gap-2 items-center flex-wrap">
            <select
              className="border rounded px-2 py-1"
              value={year}
              onChange={(e) => setYear(parseInt(e.target.value, 10))}
            >
              {Array.from({ length: 6 }, (_, i) => today.getFullYear() - 2 + i).map(
                (y) => (
                  <option key={y} value={y}>
                    {y}年
                  </option>
                )
              )}
            </select>
            <select
              className="border rounded px-2 py-1"
              value={month}
              onChange={(e) => setMonth(parseInt(e.target.value, 10))}
            >
              {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                <option key={m} value={m}>
                  {m}月
                </option>
              ))}
            </select>

            <div className="hidden md:flex items-center gap-2 pl-2 ml-2 border-l">
              <span className="text-xs text-slate-500">割当モード</span>
              <select
                className="border rounded px-2 py-1"
                value={assignMode}
                onChange={(e) => setAssignMode(e.target.value)}
              >
                <option value="cycle">循環</option>
                <option value="paint">塗りつぶし</option>
              </select>
              {assignMode === "paint" && (
                <select
                  className="border rounded px-2 py-1"
                  value={brushShift}
                  onChange={(e) => setBrushShift(e.target.value)}
                >
                  {SHIFTS.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              )}
            </div>

            <button
              className="px-3 py-1 rounded bg-indigo-600 text-white hover:bg-indigo-700"
              onClick={autoAssign}
            >
              自動割当
            </button>
            <button
              className="px-3 py-1 rounded bg-white border hover:bg-slate-50"
              onClick={resetSchedule}
            >
              リセット
            </button>

            <div className="flex gap-2">
              <button
                className="px-3 py-1 rounded bg-white border hover:bg-slate-50"
                onClick={exportCSV}
              >
                CSV出力
              </button>
              <button
                className="px-3 py-1 rounded bg-white border hover:bg-slate-50"
                onClick={() =>
                  openCsvInNewTab(
                    buildCsvString(staff, days, schedule, getStaffName)
                  )
                }
              >
                新規タブ
              </button>
              <button
                className="px-3 py-1 rounded bg-white border hover:bg-slate-50"
                onClick={copyCsvToClipboard}
              >
                コピー
              </button>
              <button
                className="px-3 py-1 rounded bg-white border hover:bg-slate-50"
                onClick={printPage}
              >
                印刷
              </button>
            </div>
          </div>
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-4 pt-3">
        <div className="flex flex-wrap gap-2 text-xs text-slate-600">
          <span className="px-2 py-1 rounded bg-amber-50">早番</span>
          <span className="px-2 py-1 rounded bg-sky-50">中遅</span>
          <span className="px-2 py-1 rounded bg-indigo-50">遅番</span>
          <span className="px-2 py-1 rounded bg-emerald-50">通常</span>
          <span className="px-2 py-1 rounded bg-slate-100">休み</span>
          <span className="px-2 py-1 rounded">(空): 未割当</span>
          <label className="ml-auto flex items-center gap-2">
            <input
              type="checkbox"
              className="scale-110"
              checked={highlightIssues}
              onChange={(e) => setHighlightIssues(e.target.checked)}
            />
            問題を強調
          </label>
        </div>
      </div>

      <main className="max-w-7xl mx-auto p-4 grid grid-cols-1 lg:grid-cols-4 gap-4">
        <section className="lg:col-span-1 space-y-4">
          <div className="bg-white rounded-2xl shadow p-4">
            <h2 className="font-semibold mb-3">モード</h2>
            <div className="flex gap-2 flex-wrap">
              <button
                onClick={() => setMode("edit")}
                className={`px-3 py-1 rounded border ${
                  mode === "edit" ? "bg-indigo-600 text-white" : "bg-white"
                }`}
              >
                編集
              </button>
              <button
                onClick={() => setMode("off-req")}
                className={`px-3 py-1 rounded border ${
                  mode === "off-req" ? "bg-indigo-600 text-white" : "bg-white"
                }`}
              >
                希望休
              </button>
              <button
                onClick={() => setMode("holiday")}
                className={`px-3 py-1 rounded border ${
                  mode === "holiday" ? "bg-indigo-600 text-white" : "bg-white"
                }`}
              >
                園休日
              </button>
            </div>
            {mode === "off-req" && (
              <div className="mt-3 space-y-2">
                <label className="text-sm text-slate-600">
                  希望休を入力する職員：
                </label>
                <select
                  className="border rounded px-2 py-1 w-full"
                  value={selectedStaffId}
                  onChange={(e) => setSelectedStaffId(e.target.value)}
                >
                  {staff.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-slate-500">
                  この状態でセルをクリックすると、その職員の希望休をON/OFFします。
                </p>
              </div>
            )}
            {mode === "holiday" && (
              <p className="text-xs text-slate-500 mt-2">
                日付ヘッダをクリックで園休日の切替。
              </p>
            )}
          </div>

          <div className="bg-white rounded-2xl shadow p-4">
            <h2 className="font-semibold mb-3">スタッフ / 一括操作</h2>
            <input
              className="border rounded px-2 py-1 w-full mb-2"
              placeholder="名前で絞り込み"
              value={staffFilter}
              onChange={(e) => setStaffFilter(e.target.value)}
            />

            <BulkForm staff={staff} days={days} onApply={bulkApply} />
          </div>

          <RulesPanel rules={rules} setRules={setRules} staff={staff} />

          <div className="bg-white rounded-2xl shadow p-4">
            <h2 className="font-semibold mb-3">職員</h2>
            <div className="space-y-2 max-h-72 overflow-auto pr-1">
              {viewStaff.map((s) => (
                <div
                  key={s.id}
                  className="flex items-center justify-between gap-2 border rounded px-3 py-2"
                >
                  {editing.id === s.id ? (
                    <div className="flex-1 flex gap-2 items-center">
                      <input
                        className="border rounded px-2 py-1 w-full"
                        value={editing.name}
                        onChange={(e) =>
                          setEditing((ed) => ({ ...ed, name: e.target.value }))
                        }
                      />
                      <button
                        className="px-2 py-1 rounded border"
                        onClick={commitRename}
                      >
                        保存
                      </button>
                      <button
                        className="px-2 py-1 rounded border"
                        onClick={cancelRename}
                      >
                        取消
                      </button>
                    </div>
                  ) : (
                    <>
                      <span className="flex-1 truncate" title={s.name}>
                        {s.name}
                      </span>
                      <div className="flex gap-2">
                        <button
                          className="px-2 py-1 rounded border"
                          onClick={() => beginRename(s.id)}
                        >
                          名称
                        </button>
                        {confirmDeleteId === s.id ? (
                          <>
                            <button
                              className="px-2 py-1 rounded border border-rose-400 text-rose-600"
                              onClick={() => doDelete(s.id)}
                            >
                              本当に削除?
                            </button>
                            <button
                              className="px-2 py-1 rounded border"
                              onClick={() => askDelete(s.id)}
                            >
                              やめる
                            </button>
                          </>
                        ) : (
                          <button
                            className="px-2 py-1 rounded border"
                            onClick={() => askDelete(s.id)}
                          >
                            削除
                          </button>
                        )}
                      </div>
                    </>
                  )}
                </div>
              ))}
              <div className="flex gap-2">
                <input
                  className="border rounded px-2 py-1 flex-1"
                  placeholder="氏名を入力"
                  value={newStaffName}
                  onChange={(e) => setNewStaffName(e.target.value)}
                />
                <button
                  className="px-3 py-1 rounded border"
                  onClick={addStaffInline}
                >
                  追加
                </button>
              </div>
            </div>
          </div>
        </section>

        <section className="lg:col-span-3">
          <div className="bg-white rounded-2xl shadow overflow-auto max-h-[70vh]">
            <table className="min-w-full border-collapse">
              <thead className="sticky top-0 z-10 bg-white">
                <tr>
                  <th className="sticky left-0 bg-white border-b border-r p-2 text-left">
                    氏名
                  </th>
                  {days.map((day) => (
                    <th
                      key={day.key}
                      className={`border-b p-1 text-center ${
                        day.w === 0
                          ? "text-red-600"
                          : day.w === 6
                          ? "text-blue-600"
                          : ""
                      } ${mode === "holiday" ? "cursor-pointer" : ""}`}
                      onClick={() => mode === "holiday" && toggleHoliday(day.key)}
                      title={mode === "holiday" ? "クリックで園休日切替" : ""}
                    >
                      <div className="text-xs">
                        {month}/{day.d}（{weekdayLabel(day.w)}）
                      </div>
                      {day.isHoliday && (
                        <div className="text-[10px] text-rose-600">祝日</div>
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {viewStaff.map((s) => (
                  <tr key={s.id}>
                    <td className="sticky left-0 bg-white border-r p-2 whitespace-nowrap">
                      <div className="font-medium truncate" title={s.name}>
                        {s.name}
                      </div>
                      <div className="text-xs text-slate-500">
                        早:{counts[s.id]?.早番 ?? 0} / 中遅:{counts[s.id]?.中遅 ?? 0} /
                        遅:{counts[s.id]?.遅番 ?? 0}
                      </div>
                    </td>
                    {days.map((day) => {
                      const key = day.key;
                      const value = schedule[s.id]?.[key] || EMPTY;
                      const offReq = dayOff[s.id]?.has(key);
                      const issuesForCell = issues.filter(
                        (p) => p.key === key && (!p.staffId || p.staffId === s.id)
                      );
                      const hasIssue = hasIssueForCell(s.id, key, issues);
                      const targetId = mode === "off-req" ? selectedStaffId : s.id;
                      const cellCls = shiftBgClass(value, hasIssue);
                      return (
                        <td
                          key={key}
                          className={`text-center align-middle border p-0 select-none ${
                            mode !== "holiday" ? "cursor-pointer" : ""
                          }`}
                          onClick={() => mode !== "holiday" && onCellClick(targetId, key)}
                          title={issuesForCell.map((p) => p.message).join("\n")}
                        >
                          <div className={`py-2 text-sm ${cellCls}`}>
                            <div className={value === EMPTY ? "text-slate-300" : "font-medium"}>
                              {value}
                            </div>
                            {offReq && (
                              <div className="text-[10px] text-rose-600">希望休</div>
                            )}
                            {day.isHoliday && (
                              <div className="text-[10px] text-rose-600">祝</div>
                            )}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-3 bg-white rounded-2xl shadow p-3">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold">検証結果</h3>
              <span
                className={`text-sm ${
                  issues.length ? "text-rose-600" : "text-emerald-600"
                }`}
              >
                {issues.length ? `${issues.length}件の確認事項` : "問題なし"}
              </span>
            </div>
            {issues.length > 0 && (
              <ul className="list-disc pl-6 mt-2 space-y-1 text-sm">
                {issues.map((p, idx) => (
                  <li key={idx}>{p.message}</li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}

function BulkForm({ staff, days, onApply }) {
  const [target, setTarget] = useState(staff[0]?.id || "");
  const [range, setRange] = useState("all");
  const [shift, setShift] = useState("通常");
  const [weekdaysOnly, setWeekdaysOnly] = useState(false);
  const [excludeHolidays, setExcludeHolidays] = useState(true);

  const maxWeek = days.length ? days[days.length - 1].week : 0;

  useEffect(() => {
    if (!staff.find((s) => s.id === target)) {
      setTarget(staff[0]?.id || "");
    }
  }, [staff, target]);

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <select
          className="border rounded px-2 py-1"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
        >
          {staff.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <select
          className="border rounded px-2 py-1"
          value={shift}
          onChange={(e) => setShift(e.target.value)}
        >
          {SHIFTS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>
      <div className="grid grid-cols-2 gap-2 items-center">
        <select
          className="border rounded px-2 py-1"
          value={range}
          onChange={(e) => setRange(e.target.value)}
        >
          <option value="all">全期間</option>
          {Array.from({ length: maxWeek + 1 }, (_, i) => (
            <option key={i} value={String(i)}>
              第{i + 1}週
            </option>
          ))}
        </select>
        <div className="flex items-center gap-3 text-xs text-slate-600">
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={weekdaysOnly}
              onChange={(e) => setWeekdaysOnly(e.target.checked)}
            />
            平日のみ
          </label>
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={excludeHolidays}
              onChange={(e) => setExcludeHolidays(e.target.checked)}
            />
            祝/日曜を除外
          </label>
        </div>
      </div>
      <button
        className="w-full px-3 py-1 rounded border hover:bg-slate-50"
        onClick={() =>
          onApply({
            staffId: target,
            weekIdx: range === "all" ? "all" : parseInt(range, 10),
            shift,
            weekdaysOnly,
            excludeHolidays,
          })
        }
      >
        一括適用
      </button>
    </div>
  );
}

function RulesPanel({ rules, setRules, staff }) {
  return (
    <div className="bg-white rounded-2xl shadow p-4 space-y-4">
      <h2 className="font-semibold">ルール</h2>
      <div className="space-y-3">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            className="scale-110"
            checked={rules.absoluteDayOff}
            onChange={(e) => setRules({ ...rules, absoluteDayOff: e.target.checked })}
          />
          <span>希望休は絶対優先</span>
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            className="scale-110"
            checked={rules.restOnlyByRequest}
            onChange={(e) => setRules({ ...rules, restOnlyByRequest: e.target.checked })}
          />
          <span>休みは希望休のみ（自動では入れない）</span>
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            className="scale-110"
            checked={rules.saturdayOthersOff}
            disabled={rules.restOnlyByRequest}
            onChange={(e) => setRules({ ...rules, saturdayOthersOff: e.target.checked })}
          />
          <span className={rules.restOnlyByRequest ? "text-slate-400" : ""}>
            土曜は「早番・遅番」以外は休み
          </span>
        </label>
        <div>
          <label className="block text-sm text-slate-600">
            同一シフトの最小間隔（既定・日）
            <span className="text-xs text-slate-500 ml-1">
              ※対象：早番・中遅・遅番（通常は対象外）
            </span>
          </label>
          <input
            type="number"
            min={0}
            className="border rounded px-2 py-1 w-28"
            value={rules.fairnessGapDays}
            onChange={(e) =>
              setRules({ ...rules, fairnessGapDays: parseInt(e.target.value || 0, 10) })
            }
          />
        </div>
      </div>

      <div className="border-t pt-3">
        <h3 className="font-semibold mb-2">個別ルール（must）</h3>
        <button
          className="mb-2 px-2 py-1 rounded border"
          onClick={() => addMustRule(setRules, staff)}
        >
          ＋行追加
        </button>
        <div className="space-y-2">
          {rules.mustRules.map((r, idx) => (
            <div key={idx} className="grid grid-cols-4 gap-2 items-center">
              <select
                className="border rounded px-2 py-1"
                value={r.staffId}
                onChange={(e) => updateMust(idx, { staffId: e.target.value }, setRules)}
              >
                {staff.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              <select
                className="border rounded px-2 py-1"
                value={r.dayOfWeek}
                onChange={(e) => updateMust(idx, { dayOfWeek: parseInt(e.target.value, 10) }, setRules)}
              >
                {[0, 1, 2, 3, 4, 5, 6].map((w) => (
                  <option key={w} value={w}>
                    {weekdayLabel(w)}
                  </option>
                ))}
              </select>
              <select
                className="border rounded px-2 py-1"
                value={r.must}
                onChange={(e) => updateMust(idx, { must: e.target.value }, setRules)}
              >
                {SHIFTS.filter((s) => s !== EMPTY).map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
              <button
                className="px-2 py-1 rounded border"
                onClick={() => removeMust(idx, setRules)}
              >
                削除
              </button>
            </div>
          ))}
        </div>
      </div>

      <div className="border-t pt-3">
        <h3 className="font-semibold mb-2">個別ルール（cannot）</h3>
        <button
          className="mb-2 px-2 py-1 rounded border"
          onClick={() => addCannotRule(setRules, staff)}
        >
          ＋行追加
        </button>
        <div className="space-y-2">
          {rules.cannotRules.map((r, idx) => (
            <div key={idx} className="space-y-2 border rounded p-2">
              <div className="grid grid-cols-3 gap-2 items-center">
                <select
                  className="border rounded px-2 py-1"
                  value={r.staffId}
                  onChange={(e) => updateCannot(idx, { staffId: e.target.value }, setRules)}
                >
                  {staff.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
                <select
                  className="border rounded px-2 py-1"
                  value={r.dayOfWeek}
                  onChange={(e) => updateCannot(idx, { dayOfWeek: parseInt(e.target.value, 10) }, setRules)}
                >
                  {[0, 1, 2, 3, 4, 5, 6].map((w) => (
                    <option key={w} value={w}>
                      {weekdayLabel(w)}
                    </option>
                  ))}
                </select>
                <button
                  className="px-2 py-1 rounded border"
                  onClick={() => removeCannot(idx, setRules)}
                >
                  削除
                </button>
              </div>
              <div className="flex flex-wrap gap-2">
                {SHIFTS.filter((s) => s !== EMPTY).map((s) => (
                  <label key={s} className="flex items-center gap-1 text-sm">
                    <input
                      type="checkbox"
                      checked={r.cannot.includes(s)}
                      onChange={() => toggleCannotShift(idx, s, setRules)}
                    />
                    {s}
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="border-t pt-3">
        <h3 className="font-semibold mb-2">同時配置NG（ペア）</h3>
        <button
          className="mb-2 px-2 py-1 rounded border"
          onClick={() => addPairRule(setRules, staff)}
        >
          ＋行追加
        </button>
        <div className="space-y-2">
          {rules.pairConflicts.map((p, idx) => (
            <div key={idx} className="space-y-2 border rounded p-2">
              <div className="grid grid-cols-3 gap-2 items-center">
                <select
                  className="border rounded px-2 py-1"
                  value={p.a}
                  onChange={(e) => updatePair(idx, { a: e.target.value }, setRules)}
                >
                  {staff.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
                <select
                  className="border rounded px-2 py-1"
                  value={p.b}
                  onChange={(e) => updatePair(idx, { b: e.target.value }, setRules)}
                >
                  {staff.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
                <button
                  className="px-2 py-1 rounded border"
                  onClick={() => removePair(idx, setRules)}
                >
                  削除
                </button>
              </div>
              <div className="flex flex-wrap gap-2">
                {["早番", "中遅", "遅番", "通常", "休み"].map((s) => (
                  <label key={s} className="flex items-center gap-1 text-sm">
                    <input
                      type="checkbox"
                      checked={p.conflictShifts.includes(s)}
                      onChange={() => togglePairShift(idx, s, setRules)}
                    />
                    {s}
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="border-t pt-3">
        <h3 className="font-semibold mb-2">個別ルール（週上限）</h3>
        <button
          className="mb-2 px-2 py-1 rounded border"
          onClick={() => addWeeklyCapRule(setRules, staff)}
        >
          ＋行追加
        </button>
        <div className="space-y-2">
          {(rules.weeklyCaps || []).map((r, idx) => (
            <div key={idx} className="grid grid-cols-4 gap-2 items-center">
              <select
                className="border rounded px-2 py-1"
                value={r.staffId}
                onChange={(e) => updateWeeklyCap(idx, { staffId: e.target.value }, setRules)}
              >
                {staff.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              <select
                className="border rounded px-2 py-1"
                value={r.shift}
                onChange={(e) => updateWeeklyCap(idx, { shift: e.target.value }, setRules)}
              >
                {CAP_SHIFT_CHOICES.map((s) => (
                  <option key={s} value={s}>
                    {capLabel(s)}
                  </option>
                ))}
              </select>
              <div className="flex items-center gap-1">
                <input
                  type="number"
                  min={0}
                  className="border rounded px-2 py-1 w-24"
                  value={r.perWeek ?? 0}
                  onChange={(e) =>
                    updateWeeklyCap(idx, { perWeek: parseInt(e.target.value || 0, 10) }, setRules)
                  }
                />
                <span className="text-sm text-slate-600">回/週</span>
              </div>
              <button
                className="px-2 py-1 rounded border"
                onClick={() => removeWeeklyCap(idx, setRules)}
              >
                削除
              </button>
            </div>
          ))}
        </div>
        <p className="text-xs text-slate-500 mt-2">
          ※「全対象」は 早番・中遅・遅番 の合計。"通常" と "休み" は含みません。
        </p>
      </div>

      <div className="border-t pt-3">
        <h3 className="font-semibold mb-2">個別ルール（最小間隔）</h3>
        <button
          className="mb-2 px-2 py-1 rounded border"
          onClick={() => addMinGapRule(setRules, staff)}
        >
          ＋行追加
        </button>
        <div className="space-y-2">
          {(rules.minGapRules || []).map((r, idx) => (
            <div key={idx} className="grid grid-cols-4 gap-2 items-center">
              <select
                className="border rounded px-2 py-1"
                value={r.staffId}
                onChange={(e) => updateMinGapRule(idx, { staffId: e.target.value }, setRules)}
              >
                {staff.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              <select
                className="border rounded px-2 py-1"
                value={r.shift}
                onChange={(e) => updateMinGapRule(idx, { shift: e.target.value }, setRules)}
              >
                {GAP_SHIFT_CHOICES.map((s) => (
                  <option key={s} value={s}>
                    {gapLabel(s)}
                  </option>
                ))}
              </select>
              <div className="flex items-center gap-1">
                <input
                  type="number"
                  min={0}
                  className="border rounded px-2 py-1 w-24"
                  value={r.minGapDays ?? 0}
                  onChange={(e) =>
                    updateMinGapRule(idx, { minGapDays: parseInt(e.target.value || 0, 10) }, setRules)
                  }
                />
                <span className="text-sm text-slate-600">日</span>
              </div>
              <button
                className="px-2 py-1 rounded border"
                onClick={() => removeMinGapRule(idx, setRules)}
              >
                削除
              </button>
            </div>
          ))}
        </div>
        <p className="text-xs text-slate-500 mt-2">
          ※「全対象」は 早番・中遅・遅番に適用。通常は対象外（個別指定があれば適用可）。
        </p>
      </div>
    </div>
  );
}

function shiftBgClass(value, hasIssue) {
  const issue = hasIssue ? " ring-1 ring-rose-300" : "";
  switch (value) {
    case "早番":
      return "bg-amber-50" + issue;
    case "中遅":
      return "bg-sky-50" + issue;
    case "遅番":
      return "bg-indigo-50" + issue;
    case "通常":
      return "bg-emerald-50" + issue;
    case "休み":
      return "bg-slate-100" + issue;
    default:
      return issue;
  }
}

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(<App />);
