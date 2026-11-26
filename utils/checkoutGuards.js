const {
  getPublicMarketplaceBusinessBlock,
} = require('../lib/marketplace/businessEligibility');

function getBusinessCheckoutBlock(business) {
  const marketplaceBlock = getPublicMarketplaceBusinessBlock(business, {
    ineligibleMessage:
      'This vendor is not approved and active for checkout.',
  });
  if (marketplaceBlock) return marketplaceBlock;

  if (!business.stripeConnectAccountId) {
    return {
      status: 400,
      message: 'Vendor is not connected to Stripe.',
    };
  }

  return null;
}

// Shared product/variant eligibility for buy-now quote and order initiation,
// so the two checkout endpoints cannot drift. `variant.productId` must be the
// populated Product. `!isActive` is intentional: the Product schema defaults
// isActive to true, so hydrated legacy documents lacking the field pass; only
// an explicit false (or null) is rejected.
function isPurchasableVariant(variant, productId) {
  const product = variant && variant.productId;
  return Boolean(
    product &&
    product._id &&
    product.isPublished &&
    product.isActive &&
    !product.isDeleted &&
    variant.isPublished &&
    !variant.isDeleted &&
    product._id.toString() === productId
  );
}

module.exports = {
  getBusinessCheckoutBlock,
  isPurchasableVariant,
};
