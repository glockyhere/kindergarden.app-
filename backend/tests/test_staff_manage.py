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
