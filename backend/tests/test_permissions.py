"""
One source of truth for the permission table, and a matrix proving every
sensitive route actually enforces it on the server (not just hides a button).
"""
import importlib
import pkgutil
import re

import pytest

import app.routes as routes_pkg
from app.security import PERMISSIONS, ALL_STAFF, MANAGEMENT, FINANCE


def test_every_role_referenced_in_permissions_is_a_known_role():
    known_roles = {"super_admin", "director", "accountant", "teacher", "nurse"}
    for permission, roles in PERMISSIONS.items():
        assert roles <= known_roles, f"{permission} references unknown role(s): {roles - known_roles}"


def test_role_group_constants_are_consistent():
    assert MANAGEMENT == {"super_admin", "director"}
    assert FINANCE == MANAGEMENT | {"accountant"}
    assert ALL_STAFF == FINANCE | {"teacher", "nurse"}


def test_every_require_call_in_the_routes_names_a_real_permission():
    """A typo in require("kitch.manage") would otherwise fail silently as an
    always-403 route with no test ever noticing."""
    pattern = re.compile(r'require\(\s*"([^"]+)"\s*\)')
    found = set()
    for _, modname, _ in pkgutil.iter_modules(routes_pkg.__path__):
        module = importlib.import_module(f"app.routes.{modname}")
        source = open(module.__file__, encoding="utf-8").read()
        found.update(pattern.findall(source))
    assert found, "expected to find at least one require(...) call"
    unknown = found - set(PERMISSIONS)
    assert not unknown, f"routes reference permissions missing from PERMISSIONS: {unknown}"


# (method, path, permission, body) for routes worth a direct black-box check,
# beyond what the feature-specific test files already exercise.
ROUTE_CASES = [
    ("GET", "/api/v1/children", "children.view", None),
    ("POST", "/api/v1/groups", "groups.manage", {"name": "x", "age_category": "x", "capacity": 1, "teacher_name": "x", "monthly_fee": 1}),
    ("GET", "/api/v1/staff/payroll", "staff.view", None),
    ("POST", "/api/v1/staff/pay", "staff.pay", {"payroll_id": "nope", "amount": 1}),
    ("GET", "/api/v1/billing/invoices", "billing.view", None),
    ("POST", "/api/v1/billing/remind-debtors", "billing.remind", None),
    ("GET", "/api/v1/kitchen/reports", "kitchen.view", None),
    ("POST", "/api/v1/kitchen/reports", "kitchen.manage", {"week_start": "2099-01-01", "week_end": "2099-01-01", "child_count": 1, "items": [{"name": "x", "quantity": 1, "unit_price": 1}]}),
    ("POST", "/api/v1/attendance/mark", "attendance.mark", {"child_id": "c1", "status": "PRESENT"}),
    ("GET", "/api/v1/attendance", "attendance.view", None),
    ("GET", "/api/v1/reports/revenue", "finance.reports", None),
    ("GET", "/api/v1/reports/period?period=2025-01", "finance.reports", None),
    ("GET", "/api/v1/reports/child/c1", "finance.reports", None),
    ("GET", "/api/v1/reports/years", "finance.reports", None),
    ("DELETE", "/api/v1/groups/nope", "groups.delete", None),
]

ALL_ROLES = ["super_admin", "director", "accountant", "teacher", "nurse"]


@pytest.mark.parametrize("method,path,permission,body", ROUTE_CASES)
def test_route_enforces_its_permission_for_every_role(client, auth_headers, method, path, permission, body):
    for role in ALL_ROLES:
        allowed = role in PERMISSIONS[permission]
        res = client.request(method, path, json=body, headers=auth_headers(role))
        if allowed:
            assert res.status_code != 403, f"{role} should be allowed on {method} {path}, got {res.status_code}: {res.text}"
        else:
            assert res.status_code == 403, f"{role} should be blocked on {method} {path}, got {res.status_code}: {res.text}"


def test_no_route_is_reachable_without_a_token(client):
    for method, path, _, body in ROUTE_CASES:
        res = client.request(method, path, json=body)
        assert res.status_code == 401, f"{method} {path} should require a token, got {res.status_code}"
