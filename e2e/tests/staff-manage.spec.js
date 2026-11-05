const { test, expect } = require('@playwright/test');
const { loginAs } = require('../helpers');

for (const role of ['accountant', 'super_admin']) {
  test(`${role} can add and then remove a staff member from the Staff tab`, async ({ page }) => {
    await loginAs(page, role);
    await page.locator('.nav-item[data-tab="staff"]').click();

    const name = `Sinov Xodim ${Date.now()}`;
    await page.locator('[data-perm-action="staff.manage"]').click();
    await expect(page.locator('#addStaffModal')).toBeVisible();
    await page.locator('#newStaffName').fill(name);
    await page.locator('#newStaffRole').fill('Тарбиячи');
    await page.locator('#newStaffPhone').fill('+998901234599');
    await page.locator('#newStaffSalary').fill('3500000');
    await page.locator('#addStaffSubmitBtn').click();

    const row = page.locator('#staffPayrollTableBody tr', { hasText: name });
    await expect(row).toBeVisible();

    await row.locator('.staff-delete-btn').click();
    await expect(page.locator('#deleteStaffModal')).toHaveClass(/open/);
    await page.locator('#deleteStaffSubmit').click();
    await expect(row).toHaveCount(0);
    await expect(page.locator('#staffSheetBody')).not.toContainText(name);
  });
}

for (const role of ['director']) {
  test(`${role} sees the Staff tab but no add or delete buttons`, async ({ page }) => {
    await loginAs(page, role);
    await page.locator('.nav-item[data-tab="staff"]').click();
    await expect(page.locator('#staffPayrollTableBody tr').first()).toBeVisible();
    await expect(page.locator('[data-perm-action="staff.manage"]')).toBeHidden();
    await expect(page.locator('.staff-delete-btn')).toHaveCount(0);
  });
}
