# Admin Authorization Matrix

**Issue:** [#66 Admin authorization matrix and role-permission audit](https://github.com/Techware-Hut/mosaic-backend/issues/66)  
**Date:** 2026-06-22  
**Scope:** Inventory privileged routes, document guard patterns, list gaps. No broad auth rewrite.

---

## Role model

| Role | Middleware | Authoritative check |
|------|------------|-------------------|
| `admin` | `authenticate` → `isAdmin` | `req.user.role === 'admin'` ([`middlewares/isAdmin.js`](../middlewares/isAdmin.js)) |
| `business_owner` | `authenticate` → `isBusinessOwner` / `requireVerifiedVendor` | `req.user.role === 'business_owner'` |
| `customer` | `authenticate` → `isCustomer` (payment/checkout) | `req.user.role === 'customer'` |
| Vendor + admin | `isBusinessOwnerOrAdmin` | Either role allowed (e.g. S3 presign) |

**403 shape (admin gate):** `{ message: 'Access denied: Admin only' }`

---

## Admin route inventory

Mount prefixes from [`app.js`](../app.js). All mutation routes require `authenticate` + `isAdmin` unless noted.

| Mount prefix | Route file | Guard pattern | Notes |
|--------------|------------|---------------|-------|
| `/admin/users` | `routes/admin/userRoutes.js` | `router.use(authenticate, isAdmin)` | User CRUD, block, create admin |
| `/admin/faqs` | `routes/admin/faqRoutes.js` | Global admin middleware | FAQ CMS |
| `/api/admin/testimonials` | `routes/admin/testimonialRoutes.js` | Global admin middleware | Testimonials |
| `/admin/api/blogs` | `routes/admin/Blog/blogRoutes.js` | Global admin middleware | Blog CRUD + publish/feature |
| `/admin/api/business`, `/api/admin/business` | `routes/admin/businessRoutes.js` | Per-route `authenticate, isAdmin` | Business list, featured toggle |
| `/admin/api/products` | `routes/admin/adminProductRoutes.js` | Per-route | Product list, featured toggle |
| `/admin/api/orders` | `routes/admin/adminOrderRoutes.js` | Per-route | Order list (read-only admin) |
| `/admin/api/audit-events` | `routes/admin/adminAuditRoutes.js` | Global admin middleware | Audit trail read API |
| `/api/admin/category/product` | `routes/admin/productCategoryRoutes.js` | Mutations guarded; **GET list public** | See §Public taxonomy reads |
| `/api/admin/category/product-subcategory` | `routes/admin/productSubcategoryRoutes.js` | Global admin middleware (GET list included) | Public reads use `GET /api/sub-categories` |
| `/api/admin/category/service` | `routes/admin/categoryRoutes.js` | Mutations guarded; **GET list public** | |
| `/api/admin/category/service-subcategory` | `routes/admin/serviceSubcategoryRoutes.js` | Global admin middleware (GET list included) | |
| `/api/admin/category/food` | `routes/admin/foodCategoryRoutes.js` | Mutations guarded; **GET list public** | |
| `/api/admin/category/food-subcategory` | `routes/admin/foodSubcategoryRoutes.js` | Global admin middleware (GET list included) | |
| `/api/admin/category-requests` | `routes/admin/categoryRequestRoutes.js` | Global admin middleware | Approve/reject vendor requests |
| `/admin/business-profile-verify` | `routes/admin/businessProfileVerifyRoutes.js` | Per-route | Profile verification workflow |
| `/admin/vendor-onboard-verify-stage1` | `routes/vendorOnboarding.routes.js` | Admin routes per-route | Pending queue, verify, finalize |
| `/api/cms`, `/cms` | `routes/admin/cmsRoutes.js` | `/admin/*` behind global middleware; `/public/*` open | Public CMS reads intentional |

### Vendor onboarding (shared router)

| Method | Path | Guard | Gap? |
|--------|------|-------|------|
| GET | `/status/:applicationId` | **None** | **G1** — unauthenticated status read; returns application state by ID |
| GET | `/pending` | `authenticate, isAdmin` | OK |
| POST | `/:applicationId/finalize` | `authenticate, isAdmin` | OK |

---

## Public taxonomy reads (intentional)

These admin-mounted **GET list** endpoints expose category metadata without auth for legacy taxonomy dropdowns. Aggregated admin category management uses `GET /api/admin/categories` and now requires `authenticate` + `isAdmin`.

| Endpoint | File |
|----------|------|
| `GET /api/admin/category/product` | `productCategoryRoutes.js` |
| `GET /api/admin/category/service` | `categoryRoutes.js` |
| `GET /api/admin/category/food` | `foodCategoryRoutes.js` |

**Mutations** (POST/PUT/DELETE) on these mounts require admin. The `GET /api/admin/category/*-subcategory` lists now require admin as well (covered by [`tests/admin/admin-subcategory-routes-guard.test.js`](../tests/admin/admin-subcategory-routes-guard.test.js)); public subcategory reads go through `GET /api/sub-categories` and the per-category `/subcategories/:categoryId` routes, which only expose children of public parents. `GET /api/admin/categories` also requires admin and is documented in [`tests/admin/admin-categories-guard.test.js`](../tests/admin/admin-categories-guard.test.js).

---

## Documented authorization gaps

| ID | Area | Risk | Owner | Recommendation |
|----|------|------|-------|----------------|
| **G1** | `GET /admin/vendor-onboard-verify-stage1/status/:applicationId` | Enumeration of application status by ID | Backend | Add `authenticate` + owner or admin check (#66 follow-up) |
| **G2** | `/api/subscriptions/*` | Role-only (`isBusinessOwner`); no per-user ownership on `create` | #76 / #66 | Audit subscription IDOR; scope `userId` to `req.user._id` |
| **G3** | Legacy `/stripe/*` finance routes | Partial auth per route (#41 closed code-side) | DevOps | Keep behind network policy; verify prod smoke |
| **G4** | Admin user list response | Field redaction | `docs/auth.md` checklist | `toAdminUser` redaction — tested in `admin-users-response.test.js` |
| **G5** | Global API rate limit | Authenticated abuse | #57 | CDN/WAF or per-user throttle (deferred) |

**Not gaps:** Public category GET lists (by design). CMS `/public/*` routes. Webhook signature verification on Stripe routes.

---

## Representative test coverage

| Test file | Covers |
|-----------|--------|
| [`tests/admin/admin-route-guards.test.js`](../tests/admin/admin-route-guards.test.js) | Static guard scan on `routes/admin/*` |
| [`tests/admin/is-admin-middleware.test.js`](../tests/admin/is-admin-middleware.test.js) | `isAdmin` 403 for non-admin roles |
| [`tests/admin/admin-order-routes-guard.test.js`](../tests/admin/admin-order-routes-guard.test.js) | Order list guard |
| [`tests/admin/admin-product-routes-guard.test.js`](../tests/admin/admin-product-routes-guard.test.js) | Product admin guard |
| [`tests/admin/admin-categories-guard.test.js`](../tests/admin/admin-categories-guard.test.js) | Public category read documented |
| [`tests/integration/roles.integration.test.js`](../tests/integration/roles.integration.test.js) | Live 403: vendor → admin orders; admin → admin orders 200 |
| [`tests/launch/backend-launch-contract.test.js`](../tests/launch/backend-launch-contract.test.js) | Admin mount prefixes |

---

## Middleware reference

See [`docs/auth.md`](auth.md) §6–7 for full middleware chain and protected route map. This matrix supplements that doc with admin-specific mount inventory and known gaps.

---

## Issue #66 status

| Acceptance criterion | Status |
|---------------------|--------|
| Admin authorization matrix exists | **Done** — this document |
| Privileged routes inventoried | **Done** — tables above |
| Gaps documented | **Done** — G1–G5 |
| Representative tests added | **Done** — guard scan + middleware + integration |
| No broad auth rewrite | **Met** — audit/docs/tests only |
