const { test, expect } = require('@playwright/test');
const { loginAs, API_BASE } = require('../helpers');

async function createGroup(page, name) {
  const token = await page.evaluate(() => localStorage.getItem('bogcha_token'));
  const res = await page.request.post(`${API_BASE}/groups`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { name, age_category: '3-4 yosh', capacity: 20, teacher_name: 'Test', monthly_fee: 1000000 },
  });
  expect(res.ok()).toBeTruthy();
}

function groupCard(page, name) {
  return page.locator('#groupsMiniGrid .group-card').filter({ has: page.locator('.group-name', { hasText: name }) });
}

test('super admin deletes an empty group', async ({ page }) => {
  await loginAs(page, 'super_admin');
  await createGroup(page, 'Bo\'sh guruh');
  await page.reload();

  await groupCard(page, 'Bo\'sh guruh').getByRole('button').click();
  await page.locator('#groupModalDelete').click();
  await expect(page.locator('#deleteGroupModal')).toHaveClass(/open/);
  await expect(page.locator('#deleteGroupMoveField')).toBeHidden();
  await page.locator('#deleteGroupSubmit').click();

  await expect(page.locator('#deleteGroupModal')).not.toHaveClass(/open/);
  await expect(groupCard(page, 'Bo\'sh guruh')).toHaveCount(0);
});

test('deleting a group with children moves them to the chosen group', async ({ page }) => {
  await loginAs(page, 'super_admin');
  await createGroup(page, 'Yangi uy');
  await page.reload();

  await groupCard(page, 'Yulduzcha').getByRole('button').click();
  await page.locator('#groupModalDelete').click();
  await expect(page.locator('#deleteGroupMoveField')).toBeVisible();
  const target = await page.locator('#deleteGroupMoveTo option', { hasText: 'Yangi uy' }).getAttribute('value');
  await page.locator('#deleteGroupMoveTo').selectOption(target);
  await page.locator('#deleteGroupSubmit').click();

  await expect(groupCard(page, 'Yulduzcha')).toHaveCount(0);
  await expect(groupCard(page, 'Yangi uy').locator('.group-ring b')).not.toHaveText('0');
});

test('director can edit a group but not delete it', async ({ page }) => {
  await loginAs(page, 'director');
  await page.locator('#groupsMiniGrid .group-card').first().getByRole('button').click();
  await expect(page.locator('#addGroupModal')).toHaveClass(/open/);
  await expect(page.locator('#groupModalDelete')).toBeHidden();
});

test('children page shows edit and delete for the selected group', async ({ page }) => {
  await loginAs(page, 'super_admin');
  await createGroup(page, 'Sahifadan');
  await page.reload();
  await page.locator('.nav-item[data-tab="children"]').click();

  await expect(page.locator('#groupTabActions .btn')).toHaveCount(0);
  await page.locator('#groupFilterTabs .filter-tab[data-group="Sahifadan"]').click();
  await expect(page.locator('#groupTabActions .btn')).toHaveCount(2);

  await page.locator('#groupTabActions .btn-danger').click();
  await expect(page.locator('#deleteGroupModal')).toHaveClass(/open/);
  await page.locator('#deleteGroupSubmit').click();
  await expect(page.locator('#groupFilterTabs .filter-tab[data-group="Sahifadan"]')).toHaveCount(0);
  await expect(page.locator('#groupFilterTabs .filter-tab.active')).toHaveAttribute('data-group', 'ALL');
});

test('director sees only the edit button on the children page', async ({ page }) => {
  await loginAs(page, 'director');
  await page.locator('.nav-item[data-tab="children"]').click();
  await page.locator('#groupFilterTabs .filter-tab:not([data-group="ALL"])').first().click();
  await expect(page.locator('#groupTabActions .btn')).toHaveCount(1);
  await expect(page.locator('#groupTabActions .btn-danger')).toHaveCount(0);
});
