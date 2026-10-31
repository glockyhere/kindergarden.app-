from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional
import secrets
from app.database import get_connection
from app.security import require
from app import audit

router = APIRouter(prefix="/api/v1", tags=["Bolalar va Guruhlar"])

class ChildCreateSchema(BaseModel):
    first_name: str
    last_name: str
    birth_date: str
    group_name: str
    parent_name: str
    parent_phone: str
    allergies: Optional[str] = "Yo'q"

class HealthUpdateSchema(BaseModel):
    health: str

class PricingUpdateSchema(BaseModel):
    discount: Optional[str] = None
    note: Optional[str] = None
    monthly_fee: Optional[float] = None

class GroupCreateSchema(BaseModel):
    name: str
    age_category: str
    capacity: int = 25
    teacher_name: str
    teacher2_name: Optional[str] = None
    monthly_fee: float

class GroupUpdateSchema(BaseModel):
    age_category: str
    capacity: int
    teacher_name: str
    teacher2_name: Optional[str] = None
    monthly_fee: float

FINANCE_FIELDS = ("listedPrice", "discount", "note", "paymentStatus", "fee", "paid", "debt")


def _child_in_org(c, child_id: str, org: str):
    child = c.execute("SELECT name FROM children WHERE id = ? AND org_id = ?", (child_id, org)).fetchone()
    if not child:
        raise HTTPException(status_code=404, detail="Bola topilmadi")
    return child


@router.get("/groups")
def get_groups(user: dict = Depends(require("children.view"))):
    conn = get_connection()
    c = conn.cursor()
    c.execute("""
    SELECT g.id, g.name, g.age_category, g.capacity, g.teacher_name, g.teacher2_name, g.monthly_fee,
           COUNT(ch.id) as current_count
    FROM groups g
    LEFT JOIN children ch ON g.id = ch.group_id AND ch.status = 'ACTIVE'
    WHERE g.org_id = ? AND g.archived_at IS NULL
    GROUP BY g.id
    ORDER BY g.name
    """, (user["org"],))
    show_fee = "children.finance" in user["permissions"]
    groups = [
        {
            "id": r["id"],
            "name": r["name"],
            "age": r["age_category"],
            "capacity": r["capacity"],
            "count": r["current_count"],
            "teacher": r["teacher_name"],
            "teacher2": r["teacher2_name"],
            "teachers": [t for t in (r["teacher_name"], r["teacher2_name"]) if t and t.strip()],
            "fee": r["monthly_fee"] if show_fee else None
        }
        for r in c.fetchall()
    ]
    conn.close()
    return groups

@router.post("/groups")
def create_group(data: GroupCreateSchema, user: dict = Depends(require("groups.manage"))):
    org = user["org"]
    conn = get_connection()
    c = conn.cursor()

    c.execute("SELECT id FROM groups WHERE name = ? AND org_id = ? AND archived_at IS NULL", (data.name, org))
    if c.fetchone():
        conn.close()
        raise HTTPException(status_code=400, detail="Bu nomli guruh allaqachon mavjud")

    new_id = f"g_{secrets.token_hex(4)}"
    c.execute("""
    INSERT INTO groups (id, org_id, name, age_category, capacity, teacher_name, teacher2_name, monthly_fee, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    """, (new_id, org, data.name, data.age_category, data.capacity, data.teacher_name,
          (data.teacher2_name or "").strip() or None, data.monthly_fee))

    c.execute("INSERT INTO activity_logs (org_id, icon, message) VALUES (?, '🏫', ?)",
              (org, f"Yangi guruh qo'shildi: {data.name} ({data.age_category})."))

    conn.commit()
    conn.close()

    return {"success": True, "group_id": new_id, "name": data.name}

@router.patch("/groups/{group_id}")
def update_group(group_id: str, data: GroupUpdateSchema, user: dict = Depends(require("groups.manage"))):
    if data.capacity < 1 or data.monthly_fee < 0:
        raise HTTPException(status_code=400, detail="Sig'im va to'lov musbat bo'lishi kerak")
    org = user["org"]
    conn = get_connection()
    group = conn.execute("SELECT name FROM groups WHERE id = ? AND org_id = ? AND archived_at IS NULL",
                         (group_id, org)).fetchone()
    if not group:
        conn.close()
        raise HTTPException(status_code=404, detail="Guruh topilmadi")
    conn.execute("""
    UPDATE groups SET age_category = ?, capacity = ?, teacher_name = ?, teacher2_name = ?, monthly_fee = ?
    WHERE id = ? AND org_id = ?
    """, (data.age_category.strip(), data.capacity, data.teacher_name.strip(),
          (data.teacher2_name or "").strip() or None, data.monthly_fee, group_id, org))
    conn.execute("INSERT INTO activity_logs (org_id, icon, message) VALUES (?, '🏫', ?)",
                 (org, f"{group['name']} guruhi ma'lumotlari yangilandi."))
    conn.commit()
    conn.close()
    return {"success": True, "group_id": group_id}

@router.delete("/groups/{group_id}")
def delete_group(group_id: str, move_to: Optional[str] = None, user: dict = Depends(require("groups.delete"))):
    """Removes a group from use. Its row is kept (archived) so past attendance, bills and
    reports of children who were in it still show their group."""
    org = user["org"]
    conn = get_connection()
    group = conn.execute("SELECT name FROM groups WHERE id = ? AND org_id = ? AND archived_at IS NULL",
                         (group_id, org)).fetchone()
    if not group:
        conn.close()
        raise HTTPException(status_code=404, detail="Guruh topilmadi")

    active = conn.execute("SELECT COUNT(*) FROM children WHERE group_id = ? AND status = 'ACTIVE'",
                          (group_id,)).fetchone()[0]
    target = None
    if active:
        if not move_to:
            conn.close()
            raise HTTPException(status_code=400,
                                detail=f"Guruhda {active} ta bola bor. Avval ularni boshqa guruhga o'tkazing.")
        target = conn.execute("SELECT id, name FROM groups WHERE id = ? AND org_id = ? AND archived_at IS NULL",
                              (move_to, org)).fetchone()
        if not target or target["id"] == group_id:
            conn.close()
            raise HTTPException(status_code=400, detail="Bolalarni o'tkazish uchun boshqa guruhni tanlang")
        conn.execute("UPDATE children SET group_id = ? WHERE group_id = ? AND status = 'ACTIVE'",
                     (target["id"], group_id))

    conn.execute("UPDATE groups SET archived_at = CURRENT_TIMESTAMP WHERE id = ?", (group_id,))
    message = f"{group['name']} guruhi o'chirildi."
    if target:
        message += f" {active} ta bola {target['name']} guruhiga o'tkazildi."
    conn.execute("INSERT INTO activity_logs (org_id, icon, message) VALUES (?, '🗑️', ?)", (org, message))
    audit.record(conn, user, "groups.delete", "group", group_id, group["name"],
                 {"moved_to": {"old": None, "new": f"{target['name']} ({active})"}} if target else None)
    conn.commit()
    conn.close()
    return {"success": True, "group_id": group_id, "moved": active, "moved_to": target["name"] if target else None}

@router.get("/children")
def get_children(group: Optional[str] = None, search: Optional[str] = None,
                 user: dict = Depends(require("children.view"))):
    conn = get_connection()
    c = conn.cursor()

    query = """
    SELECT ch.id, ch.name, g.name as group_name, ch.birth_date, ch.parent_name, ch.parent_phone,
           ch.allergies, ch.status, ch.monthly_fee as listed_price, ch.discount, ch.note,
           COALESCE(inv.status, 'PAID') as payment_status,
           COALESCE(inv.amount_due, g.monthly_fee) as fee,
           COALESCE(inv.amount_paid, g.monthly_fee) as paid,
           COALESCE(inv.amount_due - inv.amount_paid, 0) as debt,
           att.status as attendance_status,
           att.check_in_time
    FROM children ch
    JOIN groups g ON ch.group_id = g.id
    LEFT JOIN invoices inv ON ch.id = inv.child_id AND inv.billing_period = '2026-10'
    LEFT JOIN attendance att ON ch.id = att.child_id AND att.date = DATE('now', 'localtime')
    WHERE ch.status = 'ACTIVE' AND ch.org_id = ?
    """
    params = [user["org"]]

    if group and group != "ALL":
        query += " AND g.name = ?"
        params.append(group)

    if search:
        query += " AND (ch.name LIKE ? OR ch.parent_name LIKE ? OR ch.parent_phone LIKE ?)"
        s = f"%{search}%"
        params.extend([s, s, s])

    query += " ORDER BY CAST(SUBSTR(ch.id, 2) AS INTEGER) ASC"
    c.execute(query, params)

    # Roles without finance access never receive money fields, not just hidden columns.
    show_finance = "children.finance" in user["permissions"]
    children = []
    for r in c.fetchall():
        child = {
            "id": r["id"],
            "name": r["name"],
            "group": r["group_name"],
            "birthDate": r["birth_date"],
            "parentName": r["parent_name"],
            "parentPhone": r["parent_phone"],
            "allergies": r["allergies"],
            "status": r["status"],
            "listedPrice": r["listed_price"],
            "discount": r["discount"],
            "note": r["note"],
            "paymentStatus": r["payment_status"],
            "fee": r["fee"],
            "paid": r["paid"],
            "debt": r["debt"],
            "attendance": r["attendance_status"] or "ABSENT",
            "checkInTime": r["check_in_time"]
        }
        if not show_finance:
            for field in FINANCE_FIELDS:
                child.pop(field)
        children.append(child)

    conn.close()
    return children

@router.post("/children")
def create_child(data: ChildCreateSchema, user: dict = Depends(require("children.create"))):
    org = user["org"]
    conn = get_connection()
    c = conn.cursor()

    c.execute("SELECT id, monthly_fee FROM groups WHERE name = ? AND org_id = ? AND archived_at IS NULL",
              (data.group_name, org))
    group = c.fetchone()
    if not group:
        conn.close()
        raise HTTPException(status_code=400, detail="Guruh topilmadi")

    group_id = group["id"]
    monthly_fee = group["monthly_fee"]

    # Next numeric id after the highest existing one (a count would collide after deletions).
    c.execute("SELECT COALESCE(MAX(CAST(SUBSTR(id, 2) AS INTEGER)), 0) FROM children WHERE id GLOB 'c[0-9]*'")
    new_id = f"c{c.fetchone()[0] + 1}"
    full_name = f"{data.first_name} {data.last_name}"

    c.execute("""
    INSERT INTO children (id, org_id, group_id, name, birth_date, parent_name, parent_phone, allergies, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE')
    """, (new_id, org, group_id, full_name, data.birth_date, data.parent_name, data.parent_phone, data.allergies or "Yo'q"))

    inv_id = f"inv_{new_id}"
    c.execute("""
    INSERT INTO invoices (id, org_id, child_id, invoice_number, billing_period, amount_due, amount_paid, status, due_date)
    VALUES (?, ?, ?, ?, '2026-10', ?, ?, 'PAID', '2026-10-15')
    """, (inv_id, org, new_id, f"INV-2026-10-{new_id.upper()}", monthly_fee, monthly_fee))

    c.execute("INSERT INTO activity_logs (org_id, icon, message) VALUES (?, '👶', ?)",
              (org, f"Yangi bola: {full_name} ({data.group_name}) ro'yxatdan o'tdi."))

    conn.commit()
    conn.close()

    return {"success": True, "child_id": new_id, "name": full_name}

@router.delete("/children/{child_id}")
def delete_child(child_id: str, user: dict = Depends(require("children.delete"))):
    org = user["org"]
    conn = get_connection()
    c = conn.cursor()
    child = _child_in_org(c, child_id, org)

    for tbl in ["attendance", "invoices", "monthly_tabel", "payments", "child_clubs"]:
        c.execute(f"DELETE FROM {tbl} WHERE child_id = ?", (child_id,))
    c.execute("DELETE FROM children WHERE id = ? AND org_id = ?", (child_id, org))

    c.execute("INSERT INTO activity_logs (org_id, icon, message) VALUES (?, '🗑️', ?)",
              (org, f"{child['name']} ro'yxatdan o'chirildi."))
    audit.record(conn, user, "children.delete", "child", child_id, child["name"])

    conn.commit()
    conn.close()

    return {"success": True, "child_id": child_id}

@router.get("/children/{child_id}/telegram-link")
async def child_telegram_link(child_id: str, user: dict = Depends(require("parents.invite"))):
    from app import telegram_bot

    conn = get_connection()
    child = conn.execute(
        "SELECT name, parent_chat_id FROM children WHERE id = ? AND org_id = ?", (child_id, user["org"])
    ).fetchone()
    conn.close()
    if not child:
        raise HTTPException(status_code=404, detail="Bola topilmadi")
    username = await telegram_bot.bot_username()
    if not username:
        raise HTTPException(status_code=503, detail="Telegram bot ulanmagan yoki internet yo'q")
    return {
        "child": child["name"],
        "bot": f"@{username}",
        "url": f"https://t.me/{username}?start={telegram_bot.invite_payload(child_id)}",
        "linked": child["parent_chat_id"] is not None,
    }

@router.patch("/children/{child_id}/health")
def update_child_health(child_id: str, data: HealthUpdateSchema,
                        user: dict = Depends(require("children.health.edit"))):
    org = user["org"]
    conn = get_connection()
    c = conn.cursor()
    child = _child_in_org(c, child_id, org)
    old_health = conn.execute(
        "SELECT allergies FROM children WHERE id = ? AND org_id = ?", (child_id, org)
    ).fetchone()["allergies"]

    c.execute("UPDATE children SET allergies = ? WHERE id = ? AND org_id = ?", (data.health, child_id, org))
    c.execute("INSERT INTO activity_logs (org_id, icon, message) VALUES (?, '🩺', ?)",
              (org, f"{child['name']} uchun sog'liq holati yangilandi: {data.health}"))
    if old_health != data.health:
        audit.record(conn, user, "children.health.edit", "child", child_id, child["name"],
                      {"allergies": {"old": old_health, "new": data.health}})

    conn.commit()
    conn.close()

    return {"success": True, "child_id": child_id, "health": data.health}

@router.patch("/children/{child_id}/pricing")
def update_child_pricing(child_id: str, data: PricingUpdateSchema,
                         user: dict = Depends(require("children.pricing.edit"))):
    org = user["org"]
    conn = get_connection()
    c = conn.cursor()
    child = _child_in_org(c, child_id, org)
    before = conn.execute(
        "SELECT discount, note, monthly_fee FROM children WHERE id = ? AND org_id = ?", (child_id, org)
    ).fetchone()

    c.execute("UPDATE children SET discount = ?, note = ?, monthly_fee = ? WHERE id = ? AND org_id = ?",
              (data.discount, data.note, data.monthly_fee, child_id, org))

    if data.monthly_fee is not None:
        c.execute("SELECT id, amount_paid FROM invoices WHERE child_id = ? AND billing_period = '2026-10' AND org_id = ?",
                  (child_id, org))
        invoice = c.fetchone()
        if invoice:
            new_status = "DEBT" if data.monthly_fee > invoice["amount_paid"] else "PAID"
            c.execute("UPDATE invoices SET amount_due = ?, status = ? WHERE id = ?",
                      (data.monthly_fee, new_status, invoice["id"]))
        else:
            new_status = "DEBT" if data.monthly_fee > 0 else "PAID"
            c.execute("""
            INSERT INTO invoices (id, org_id, child_id, invoice_number, billing_period, amount_due, amount_paid,
                                   compensation_discount, status, due_date)
            VALUES (?, ?, ?, ?, '2026-10', ?, 0, 0, ?, '2026-10-10')
            """, (f"inv_{child_id}", org, child_id, f"INV-2026-10-{child_id.upper()}", data.monthly_fee, new_status))

    c.execute("INSERT INTO activity_logs (org_id, icon, message) VALUES (?, '✏️', ?)",
              (org, f"{child['name']} uchun narx/chegirma/izoh yangilandi."))
    changes = audit.diff(
        dict(before),
        {"discount": data.discount, "note": data.note, "monthly_fee": data.monthly_fee},
    )
    if changes:
        audit.record(conn, user, "children.pricing.edit", "child", child_id, child["name"], changes)

    conn.commit()
    conn.close()

    return {"success": True, "child_id": child_id, "discount": data.discount, "note": data.note, "monthly_fee": data.monthly_fee}
