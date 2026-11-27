const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROUTES = [
  ['productSubcategoryRoutes.js', 'getProductSubcategories'],
  ['serviceSubcategoryRoutes.js', 'getServiceSubcategories'],
  ['foodSubcategoryRoutes.js', 'getFoodSubcategories'],
];

for (const [file, listHandler] of ROUTES) {
  test(`${file} registers every route after authenticate + isAdmin`, () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../routes/admin', file),
      'utf8'
    );

    const guardIndex = source.indexOf('router.use(authenticate, isAdmin);');
    assert.ok(guardIndex >= 0, 'router-level admin guard must exist');

    const listIndex = source.indexOf(`router.get('/', ${listHandler});`);
    assert.ok(listIndex >= 0, 'admin subcategory list route must exist');
    assert.ok(listIndex > guardIndex, 'GET list must be registered after the admin guard');

    for (const match of source.matchAll(/router\.(get|post|put|patch|delete)\(/g)) {
      assert.ok(
        match.index > guardIndex,
        `router.${match[1]} at offset ${match.index} is registered before the admin guard`
      );
    }
  });
}
