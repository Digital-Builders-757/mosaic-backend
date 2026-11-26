// routes/admin/serviceSubcategoryRoutes.js
const express = require('express');
const router = express.Router();
const {
  createServiceSubcategory,
  getServiceSubcategories,
  updateServiceSubcategory,
  deleteServiceSubcategory,
} = require('../../controllers/admin/serviceSubcategoryController');
const authenticate = require('../../middlewares/authenticate');
const isAdmin = require('../../middlewares/isAdmin');

router.use(authenticate, isAdmin);

router.get('/', getServiceSubcategories);
router.post('/', createServiceSubcategory);
router.put('/:id', updateServiceSubcategory);
router.delete('/:id', deleteServiceSubcategory);

module.exports = router;
