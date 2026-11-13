import secrets
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from typing import Optional
from datetime import date, datetime
from app.database import get_connection
from app.security import require
from app import audit, payroll

router = APIRouter(prefix="/api/v1/staff", tags=["Xodimlar va Ish Haqi"])

class PaySalarySchema(BaseModel):
    payroll_id: str
    amount: float
    bonus: Optional[float] = 0

class SalarySchema(BaseModel):
    base_salary: float = Field(ge=0, le=1_000_000_000)

class DeductionSchema(BaseModel):
    amount: float = Field(ge=0)
    note: Optional[str] = Field(default=None, max_length=200)

class StaffAttendanceSchema(BaseModel):
    staff_id: str
    status: str
    date: Optional[str] = None

class StaffCreateSchema(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    role: str = Field(min_length=1, max_length=80)
    phone: str = Field(min_length=1, max_length=40)
    base_salary: float = Field(ge=0)
    hire_date: Optional[str] = None

STAFF_STATUSES = {"PRESENT", "ABSENT", "EXCUSED", "LATE"}


def _parse_day(value: Optional[str]) -> str:
    if not value:
        return date.today().isoformat()
    try:
        return date.fromisoformat(value).isoformat()
    except ValueError:
        raise HTTPException(status_code=400, detail="Sana noto'g'ri formatda")


def _parse_month(value: Optional[str]) -> tuple[int, int]:
    if not value:
        today = date.today()
        return today.year, today.month
    try:
        y, m = value.split("-")
        year, month = int(y), int(m)
        date(year, month, 1)
    except ValueError:
        raise HTTPException(status_code=400, detail="Oy noto'g'ri formatda (YYYY-MM)")
    return year, month


@router.post("")
def create_staff(data: StaffCreateSchema, user: dict = Depends(require("staff.manage"))):
    hire_date = data.hire_date or date.today().isoformat()
    try:
        date.fromisoformat(hire_date)
    except ValueError:
        raise HTTPException(status_code=400, detail="Sana noto'g'ri formatda")

    org = user["org"]
    name, role, phone = data.name.strip(), data.role.strip(), data.phone.strip()
    staff_id = f"s_{secrets.token_hex(4)}"
    conn = get_connection()
    conn.execute("""
        INSERT INTO staff (id, org_id, name, role, phone, base_salary, hire_date, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE')
    """, (staff_id, org, name, role, phone, data.base_salary, hire_date))

    # The payroll table is what the Staff tab lists, so a new person needs a row straight away.
    month = max(date.today(), date.fromisoformat(hire_date)).strftime("%Y-%m")
    conn.execute("""
        INSERT INTO staff_payroll (id, org_id, staff_id, month, base_salary, bonus, advance_paid, final_paid, status)
        VALUES (?, ?, ?, ?, ?, 0, 0, 0, 'PENDING')
    """, (f"pr_{secrets.token_hex(4)}", org, staff_id, month, data.base_salary))

    conn.execute("INSERT INTO activity_logs (org_id, icon, message) VALUES (?, '🧑‍🏫', ?)",
                 (org, f"Yangi xodim qo'shildi: {name} ({role})."))
    audit.record(conn, user, "staff.create", "staff", staff_id, name,
                 {"role": {"old": None, "new": role}, "base_salary": {"old": None, "new": data.base_salary}})
    conn.commit()
    conn.close()
    return {"success": True, "staff_id": staff_id, "name": name}


@router.delete("/{staff_id}")
def delete_staff(staff_id: str, user: dict = Depends(require("staff.manage"))):
    org = user["org"]
    conn = get_connection()
    staff = conn.execute(
        "SELECT name, role FROM staff WHERE id = ? AND org_id = ? AND status = 'ACTIVE'", (staff_id, org)
    ).fetchone()
    if not staff:
        conn.close()
        raise HTTPException(status_code=404, detail="Xodim topilmadi")

    # Soft delete: paid salary history stays in the books. Unpaid salary for earlier months is
    # still owed, so it stays payable; only this month's and later unpaid rows are dropped.
    this_month = date.today().strftime("%Y-%m")
    conn.execute("UPDATE staff SET status = 'INACTIVE' WHERE id = ? AND org_id = ?", (staff_id, org))
    conn.execute("DELETE FROM staff_payroll WHERE staff_id = ? AND org_id = ? AND status != 'PAID' AND month >= ?",
                 (staff_id, org, this_month))

    conn.execute("INSERT INTO activity_logs (org_id, icon, message) VALUES (?, '🗑️', ?)",
                 (org, f"Xodim o'chirildi: {staff['name']} ({staff['role']})."))
    audit.record(conn, user, "staff.delete", "staff", staff_id, staff["name"])
    conn.commit()
    conn.close()
    return {"success": True, "staff_id": staff_id}


@router.patch("/{staff_id}/salary")
def update_salary(staff_id: str, data: SalarySchema, user: dict = Depends(require("staff.manage"))):
    """New salary applies to this month's and later unpaid salaries; paid and earlier months keep theirs."""
    org = user["org"]
    conn = get_connection()
    staff = conn.execute("SELECT name, base_salary FROM staff WHERE id = ? AND org_id = ? AND status = 'ACTIVE'",
                         (staff_id, org)).fetchone()
    if not staff:
        conn.close()
        raise HTTPException(status_code=404, detail="Xodim topilmadi")

    this_month = date.today().strftime("%Y-%m")
    conn.execute("UPDATE staff SET base_salary = ? WHERE id = ? AND org_id = ?", (data.base_salary, staff_id, org))
    updated = conn.execute("""
        UPDATE staff_payroll SET base_salary = ?
        WHERE staff_id = ? AND org_id = ? AND status != 'PAID' AND month >= ?
    """, (data.base_salary, staff_id, org, this_month)).rowcount
    if staff["base_salary"] != data.base_salary:
        audit.record(conn, user, "staff.salary", "staff", staff_id, staff["name"],
                     {"base_salary": {"old": staff["base_salary"], "new": data.base_salary}})
        conn.execute("INSERT INTO activity_logs (org_id, icon, message) VALUES (?, '💼', ?)",
                     (org, f"{staff['name']} uchun oylik maosh o'zgartirildi."))
    conn.commit()
    conn.close()
    return {"success": True, "staff_id": staff_id, "base_salary": data.base_salary, "updated_months": updated}


@router.get("/attendance")
def staff_attendance(att_date: Optional[str] = None, user: dict = Depends(require("staff.view"))):
    target = _parse_day(att_date)
    conn = get_connection()
    rows = conn.execute("""
    SELECT s.id, s.name, s.role, sa.status, sa.check_in_time
    FROM staff s
    LEFT JOIN staff_attendance sa ON sa.staff_id = s.id AND sa.date = ?
    WHERE s.org_id = ? AND s.status = 'ACTIVE'
    ORDER BY s.role ASC, s.name ASC
    """, (target, user["org"])).fetchall()
    conn.close()
    return {
        "date": target,
        # Past days stay editable so a forgotten mark can be fixed before salaries are paid.
        "editable": target <= date.today().isoformat() and "staff.attendance.mark" in user["permissions"],
        "staff": [
            {"id": r["id"], "name": r["name"], "role": r["role"], "status": r["status"], "check_in_time": r["check_in_time"]}
            for r in rows
        ],
    }


@router.get("/attendance/month")
def staff_attendance_month(month: Optional[str] = None, user: dict = Depends(require("staff.view"))):
    year, mon = _parse_month(month)
    org = user["org"]
    conn = get_connection()
    ctx = payroll.month_context(conn, org, year, mon)
    staff = conn.execute("""
    SELECT id, name, role, base_salary, hire_date FROM staff
    WHERE org_id = ? AND (status = 'ACTIVE'
          OR EXISTS (SELECT 1 FROM staff_attendance sa WHERE sa.staff_id = staff.id AND sa.date BETWEEN ? AND ?))
    ORDER BY role ASC, name ASC
    """, (org, ctx["start"], ctx["end"])).fetchall()
    conn.close()
    _, _, last = payroll.month_bounds(year, mon)
    return {
        "month": f"{year:04d}-{mon:02d}",
        "days_in_month": last,
        "holidays": sorted(ctx["holidays"]),
        "working_days": len(ctx["work"]),
        "rules": ctx["rules"],
        "staff": [
            {
                "id": s["id"], "name": s["name"], "role": s["role"], "hire_date": s["hire_date"],
                "days": {str(int(d[8:])): st for d, st in sorted(ctx["marks"].get(s["id"], {}).items())},
                **payroll.staff_breakdown(ctx, s["id"], s["base_salary"], s["hire_date"]),
            }
            for s in staff
        ],
    }


@router.post("/attendance/mark")
def mark_staff_attendance(data: StaffAttendanceSchema, user: dict = Depends(require("staff.attendance.mark"))):
    if data.status not in STAFF_STATUSES:
        raise HTTPException(status_code=400, detail="Noma'lum davomat holati")
    day = _parse_day(data.date)
    today = date.today().isoformat()
    if day > today:
        raise HTTPException(status_code=400, detail="Kelajakdagi kun uchun davomat belgilab bo'lmaydi")
    org = user["org"]
    conn = get_connection()
    staff = conn.execute("SELECT name FROM staff WHERE id = ? AND org_id = ? AND status = 'ACTIVE'",
                         (data.staff_id, org)).fetchone()
    if not staff:
        conn.close()
        raise HTTPException(status_code=404, detail="Xodim topilmadi")
    paid = conn.execute(
        "SELECT 1 FROM staff_payroll WHERE staff_id = ? AND org_id = ? AND month = ? AND status = 'PAID'",
        (data.staff_id, org, day[:7]),
    ).fetchone()
    if paid:
        conn.close()
        raise HTTPException(status_code=400, detail="Bu oy uchun maosh allaqachon to'langan, davomatni o'zgartirib bo'lmaydi")
    before = conn.execute("SELECT status FROM staff_attendance WHERE staff_id = ? AND date = ?",
                          (data.staff_id, day)).fetchone()
    now_time = datetime.now().strftime("%H:%M") if day == today and data.status in ("PRESENT", "LATE") else None
    conn.execute("""
    INSERT INTO staff_attendance (id, org_id, staff_id, date, status, check_in_time)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(staff_id, date) DO UPDATE SET status = excluded.status, check_in_time = excluded.check_in_time
    """, (f"sa_{data.staff_id}_{day}", org, data.staff_id, day, data.status, now_time))
    old_status = before["status"] if before else None
    # Same-day check-ins are routine; anything after the fact changes pay, so it is audited.
    if day != today and old_status != data.status:
        audit.record(conn, user, "staff.attendance.edit", "staff", data.staff_id, f"{staff['name']} ({day})",
                     {"status": {"old": old_status, "new": data.status}})
    conn.commit()
    conn.close()
    return {"success": True, "staff_id": data.staff_id, "date": day, "status": data.status, "check_in_time": now_time}

@router.get("")
def get_staff_list(user: dict = Depends(require("staff.view"))):
    conn = get_connection()
    c = conn.cursor()
    c.execute("""
    SELECT id, name, role, phone, base_salary, hire_date, status
    FROM staff
    WHERE org_id = ? AND status = 'ACTIVE'
    ORDER BY role ASC, name ASC
    """, (user["org"],))
    rows = c.fetchall()
    conn.close()

    return [
        {
            "id": r["id"],
            "name": r["name"],
            "role": r["role"],
            "phone": r["phone"],
            "salary": r["base_salary"],
            "hire_date": r["hire_date"],
            "status": r["status"]
        }
        for r in rows
    ]

def _ensure_payroll_rows(conn, org: str, month: str):
    conn.execute("""
    INSERT INTO staff_payroll (id, org_id, staff_id, month, base_salary, bonus, advance_paid, final_paid, status)
    SELECT 'pr_' || lower(hex(randomblob(4))), s.org_id, s.id, ?, s.base_salary, 0, 0, 0, 'PENDING'
    FROM staff s
    WHERE s.org_id = ? AND s.status = 'ACTIVE'
      AND NOT EXISTS (SELECT 1 FROM staff_payroll p WHERE p.staff_id = s.id AND p.month = ?)
      AND (s.hire_date IS NULL OR s.hire_date = '' OR substr(s.hire_date, 1, 7) <= ?)
    """, (month, org, month, month))


@router.get("/payroll")
def get_payroll(month: Optional[str] = None, user: dict = Depends(require("staff.view"))):
    year, mon = _parse_month(month)
    key = f"{year:04d}-{mon:02d}"
    org = user["org"]
    conn = get_connection()
    if key <= date.today().strftime("%Y-%m"):
        _ensure_payroll_rows(conn, org, key)
        conn.commit()
    ctx = payroll.month_context(conn, org, year, mon)
    rows = conn.execute("""
    SELECT pr.*, s.name as staff_name, s.role, s.phone, s.hire_date, s.status AS staff_status
    FROM staff_payroll pr
    JOIN staff s ON pr.staff_id = s.id
    WHERE pr.month = ? AND pr.org_id = ?
      AND (s.status = 'ACTIVE' OR pr.status = 'PAID' OR pr.month < ?)
    ORDER BY pr.status DESC, s.name ASC
    """, (key, org, date.today().strftime("%Y-%m"))).fetchall()
    conn.close()

    result = []
    for r in rows:
        calc = payroll.staff_breakdown(ctx, r["staff_id"], r["base_salary"], r["hire_date"])
        deduction = _row_deduction(r)
        total = max(0, r["base_salary"] + r["bonus"] - r["advance_paid"] - deduction)
        result.append({
            "id": r["id"],
            "staff_id": r["staff_id"],
            "staff_name": r["staff_name"],
            "staff_active": r["staff_status"] == "ACTIVE",
            "role": r["role"],
            "phone": r["phone"],
            "month": r["month"],
            "base_salary": r["base_salary"],
            "bonus": r["bonus"],
            "advance_paid": r["advance_paid"],
            "final_paid": r["final_paid"],
            "status": r["status"],
            "paid_date": r["paid_date"],
            **calc,
            "deduction": deduction,
            "deduction_note": r["deduction_note"],
            "total_to_pay": total,
        })
    return {"month": key, "working_days": len(ctx["work"]), "rows": result}


def _row_deduction(r) -> float:
    """The accountant's deduction, plus any automatic deduction a month was already paid with
    before deductions became manual (paid history must not change)."""
    deduction = r["manual_deduction"] or 0
    if r["status"] == "PAID":
        deduction += (r["absence_deduction"] or 0) + (r["late_deduction"] or 0)
    return deduction


@router.put("/payroll/{payroll_id}/deduction")
def set_deduction(payroll_id: str, data: DeductionSchema, user: dict = Depends(require("staff.pay"))):
    org = user["org"]
    conn = get_connection()
    row = conn.execute("""
        SELECT pr.status, pr.base_salary, pr.bonus, pr.manual_deduction, pr.deduction_note, s.name
        FROM staff_payroll pr JOIN staff s ON pr.staff_id = s.id
        WHERE pr.id = ? AND pr.org_id = ?
    """, (payroll_id, org)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="Maosh yozuvi topilmadi")
    if row["status"] == "PAID":
        conn.close()
        raise HTTPException(status_code=400, detail="To'langan oylikni o'zgartirib bo'lmaydi")
    if data.amount > row["base_salary"] + (row["bonus"] or 0):
        conn.close()
        raise HTTPException(status_code=400, detail="Ushlanma maoshdan katta bo'lishi mumkin emas")

    note = (data.note or "").strip() or None
    old = {"deduction": row["manual_deduction"] or 0, "deduction_note": row["deduction_note"]}
    new = {"deduction": data.amount, "deduction_note": note}
    conn.execute("UPDATE staff_payroll SET manual_deduction = ?, deduction_note = ? WHERE id = ?",
                 (data.amount, note, payroll_id))
    changes = audit.diff(old, new)
    if changes:
        audit.record(conn, user, "staff.deduction", "payroll", payroll_id, row["name"], changes)
    conn.commit()
    conn.close()
    return {"success": True, "deduction": data.amount, "deduction_note": note}


@router.post("/pay")
def pay_salary(data: PaySalarySchema, user: dict = Depends(require("staff.pay"))):
    if data.amount < 0:
        raise HTTPException(status_code=400, detail="Summa manfiy bo'lishi mumkin emas")

    org = user["org"]
    conn = get_connection()
    c = conn.cursor()

    c.execute("""
    SELECT pr.status, pr.month, pr.staff_id, pr.base_salary, pr.manual_deduction, s.name, s.role, s.hire_date
    FROM staff_payroll pr
    JOIN staff s ON pr.staff_id = s.id
    WHERE pr.id = ? AND pr.org_id = ?
    """, (data.payroll_id, org))
    row = c.fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="Maosh yozuvi topilmadi")
    if row["status"] == "PAID":
        conn.close()
        raise HTTPException(status_code=400, detail="Bu oylik allaqachon to'langan")

    year, mon = (int(x) for x in row["month"].split("-"))
    calc = payroll.staff_breakdown(payroll.month_context(conn, org, year, mon),
                                   row["staff_id"], row["base_salary"], row["hire_date"])

    today = date.today().isoformat()
    # Keep the attendance counts with the paid month; the deduction itself is the manual one.
    c.execute("""
    UPDATE staff_payroll
    SET status = 'PAID', paid_date = ?, final_paid = ?,
        absent_days = ?, late_days = ?, absence_deduction = 0, late_deduction = 0
    WHERE id = ? AND org_id = ?
    """, (today, data.amount, calc["absent_days"], calc["late_days"], data.payroll_id, org))

    c.execute("INSERT INTO activity_logs (org_id, icon, message) VALUES (?, '💵', ?)",
              (org, f"{row['name']} ({row['role']}) uchun oylik maosh to'landi."))
    audit.record(conn, user, "staff.pay", "payroll", data.payroll_id, row["name"],
                 {"amount": {"old": None, "new": data.amount}, "status": {"old": row["status"], "new": "PAID"},
                  "deduction": {"old": None, "new": row["manual_deduction"] or 0}})

    conn.commit()
    conn.close()

    return {"success": True}
