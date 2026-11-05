"""
Salary deductions from staff attendance.

Rules (agreed with the kindergarten):
- A day's pay is base salary / working days in the month (Mon-Fri minus holidays).
- An unexcused absence ('ABSENT') deducts one day's pay; 'EXCUSED' is paid in full.
- An unmarked past working day counts as an absence.
- A late arrival deducts the org's late-penalty percentage of one day's pay.
- Nothing before the org's deduction start date or the employee's hire date is counted,
  and today only counts once it has been marked.
"""
import calendar
from datetime import date


def org_rules(conn, org: str) -> dict:
    row = conn.execute(
        "SELECT staff_late_penalty_pct, staff_deduction_start FROM organizations WHERE id = ?", (org,)
    ).fetchone()
    return {
        "late_penalty_pct": row["staff_late_penalty_pct"] if row and row["staff_late_penalty_pct"] is not None else 25,
        "deduction_start": row["staff_deduction_start"] if row else None,
    }


def holidays_in(conn, org: str, start: str, end: str) -> set[str]:
    return {r["date"] for r in conn.execute(
        "SELECT date FROM org_holidays WHERE org_id = ? AND date BETWEEN ? AND ?", (org, start, end))}


def month_bounds(year: int, month: int) -> tuple[str, str, int]:
    last = calendar.monthrange(year, month)[1]
    return f"{year:04d}-{month:02d}-01", f"{year:04d}-{month:02d}-{last:02d}", last


def working_days(year: int, month: int, holidays: set[str]) -> list[str]:
    _, _, last = month_bounds(year, month)
    days = []
    for d in range(1, last + 1):
        iso = f"{year:04d}-{month:02d}-{d:02d}"
        if date(year, month, d).weekday() < 5 and iso not in holidays:
            days.append(iso)
    return days


def month_context(conn, org: str, year: int, month: int) -> dict:
    start, end, _ = month_bounds(year, month)
    rules = org_rules(conn, org)
    holidays = holidays_in(conn, org, start, end)
    marks: dict = {}
    for r in conn.execute(
        "SELECT staff_id, date, status FROM staff_attendance WHERE org_id = ? AND date BETWEEN ? AND ?",
        (org, start, end),
    ):
        marks.setdefault(r["staff_id"], {})[r["date"]] = r["status"]
    return {"start": start, "end": end, "rules": rules, "holidays": holidays,
            "work": working_days(year, month, holidays), "marks": marks}


def staff_breakdown(ctx: dict, staff_id: str, base_salary: float, hire_date: str | None,
                    today: date | None = None) -> dict:
    return breakdown(base_salary, hire_date, ctx["marks"].get(staff_id, {}), ctx["work"],
                     ctx["rules"], (today or date.today()).isoformat())


def breakdown(base_salary: float, hire_date: str | None, marks: dict, work: list[str],
              rules: dict, today_iso: str) -> dict:
    floor = hire_date or ""

    absent = late = excused = unmarked = 0
    for d in work:
        if d < floor or d > today_iso:
            continue
        status = marks.get(d)
        if status is None:
            if d < today_iso:
                unmarked += 1
            continue
        if status == "ABSENT":
            absent += 1
        elif status == "LATE":
            late += 1
        elif status == "EXCUSED":
            excused += 1

    # Attendance is information only: the accountant enters any salary deduction by hand.
    return {
        "working_days": len(work),
        "absent_days": absent,
        "unmarked_days": unmarked,
        "late_days": late,
        "excused_days": excused,
    }
