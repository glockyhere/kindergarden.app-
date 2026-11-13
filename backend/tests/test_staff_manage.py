NEW_STAFF = {"name": "Malika Yusupova", "role": "Тарбиячи", "phone": "+998901234500", "base_salary": 3500000}


def _payroll_names(client, headers):
    return [p["staff_name"] for p in client.get("/api/v1/staff/payroll", headers=headers).json()["rows"]]


def test_accountant_can_add_staff_and_they_appear_in_payroll(client, auth_headers):
    headers = auth_headers("accountant")
    res = client.post("/api/v1/staff", json=NEW_STAFF, headers=headers)
    assert res.status_code == 200
    assert "Malika Yusupova" in _payroll_names(client, headers)
    assert any(s["name"] == "Malika Yusupova" for s in client.get("/api/v1/staff", headers=headers).json())


def test_removed_staff_disappear_from_lists_and_attendance(client, auth_headers):
    headers = auth_headers("super_admin")
    staff_id = client.post("/api/v1/staff", json=NEW_STAFF, headers=headers).json()["staff_id"]
    assert client.delete(f"/api/v1/staff/{staff_id}", headers=headers).status_code == 200

    assert "Malika Yusupova" not in _payroll_names(client, headers)
    assert all(s["id"] != staff_id for s in client.get("/api/v1/staff", headers=headers).json())
    att = client.get("/api/v1/staff/attendance", headers=headers).json()["staff"]
    assert all(s["id"] != staff_id for s in att)
    assert client.delete(f"/api/v1/staff/{staff_id}", headers=headers).status_code == 404


def test_only_super_admin_and_accountant_can_add_or_remove_staff(client, auth_headers):
    for role in ("director", "teacher", "nurse"):
        assert client.post("/api/v1/staff", json=NEW_STAFF, headers=auth_headers(role)).status_code == 403
    staff_id = client.post("/api/v1/staff", json=NEW_STAFF, headers=auth_headers("accountant")).json()["staff_id"]
    for role in ("director", "teacher", "nurse"):
        assert client.delete(f"/api/v1/staff/{staff_id}", headers=auth_headers(role)).status_code == 403


def test_invalid_staff_input_is_rejected(client, auth_headers):
    headers = auth_headers("accountant")
    assert client.post("/api/v1/staff", json={**NEW_STAFF, "name": ""}, headers=headers).status_code == 422
    assert client.post("/api/v1/staff", json={**NEW_STAFF, "base_salary": -1}, headers=headers).status_code == 422
    assert client.post("/api/v1/staff", json={**NEW_STAFF, "hire_date": "yesterday"}, headers=headers).status_code == 400


def test_add_and_remove_are_audited(client, auth_headers):
    headers = auth_headers("accountant")
    staff_id = client.post("/api/v1/staff", json=NEW_STAFF, headers=headers).json()["staff_id"]
    client.delete(f"/api/v1/staff/{staff_id}", headers=headers)
    actions = [e["action"] for e in client.get("/api/v1/audit/log", headers=auth_headers("director")).json()]
    assert actions[:2] == ["staff.delete", "staff.create"]


def _set_row(staff_id, month, status):
    from app.database import get_connection
    conn = get_connection()
    conn.execute("""INSERT INTO staff_payroll (id, org_id, staff_id, month, base_salary, bonus, advance_paid, final_paid, status)
                    VALUES (?, 'org_smart_kids', ?, ?, 3500000, 0, 0, ?, ?)""",
                 (f"pr_t_{month}", staff_id, month, 3500000 if status == "PAID" else 0, status))
    conn.commit()
    conn.close()


def test_removing_staff_keeps_unpaid_salary_of_past_months(client, auth_headers):
    headers = auth_headers("accountant")
    staff_id = client.post("/api/v1/staff", json={**NEW_STAFF, "hire_date": "2025-01-01"}, headers=headers).json()["staff_id"]
    _set_row(staff_id, "2025-05", "PENDING")
    _set_row(staff_id, "2025-06", "PAID")
    assert client.delete(f"/api/v1/staff/{staff_id}", headers=headers).status_code == 200

    may = client.get("/api/v1/staff/payroll?month=2025-05", headers=headers).json()["rows"]
    row = next(r for r in may if r["staff_id"] == staff_id)
    assert row["status"] == "PENDING" and row["staff_active"] is False
    # Still payable after they left.
    assert client.post("/api/v1/staff/pay", json={"payroll_id": row["id"], "amount": 3500000}, headers=headers).status_code == 200

    june = client.get("/api/v1/staff/payroll?month=2025-06", headers=headers).json()["rows"]
    assert next(r for r in june if r["staff_id"] == staff_id)["staff_active"] is False
    assert "Malika Yusupova" not in _payroll_names(client, headers)


def test_removed_staff_cannot_get_attendance(client, auth_headers):
    headers = auth_headers("accountant")
    staff_id = client.post("/api/v1/staff", json=NEW_STAFF, headers=headers).json()["staff_id"]
    client.delete(f"/api/v1/staff/{staff_id}", headers=headers)
    res = client.post("/api/v1/staff/attendance/mark", json={"staff_id": staff_id, "status": "PRESENT"}, headers=headers)
    assert res.status_code == 404


def test_salary_change_applies_from_this_month_only(client, auth_headers):
    from datetime import date
    headers = auth_headers("accountant")
    staff_id = client.post("/api/v1/staff", json={**NEW_STAFF, "hire_date": "2025-01-01"}, headers=headers).json()["staff_id"]
    _set_row(staff_id, "2025-05", "PENDING")
    _set_row(staff_id, "2025-06", "PAID")

    res = client.patch(f"/api/v1/staff/{staff_id}/salary", json={"base_salary": 4_200_000}, headers=headers)
    assert res.status_code == 200

    this_month = date.today().strftime("%Y-%m")
    now = next(r for r in client.get(f"/api/v1/staff/payroll?month={this_month}", headers=headers).json()["rows"]
               if r["staff_id"] == staff_id)
    assert now["base_salary"] == 4_200_000 and now["total_to_pay"] == 4_200_000
    for month in ("2025-05", "2025-06"):
        old = next(r for r in client.get(f"/api/v1/staff/payroll?month={month}", headers=headers).json()["rows"]
                   if r["staff_id"] == staff_id)
        assert old["base_salary"] == 3_500_000
    assert next(s for s in client.get("/api/v1/staff", headers=headers).json() if s["id"] == staff_id)["salary"] == 4_200_000

    log = client.get("/api/v1/audit/log", headers=auth_headers("super_admin")).json()
    assert log[0]["action"] == "staff.salary"


def test_only_accountant_and_super_admin_can_change_salary(client, auth_headers):
    staff_id = client.post("/api/v1/staff", json=NEW_STAFF, headers=auth_headers("accountant")).json()["staff_id"]
    for role in ("director", "teacher", "nurse"):
        assert client.patch(f"/api/v1/staff/{staff_id}/salary", json={"base_salary": 1}, headers=auth_headers(role)).status_code == 403
    for role in ("accountant", "super_admin"):
        assert client.patch(f"/api/v1/staff/{staff_id}/salary", json={"base_salary": 1}, headers=auth_headers(role)).status_code == 200


def test_salary_change_validation(client, auth_headers):
    headers = auth_headers("accountant")
    staff_id = client.post("/api/v1/staff", json=NEW_STAFF, headers=headers).json()["staff_id"]
    assert client.patch(f"/api/v1/staff/{staff_id}/salary", json={"base_salary": -5}, headers=headers).status_code == 422
    assert client.patch("/api/v1/staff/nope/salary", json={"base_salary": 5}, headers=headers).status_code == 404
    client.delete(f"/api/v1/staff/{staff_id}", headers=headers)
    assert client.patch(f"/api/v1/staff/{staff_id}/salary", json={"base_salary": 5}, headers=headers).status_code == 404


def test_staff_sort_key_puts_leadership_first_then_alphabetical():
    from app.routes.staff import staff_sort_key
    people = [
        ("ASOSIY", "Тарбиячи", "SUVANOVA FERUZA"),
        ("RAHBARIYAT", "Бухгалтер", "BEGLOVA ALFIYA"),
        ("ASOSIY", "Тарбиячи", "Исматова Гўзал"),
        ("RAHBARIYAT", "Директор", "ZOKIROV ALI"),
        ("ASOSIY", "Қўриқчи", "ABDULLAYEVA MADINA"),
        ("RAHBARIYAT", "Бош услубчи", "XAMROKULOV OYBEK"),
        ("ASOSIY", "Тарбиячи", "ISROILOVA FERUZA"),
    ]
    ordered = [p[2] for p in sorted(people, key=lambda p: staff_sort_key(*p))]
    assert ordered == ["ZOKIROV ALI", "XAMROKULOV OYBEK", "BEGLOVA ALFIYA",
                       "ABDULLAYEVA MADINA", "Исматова Гўзал", "ISROILOVA FERUZA", "SUVANOVA FERUZA"]


def test_payroll_lists_rahbariyat_first(client, auth_headers):
    headers = auth_headers("accountant")
    client.post("/api/v1/staff", json={**NEW_STAFF, "name": "AAA BOSHLIQ", "role": "Бухгалтер", "department": "RAHBARIYAT"},
                headers=headers)
    rows = client.get("/api/v1/staff/payroll", headers=headers).json()["rows"]
    departments = [r["department"] for r in rows]
    assert departments == sorted(departments, key=lambda d: d != "RAHBARIYAT")
    assert rows[0]["department"] == "RAHBARIYAT"


def test_accountant_edits_name_role_and_department(client, auth_headers):
    headers = auth_headers("accountant")
    staff_id = client.post("/api/v1/staff", json=NEW_STAFF, headers=headers).json()["staff_id"]
    res = client.patch(f"/api/v1/staff/{staff_id}",
                       json={"name": "  BEGLOVA ALFIYA RISHATOVNA ", "role": "Бухгалтер", "department": "RAHBARIYAT"},
                       headers=headers)
    assert res.status_code == 200
    me = next(s for s in client.get("/api/v1/staff", headers=headers).json() if s["id"] == staff_id)
    assert (me["name"], me["role"], me["department"]) == ("BEGLOVA ALFIYA RISHATOVNA", "Бухгалтер", "RAHBARIYAT")
    log = client.get("/api/v1/audit/log", headers=auth_headers("super_admin")).json()
    assert log[0]["action"] == "staff.update" and "name" in log[0]["changes"]


def test_only_accountant_and_super_admin_can_edit_staff(client, auth_headers):
    staff_id = client.post("/api/v1/staff", json=NEW_STAFF, headers=auth_headers("accountant")).json()["staff_id"]
    body = {"name": "X", "role": "Y", "department": "ASOSIY"}
    for role in ("director", "teacher", "nurse"):
        assert client.patch(f"/api/v1/staff/{staff_id}", json=body, headers=auth_headers(role)).status_code == 403
    for role in ("accountant", "super_admin"):
        assert client.patch(f"/api/v1/staff/{staff_id}", json=body, headers=auth_headers(role)).status_code == 200
    bad = client.patch(f"/api/v1/staff/{staff_id}", json={**body, "department": "OTHER"}, headers=auth_headers("accountant"))
    assert bad.status_code == 400
    assert client.patch(f"/api/v1/staff/{staff_id}", json={**body, "name": "   "}, headers=auth_headers("accountant")).status_code == 400


def test_deleted_staff_leave_the_monthly_sheet_even_with_attendance(client, auth_headers):
    from datetime import date
    from app.database import get_connection
    headers = auth_headers("accountant")
    staff_id = client.post("/api/v1/staff", json=NEW_STAFF, headers=headers).json()["staff_id"]
    today = date.today().isoformat()
    conn = get_connection()
    conn.execute("INSERT INTO staff_attendance (id, org_id, staff_id, date, status) VALUES ('sa_t', 'org_smart_kids', ?, ?, 'PRESENT')",
                 (staff_id, today))
    conn.commit()
    conn.close()
    client.delete(f"/api/v1/staff/{staff_id}", headers=headers)
    sheet = client.get(f"/api/v1/staff/attendance/month?month={today[:7]}", headers=headers).json()
    assert all(s["id"] != staff_id for s in sheet["staff"])


def test_duplicate_staff_names_are_refused(client, auth_headers):
    headers = auth_headers("accountant")
    first = client.post("/api/v1/staff", json={**NEW_STAFF, "name": "XATAMOVA MARIYA ALISHEROVNA"}, headers=headers)
    assert first.status_code == 200
    for same in ("XATAMOVA MARIYA ALISHEROVNA", "  xatamova  mariya alisherovna ", "Хатамова Мария Алишеровна"):
        res = client.post("/api/v1/staff", json={**NEW_STAFF, "name": same}, headers=headers)
        assert res.status_code == 400 and "allaqachon" in res.json()["detail"]
    # Renaming someone else to that name is refused too; renaming yourself is fine.
    other = client.post("/api/v1/staff", json={**NEW_STAFF, "name": "BOSHQA ODAM"}, headers=headers).json()["staff_id"]
    body = {"name": "XATAMOVA MARIYA ALISHEROVNA", "role": "x", "department": "ASOSIY"}
    assert client.patch(f"/api/v1/staff/{other}", json=body, headers=headers).status_code == 400
    me = first.json()["staff_id"]
    assert client.patch(f"/api/v1/staff/{me}", json=body, headers=headers).status_code == 200
    # Once the first person is deleted, the name is free again.
    client.delete(f"/api/v1/staff/{me}", headers=headers)
    assert client.post("/api/v1/staff", json={**NEW_STAFF, "name": "XATAMOVA MARIYA ALISHEROVNA"}, headers=headers).status_code == 200
