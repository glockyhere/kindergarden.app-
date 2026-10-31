from fastapi import APIRouter, Depends
from app import finance
from app.database import get_connection
from app.security import require
from datetime import date

router = APIRouter(prefix="/api/v1/dashboard", tags=["Dashboard"])


def _attention(conn, org: str, today: str) -> list[dict]:
    """Things that need someone's action today, each pointing at the panel that fixes it."""
    items = []

    per_group = conn.execute("""
        SELECT g.name, COUNT(ch.id) AS total, COUNT(att.child_id) AS marked
        FROM groups g
        JOIN children ch ON ch.group_id = g.id AND ch.status = 'ACTIVE'
        LEFT JOIN attendance att ON att.child_id = ch.id AND att.date = ?
        WHERE g.org_id = ? AND g.archived_at IS NULL
        GROUP BY g.id ORDER BY g.name
    """, (today, org)).fetchall()
    for g in per_group:
        left = g["total"] - g["marked"]
        if left:
            items.append({"key": f"att:{g['name']}", "kind": "attendance", "tab": "attendance", "group": g["name"],
                          "label": "Davomat belgilanmagan", "detail": f"{g['name']} guruhi", "count": left})

    overdue = conn.execute("""
        SELECT COUNT(DISTINCT child_id) FROM invoices
        WHERE org_id = ? AND amount_due > amount_paid AND due_date < ?
    """, (org, today)).fetchone()[0]
    if overdue:
        items.append({"key": "overdue", "kind": "money", "tab": "billing",
                      "label": "To'lov muddati o'tgan", "detail": "oilalar", "count": overdue})

    staff_left = conn.execute("""
        SELECT COUNT(*) FROM staff s
        LEFT JOIN staff_attendance sa ON sa.staff_id = s.id AND sa.date = ?
        WHERE s.org_id = ? AND s.status = 'ACTIVE' AND sa.staff_id IS NULL
    """, (today, org)).fetchone()[0]
    if staff_left:
        items.append({"key": "staff", "kind": "staff", "tab": "staff",
                      "label": "Xodimlar davomati belgilanmagan", "detail": "xodim", "count": staff_left})

    over = conn.execute("""
        SELECT COUNT(*) FROM (
            SELECT g.capacity, COUNT(ch.id) AS n FROM groups g
            LEFT JOIN children ch ON ch.group_id = g.id AND ch.status = 'ACTIVE'
            WHERE g.org_id = ? AND g.archived_at IS NULL GROUP BY g.id HAVING n > g.capacity
        )
    """, (org,)).fetchone()[0]
    if over:
        items.append({"key": "capacity", "kind": "groups", "tab": "dashboard",
                      "label": "Sig'imidan oshgan guruhlar", "detail": "guruh", "count": over})

    unlinked = conn.execute("""
        SELECT COUNT(*) FROM children WHERE org_id = ? AND status = 'ACTIVE' AND parent_chat_id IS NULL
    """, (org,)).fetchone()[0]
    if unlinked:
        items.append({"key": "telegram", "kind": "telegram", "tab": "children",
                      "label": "Telegramga ulanmagan ota-onalar", "detail": "bola", "count": unlinked})
    return items


@router.get("/stats")
def get_dashboard_stats(user: dict = Depends(require("dashboard.view"))):
    org = user["org"]
    today = date.today().isoformat()
    conn = get_connection()
    c = conn.cursor()

    c.execute("SELECT COUNT(*) FROM children WHERE status = 'ACTIVE' AND org_id = ?", (org,))
    total_children = c.fetchone()[0]

    att = c.execute("""
        SELECT
          SUM(CASE WHEN status IN ('PRESENT', 'LATE') THEN 1 ELSE 0 END) AS present,
          SUM(CASE WHEN status IN ('ABSENT', 'EXCUSED') THEN 1 ELSE 0 END) AS absent
        FROM attendance WHERE date = ? AND org_id = ?
    """, (today, org)).fetchone()
    present_today, absent_today = att["present"] or 0, att["absent"] or 0

    staff_total = c.execute("SELECT COUNT(*) FROM staff WHERE org_id = ? AND status = 'ACTIVE'", (org,)).fetchone()[0]
    staff_att = c.execute("""
        SELECT SUM(CASE WHEN status IN ('PRESENT', 'LATE') THEN 1 ELSE 0 END) AS present, COUNT(*) AS marked
        FROM staff_attendance WHERE date = ? AND org_id = ?
    """, (today, org)).fetchone()

    c.execute("SELECT COALESCE(SUM(amount), 0) FROM payments WHERE org_id = ? AND strftime('%Y-%m', paid_at) = ?",
              (org, today[:7]))
    revenue = c.fetchone()[0]

    c.execute("SELECT COALESCE(SUM(amount_due - amount_paid), 0) FROM invoices WHERE amount_due > amount_paid AND org_id = ?", (org,))
    debts = c.fetchone()[0]

    c.execute("SELECT icon, message, created_at FROM activity_logs WHERE org_id = ? ORDER BY id DESC LIMIT 5", (org,))
    activities = [
        {"icon": row["icon"], "text": row["message"], "time": row["created_at"][-8:-3] if row["created_at"] else "09:00"}
        for row in c.fetchall()
    ]

    collection = finance.collection(conn, org)
    history = finance.income_history(conn, org)
    attention = _attention(conn, org, today)
    conn.close()

    return {
        "total_children": total_children,
        "present_today": present_today,
        "absent_today": absent_today,
        "unmarked_today": max(0, total_children - present_today - absent_today),
        "attendance_rate": round(present_today / total_children * 100, 1) if total_children else 0,
        "staff_total": staff_total,
        "staff_present": staff_att["present"] or 0,
        "staff_marked": staff_att["marked"] or 0,
        "monthly_revenue": revenue,
        "total_debts": debts,
        "collection": collection,
        "income_history": history,
        "attention": attention,
        "activities": activities,
    }
