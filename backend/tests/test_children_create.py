from datetime import date

from app.database import get_connection

CHILD = {"first_name": "Ali", "last_name": "Valiyev", "birth_date": "2022-01-01", "group_name": "Yulduzcha",
         "parent_name": "Vali", "parent_phone": "+998900000000"}


def test_same_child_cannot_be_added_twice(client, auth_headers):
    h = auth_headers("accountant")
    assert client.post("/api/v1/children", json=CHILD, headers=h).status_code == 200
    again = client.post("/api/v1/children", json={**CHILD, "first_name": " ali "}, headers=h)
    assert again.status_code == 400 and "allaqachon" in again.json()["detail"]
    # Same name but a different birth date is a different child.
    assert client.post("/api/v1/children", json={**CHILD, "birth_date": "2021-05-05"}, headers=h).status_code == 200


def test_new_child_owes_this_month_not_a_fake_paid_october(client, auth_headers):
    h = auth_headers("accountant")
    child_id = client.post("/api/v1/children", json=CHILD, headers=h).json()["child_id"]
    conn = get_connection()
    rows = conn.execute("SELECT billing_period, amount_paid, status FROM invoices WHERE child_id = ?", (child_id,)).fetchall()
    conn.close()
    assert [(r["billing_period"], r["amount_paid"], r["status"]) for r in rows] == [(date.today().strftime("%Y-%m"), 0, "DEBT")]
