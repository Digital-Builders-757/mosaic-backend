'use strict';

/**
 * Subscription activation is driven by the subscription's OWN invoice.
 *
 * Stripe API 2025-03-31 (basil) and later removed `invoice.payment_intent` and
 * `invoice.subscription`. The payment secret now lives on
 * `invoice.confirmation_secret` and the subscription id on
 * `invoice.parent.subscription_details.subscription`. Both shapes are read so
 * webhook endpoints pinned to older API versions keep working.
 *
 * A plan is activated only when Stripe reports the invoice as paid AND the
 * Stripe subscription itself is active/trialing. Charges or PaymentIntents that
 * merely carry `metadata.subscriptionId` never activate a plan.
 */

const ACTIVE_STRIPE_SUBSCRIPTION_STATUSES = new Set(['active', 'trialing']);

function idOf(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  return typeof value.id === 'string' ? value.id : null;
}

function subscriptionIdFromInvoice(invoice) {
  return (
    idOf(invoice?.parent?.subscription_details?.subscription) ||
    idOf(invoice?.subscription) ||
    null
  );
}

function invoiceClientSecret(invoice) {
  if (!invoice || typeof invoice !== 'object') return null;
  return (
    invoice.confirmation_secret?.client_secret ||
    invoice.payment_intent?.client_secret ||
    null
  );
}

async function activateSubscriptionFromPaidInvoice({
  stripe,
  Subscription,
  invoice,
  onActivated,
  logger = console,
}) {
  if (!invoice || invoice.status !== 'paid') {
    return { activated: false, reason: 'invoice_not_paid' };
  }

  const stripeSubscriptionId = subscriptionIdFromInvoice(invoice);
  if (!stripeSubscriptionId) {
    logger.warn?.(`Paid invoice ${invoice.id} has no subscription; not activating`);
    return { activated: false, reason: 'no_subscription_on_invoice' };
  }

  const local = await Subscription.findOne({ stripeSubscriptionId });
  if (!local) {
    logger.error?.(`No local subscription for Stripe subscription ${stripeSubscriptionId}`);
    return { activated: false, reason: 'local_subscription_not_found' };
  }

  const stripeSubscription = await stripe.subscriptions.retrieve(stripeSubscriptionId);
  if (!ACTIVE_STRIPE_SUBSCRIPTION_STATUSES.has(stripeSubscription?.status)) {
    logger.warn?.(
      `Invoice ${invoice.id} paid but Stripe subscription ${stripeSubscriptionId} is ${stripeSubscription?.status}; not activating`
    );
    // `incomplete` right after a paid invoice is transient: ask the caller to
    // let Stripe retry rather than acknowledging and losing the activation.
    return {
      activated: false,
      reason: `stripe_subscription_${stripeSubscription?.status}`,
      retryable: stripeSubscription?.status === 'incomplete',
    };
  }

  const updated = await Subscription.findOneAndUpdate(
    { _id: local._id, status: { $ne: 'active' } },
    { $set: { status: 'active', paymentStatus: 'COMPLETED' } },
    { new: true }
  );

  if (!updated) {
    return { activated: false, reason: 'already_active', subscription: local };
  }

  logger.log?.(`Subscription ${updated._id} activated from paid invoice ${invoice.id}`);
  if (typeof onActivated === 'function') {
    onActivated(updated);
  }
  return { activated: true, subscription: updated };
}

module.exports = {
  ACTIVE_STRIPE_SUBSCRIPTION_STATUSES,
  activateSubscriptionFromPaidInvoice,
  invoiceClientSecret,
  subscriptionIdFromInvoice,
};
