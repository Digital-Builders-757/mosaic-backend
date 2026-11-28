const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const Subscription = require('../models/Subscription');
const SubscriptionPlan = require('../models/SubscriptionPlan');
const { ensurePlanPrice } = require('../helpers/stripePlan'); // ← ADD THIS
const { triggerTierWelcomeNotifications } = require('../utils/vendorTierWelcomeEmail');
const {
  ACTIVE_STRIPE_SUBSCRIPTION_STATUSES,
  activateSubscriptionFromPaidInvoice,
  invoiceClientSecret,
} = require('../utils/subscriptionInvoiceActivation');

const INVOICE_EXPAND = ['latest_invoice.confirmation_secret'];

/**
 * A pending local subscription whose Stripe subscription is still incomplete
 * with an open invoice is resumed (same customer, same invoice) instead of
 * creating another customer + subscription. If Stripe already reports it paid
 * and active, it is activated from that invoice.
 */
async function resumePendingSubscription({ userId, planId, applicationId }) {
  const query = {
    userId,
    subscriptionPlanId: planId,
    status: 'pending',
    stripeSubscriptionId: { $exists: true, $ne: null },
  };
  // Never resume across applications: a request without an application id
  // only matches pending records that also have none.
  query.applicationId = applicationId || null;

  const pending = await Subscription.findOne(query).sort({ createdAt: -1 });
  if (!pending) return null;

  const expirePending = async () => {
    await Subscription.findOneAndUpdate(
      { _id: pending._id, status: 'pending' },
      { $set: { status: 'expired' } }
    );
  };

  let stripeSubscription;
  try {
    stripeSubscription = await stripe.subscriptions.retrieve(
      pending.stripeSubscriptionId,
      { expand: INVOICE_EXPAND }
    );
  } catch (error) {
    if (error?.code === 'resource_missing' || error?.statusCode === 404) {
      await expirePending();
      return null;
    }
    throw error;
  }
  const invoice = stripeSubscription.latest_invoice;

  if (stripeSubscription.status === 'incomplete' && invoice?.status === 'open') {
    const clientSecret = invoiceClientSecret(invoice);
    if (clientSecret) {
      return {
        pending,
        stripeSubscription,
        clientSecret,
        active: false,
        amountDue: typeof invoice.amount_due === 'number' ? invoice.amount_due : null,
      };
    }
    return null;
  }

  if (['incomplete_expired', 'canceled'].includes(stripeSubscription.status)) {
    await expirePending();
    return null;
  }

  if (ACTIVE_STRIPE_SUBSCRIPTION_STATUSES.has(stripeSubscription.status) && invoice?.status === 'paid') {
    const result = await activateSubscriptionFromPaidInvoice({
      stripe,
      Subscription,
      invoice,
      onActivated: triggerTierWelcomeNotifications,
    });
    return { pending: result.subscription || pending, stripeSubscription, clientSecret: null, active: true };
  }

  return null;
}

exports.createSubscription = async (req, res) => {
  try {
    const userId = req.user._id;
    let { planId, applicationId } = req.body;

    // Check query params if not in body (handles ?appId=... from frontend)
    if (!applicationId) {
      applicationId = req.query.applicationId || req.query.appId;
    }

    if (!planId) {
      return res.status(400).json({
        success: false,
        message: 'planId is required'
      });
    }

    // if (!applicationId) {
    //   return res.status(400).json({
    //     success: false,
    //     message: 'applicationId is required'
    //   });
    // }

    // Get plan
    const plan = await SubscriptionPlan.findById(planId);
    if (!plan) {
      return res.status(404).json({
        success: false,
        message: 'Plan not found'
      });
    }

    // Ensure the Stripe price exists in the active Stripe account.
    const { priceId } = await ensurePlanPrice(plan);

    if (!priceId) {
      return res.status(500).json({
        success: false,
        message: 'Failed to create Stripe price for plan'
      });
    }

    if (plan.price > 0) {
      const resumed = await resumePendingSubscription({ userId, planId, applicationId });
      if (resumed) {
        return res.status(200).json({
          success: true,
          message: resumed.active ? 'Subscription activated' : 'Subscription created, payment required',
          data: {
            subscriptionId: resumed.pending._id,
            stripeSubscriptionId: resumed.stripeSubscription.id,
            clientSecret: resumed.clientSecret,
            amount: resumed.amountDue ?? plan.price * 100,
            currency: plan.currency,
            resumed: true,
          }
        });
      }
    }

    // Create Stripe customer
    const customer = await stripe.customers.create({
      email: req.user.email,
      name: req.user.name,
      metadata: { userId: userId.toString() }
    });

    // Create subscription with incomplete status; its first invoice carries the payment.
    const stripeSubscription = await stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: priceId }],
      payment_behavior: 'default_incomplete',
      payment_settings: { save_default_payment_method: 'on_subscription' },
      expand: INVOICE_EXPAND,
      metadata: {
        userId: userId.toString(),
        planId: planId.toString()
      }
    });

    // The client pays the subscription's own invoice. Never create a separate
    // PaymentIntent: it would charge the vendor without paying the invoice.
    const clientSecret = invoiceClientSecret(stripeSubscription.latest_invoice);

    if (!clientSecret && plan.price > 0) {
      try {
        await stripe.subscriptions.cancel(stripeSubscription.id);
      } catch (cancelError) {
        console.error('Failed to cancel subscription without invoice payment:', cancelError);
      }
      return res.status(502).json({
        success: false,
        message: 'Stripe did not return a payment for the subscription invoice. Please try again.'
      });
    }

    const requiresPayment = plan.price > 0;

    // Create local subscription
    const startDate = new Date();
    const endDate = new Date();
    endDate.setDate(startDate.getDate() + plan.durationInDays);

    const subscription = new Subscription({
      userId,
      subscriptionPlanId: planId,
      stripeSubscriptionId: stripeSubscription.id,
      stripeCustomerId: customer.id,
      applicationId,
      paymentStatus: requiresPayment ? 'PENDING' : 'COMPLETED',
      payerEmail: req.user.email,
      startDate,
      endDate,
      status: requiresPayment ? 'pending' : 'active'
    });

    await subscription.save();

    if (!requiresPayment) {
      triggerTierWelcomeNotifications(subscription);
    }

    return res.status(201).json({
      success: true,
      message: clientSecret ? 'Subscription created, payment required' : 'Subscription activated',
      data: {
        subscriptionId: subscription._id,
        stripeSubscriptionId: stripeSubscription.id,
        clientSecret,
        amount: plan.price * 100,
        currency: plan.currency
      }
    });

  } catch (error) {
    console.error('Subscription creation error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to create subscription',
      error: error.message
    });
  }
};


// Get user's subscriptions and populate subscription plan
exports.getUserSubscriptions = async (req, res) => {
    try {
        const subscriptions = await Subscription.find({
            userId: req.user._id,
            businessId: null
        })
            .populate('subscriptionPlanId')
            .exec();

        if (!subscriptions || subscriptions.length === 0) {
            return res.status(404).json({ 
                success: false,
                message: 'No subscriptions found for the user.' 
            });
        }

        res.status(200).json({ 
            success: true,
            data: subscriptions 
        });
    } catch (error) {
        console.error('Error fetching subscriptions:', error);
        res.status(500).json({ 
            success: false,
            message: 'Error fetching subscriptions, please try again later.' 
        });
    }
};
