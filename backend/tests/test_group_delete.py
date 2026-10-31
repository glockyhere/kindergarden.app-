from app.database import get_connection


def _groups(client, auth_headers):
    return {g["id"]: g for g in client.get("/api/v1/groups", headers=auth_headers("super_admin")).json()}


def test_only_super_admin_can_delete(client, auth_headers):
    for role in ("director", "accountant", "teacher", "nurse"):
        assert client.delete("/api/v1/groups/g3", headers=auth_headers(role)).status_code == 403
    assert "groups.delete" not in client.get("/api/v1/auth/me", headers=auth_headers("director")).json()["permissions"]
    assert "groups.delete" in client.get("/api/v1/auth/me", headers=auth_headers("super_admin")).json()["permissions"]


def test_delete_empty_group(client, auth_headers):
    conn = get_connection()
    conn.execute("UPDATE children SET status = 'ARCHIVED' WHERE group_id = 'g3'")
    conn.commit()
    conn.close()
    res = client.delete("/api/v1/groups/g3", headers=auth_headers("super_admin"))
    assert res.status_code == 200 and res.json()["moved"] == 0
    assert "g3" not in _groups(client, auth_headers)
    # The row stays so history of past children still shows their group.
    conn = get_connection()
    assert conn.execute("SELECT archived_at FROM groups WHERE id = 'g3'").fetchone()[0]
    action = conn.execute("SELECT action FROM audit_log ORDER BY id DESC LIMIT 1").fetchone()[0]
    conn.close()
    assert action == "groups.delete"
    # Deleting twice, or editing a deleted group, is a 404.
    assert client.delete("/api/v1/groups/g3", headers=auth_headers("super_admin")).status_code == 404


def test_group_with_children_needs_a_target(client, auth_headers):
    h = auth_headers("super_admin")
    before = _groups(client, auth_headers)
    moving = before["g1"]["count"]
    assert moving > 0
    res = client.delete("/api/v1/groups/g1", headers=h)
    assert res.status_code == 400 and "bola bor" in res.json()["detail"]
    assert client.delete("/api/v1/groups/g1?move_to=g1", headers=h).status_code == 400
    assert client.delete("/api/v1/groups/g1?move_to=nope", headers=h).status_code == 400

    res = client.delete("/api/v1/groups/g1?move_to=g2", headers=h)
    assert res.status_code == 200 and res.json()["moved"] == moving
    after = _groups(client, auth_headers)
    assert "g1" not in after
    assert after["g2"]["count"] == before["g2"]["count"] + moving


def test_deleted_group_name_can_be_reused_and_not_used_for_new_children(client, auth_headers):
    h = auth_headers("super_admin")
    conn = get_connection()
    conn.execute("UPDATE children SET status = 'ARCHIVED' WHERE group_id = 'g3'")
    conn.commit()
    conn.close()
    client.delete("/api/v1/groups/g3", headers=h)
    child = {"first_name": "Ali", "last_name": "Valiyev", "birth_date": "2022-01-01", "group_name": "Kichkintoy",
             "parent_name": "Vali", "parent_phone": "+998900000000"}
    assert client.post("/api/v1/children", json=child, headers=h).status_code == 400
    new = {"name": "Kichkintoy", "age_category": "2-3 yosh", "capacity": 20, "teacher_name": "X", "monthly_fee": 1}
    assert client.post("/api/v1/groups", json=new, headers=h).status_code == 200
