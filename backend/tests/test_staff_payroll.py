from datetime import date

from app import payroll
from app.database import get_connection
from tests.conftest import SEED_ORG

# March 2025: 21 weekdays (Mon-Fri), Navro'z on Friday the 21st.
MARCH = [f"2025-03-{d:02d}" for d in range(1, 32) if date(2025, 3, d).weekday() < 5]
RULES = {"late_penalty_pct": 25, "deduction_start": "2025-01-01"}
AFTER_MARCH = "2025-04-15"


def _full_month(status_by_day=None):
    marks = {d: "PRESENT" for d in MARCH}
    marks.update(status_by_day or {})
    return marks


def test_attendance_counts_only_what_was_marked():
    marks = _full_month({"2025-03-03": "ABSENT", "2025-03-04": "EXCUSED", "2025-03-05": "LATE"})
    del marks["2025-03-06"]
    b = payroll.breakdown(2_100_000, None, marks, MARCH, RULES, AFTER_MARCH)
    assert b["working_days"] == 21
    assert (b["absent_days"], b["excused_days"], b["late_days"], b["unmarked_days"]) == (1, 1, 1, 1)
    # No money is computed from attendance any more.
    assert "absence_deduction" not in b and "late_deduction" not in b


def test_holidays_are_not_working_days():
    work = payroll.working_days(2025, 3, {"2025-03-21"})
    assert len(work) == 20 and "2025-03-21" not in work


# ---- API ---------------------------------------------------------------

def _mark_month(staff_id, overrides=None):
    conn = get_connection()
    for d in MARCH:
        status = (overrides or {}).get(d, "PRESENT")
        if status is None:
            continue
        conn.execute("INSERT OR REPLACE INTO staff_attendance (id, org_id, staff_id, date, status) VALUES (?, ?, ?, ?, ?)",
                     (f"sa_{staff_id}_{d}", SEED_ORG, staff_id, d, status))
    conn.commit()
    conn.close()


def _payroll_row(client, auth_headers, staff_id, month="2025-03"):
    body = client.get(f"/api/v1/staff/payroll?month={month}", headers=auth_headers("accountant")).json()
    return next(r for r in body["rows"] if r["staff_id"] == staff_id)


def _set_deduction(client, auth_headers, payroll_id, amount, note=None, role="accountant"):
    return client.put(f"/api/v1/staff/payroll/{payroll_id}/deduction", json={"amount": amount, "note": note},
                      headers=auth_headers(role))


def test_absence_no_longer_deducts_automatically(client, auth_headers):
    _mark_month("st_1", {"2025-03-03": "ABSENT", "2025-03-04": "LATE", "2025-03-05": None})
    row = _payroll_row(client, auth_headers, "st_1")
    assert (row["absent_days"], row["late_days"], row["unmarked_days"]) == (1, 1, 1)
    assert row["deduction"] == 0
    assert row["total_to_pay"] == row["base_salary"]


def test_accountant_enters_deduction_by_hand(client, auth_headers):
    row = _payroll_row(client, auth_headers, "st_1")
    res = _set_deduction(client, auth_headers, row["id"], 150_000, "  2 kun kelmadi  ")
    assert res.status_code == 200
    row = _payroll_row(client, auth_headers, "st_1")
    assert row["deduction"] == 150_000 and row["deduction_note"] == "2 kun kelmadi"
    assert row["total_to_pay"] == row["base_salary"] - 150_000

    log = client.get("/api/v1/audit/log", headers=auth_headers("director")).json()
    assert log[0]["action"] == "staff.deduction"

    # Clearing it back to zero works too.
    assert _set_deduction(client, auth_headers, row["id"], 0).status_code == 200
    assert _payroll_row(client, auth_headers, "st_1")["total_to_pay"] == row["base_salary"]


def test_deduction_validation(client, auth_headers):
    row = _payroll_row(client, auth_headers, "st_1")
    assert _set_deduction(client, auth_headers, row["id"], -1).status_code == 422
    assert _set_deduction(client, auth_headers, row["id"], row["base_salary"] + 1).status_code == 400
    assert _set_deduction(client, auth_headers, "nope", 1).status_code == 404


def test_only_finance_roles_can_set_deduction(client, auth_headers):
    row = _payroll_row(client, auth_headers, "st_1")
    for role in ("teacher", "nurse"):
        assert _set_deduction(client, auth_headers, row["id"], 1, role=role).status_code == 403
    for role in ("accountant", "super_admin", "director"):
        assert _set_deduction(client, auth_headers, row["id"], 1, role=role).status_code == 200


def test_paid_month_keeps_its_deduction_and_locks(client, auth_headers):
    _mark_month("st_1", {"2025-03-03": "ABSENT"})
    row = _payroll_row(client, auth_headers, "st_1")
    _set_deduction(client, auth_headers, row["id"], 100_000)
    row = _payroll_row(client, auth_headers, "st_1")
    paid = client.post("/api/v1/staff/pay", json={"payroll_id": row["id"], "amount": row["total_to_pay"]},
                       headers=auth_headers("accountant"))
    assert paid.status_code == 200

    after = _payroll_row(client, auth_headers, "st_1")
    assert after["status"] == "PAID" and after["deduction"] == 100_000
    assert after["final_paid"] == row["base_salary"] - 100_000
    assert _set_deduction(client, auth_headers, row["id"], 0).status_code == 400
    res = client.post("/api/v1/staff/attendance/mark", json={"staff_id": "st_1", "status": "PRESENT", "date": "2025-03-03"},
                      headers=auth_headers("accountant"))
    assert res.status_code == 400


def test_month_paid_with_old_automatic_deduction_still_shows_it(client, auth_headers):
    row = _payroll_row(client, auth_headers, "st_1")
    conn = get_connection()
    conn.execute("""UPDATE staff_payroll SET status = 'PAID', final_paid = base_salary - 800000,
                    absence_deduction = 800000, late_deduction = 0 WHERE id = ?""", (row["id"],))
    conn.commit()
    conn.close()
    assert _payroll_row(client, auth_headers, "st_1")["deduction"] == 800_000


def test_past_day_can_be_corrected_and_is_audited(client, auth_headers):
    _mark_month("st_2", {"2025-03-03": "ABSENT"})
    assert _payroll_row(client, auth_headers, "st_2")["absent_days"] == 1

    res = client.post("/api/v1/staff/attendance/mark", json={"staff_id": "st_2", "status": "EXCUSED", "date": "2025-03-03"},
                      headers=auth_headers("accountant"))
    assert res.status_code == 200
    assert _payroll_row(client, auth_headers, "st_2")["absent_days"] == 0
    log = client.get("/api/v1/audit/log", headers=auth_headers("director")).json()
    assert log[0]["action"] == "staff.attendance.edit"


def test_future_day_cannot_be_marked(client, auth_headers):
    res = client.post("/api/v1/staff/attendance/mark", json={"staff_id": "st_1", "status": "ABSENT", "date": "2999-01-01"},
                      headers=auth_headers("accountant"))
    assert res.status_code == 400


def test_monthly_staff_sheet(client, auth_headers):
    _mark_month("st_1", {"2025-03-03": "ABSENT"})
    body = client.get("/api/v1/staff/attendance/month?month=2025-03", headers=auth_headers("accountant")).json()
    st1 = next(s for s in body["staff"] if s["id"] == "st_1")
    assert body["days_in_month"] == 31
    assert st1["days"]["3"] == "ABSENT" and st1["absent_days"] == 1
