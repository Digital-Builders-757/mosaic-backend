const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const Order = require('../models/Order');
const Subscription = require('../models/Subscription'); // ← ADD THIS LINE
const {
  decrementInventoryForPaidOrder,
  releaseInventoryReservation,
} = require('../lib/inventory/orderInventory');
const {
  publicPaidOrderEmailDelivery,
  sendOrderPaidConfirmationIfNeeded,
} = require('../utils/sendOrderPaidConfirmation');
const { sendVendorTierWelcomeSMS } = require('../utils/telnyxService');
const { triggerTierWelcomeNotifications } = require('../utils/vendorTierWelcomeEmail');
const {
  ACTIVE_STRIPE_SUBSCRIPTION_STATUSES,
  activateSubscriptionFromPaidInvoice,
  subscriptionIdFromInvoice,
} = require('../utils/subscriptionInvoiceActivation');
const User = require('../models/User');
const SubscriptionPlan = require('../models/SubscriptionPlan');

const toPublicEmailDelivery = (result) =>
  typeof publicPaidOrderEmailDelivery === 'function'
    ? publicPaidOrderEmailDelivery(result)
    : {
        emailSent: Boolean(result?.emailSent),
        emailSkipped: Boolean(result?.emailSkipped),
        emailFailed: Boolean(result?.emailFailed),
        ...(result?.emailWarning ? { emailWarning: result.emailWarning } : {}),
      };

const toStripePayloadBuffer = (body) => {
  if (Buffer.isBuffer(body)) {
    return body;
  }

  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }

  if (typeof body === 'string') {
    return Buffer.from(body, 'utf8');
  }

  return null;
};

const cancelRetryablePaymentIntent = async (paymentIntent) => {
  if (!paymentIntent?.id) {
    return { status: paymentIntent?.status || 'unknown', paymentIntent };
  }

  if (
    paymentIntent.status === 'canceled' ||
    paymentIntent.status === 'succeeded'
  ) {
    return { status: paymentIntent.status, paymentIntent };
  }

  try {
    const canceled = await stripe.paymentIntents.cancel(paymentIntent.id, {
      cancellation_reason: 'abandoned',
    });
    return {
      status: canceled?.status || 'canceled',
      paymentIntent: canceled || paymentIntent,
    };
  } catch (error) {
    // Webhook delivery is at-least-once. A prior delivery may already have
    // cancelled the intent, or payment may have won the cancellation race.
    const current = await stripe.paymentIntents.retrieve(paymentIntent.id);
    if (current?.status === 'canceled' || current?.status === 'succeeded') {
      return { status: current.status, paymentIntent: current };
    }
    throw error;
  }
};

const reconcileSucceededOrderPayment = async (orderId, paymentIntent) => {
  const updatedOrder = await Order.findByIdAndUpdate(
    orderId,
    {
      paymentStatus: 'paid',
      status: 'ordered',
    },
    { new: true }
  );

  if (!updatedOrder) {
    console.warn(
      `Order webhook could not find order ${orderId} for payment intent ${paymentIntent.id}.`
    );
    return { reconciled: false };
  }

  console.log('Order marked paid from webhook', {
    orderId: updatedOrder._id.toString(),
    paymentStatus: updatedOrder.paymentStatus,
    status: updatedOrder.status,
  });

  try {
    const inventoryResult = await decrementInventoryForPaidOrder(updatedOrder);
    if (inventoryResult.decremented) {
      console.log(
        `Inventory decremented for paid order ${updatedOrder._id}`,
        JSON.stringify({ lines: inventoryResult.lines?.length || 0 })
      );
    } else if (inventoryResult.reason === 'already_decremented') {
      console.log(
        `Inventory already decremented for order ${updatedOrder._id}, skipping`
      );
    }
  } catch (inventoryErr) {
    console.error(
      `Failed to decrement inventory for paid order ${updatedOrder._id}:`,
      inventoryErr
    );
  }

  // Primary Stripe order webhook historically only flipped paid/ordered.
  // Confirmation mail lives here so production `/api/webhooks/stripe` delivers it.
  let emailResult;
  try {
    emailResult = await sendOrderPaidConfirmationIfNeeded(updatedOrder, {
      currency: paymentIntent?.currency,
    });
    if (emailResult.sent) {
      console.log(`Order paid confirmation emailed for order ${updatedOrder._id}`);
    } else if (emailResult.emailWarning) {
      console.error('Order paid confirmation email delivery incomplete', {
        orderId: String(updatedOrder._id),
      });
    }
  } catch (emailErr) {
    emailResult = {
      emailSent: false,
      emailSkipped: false,
      emailFailed: true,
      emailWarning: 'paid_order_email_delivery_incomplete',
    };
    console.error('Unexpected paid-confirmation orchestration failure', {
      orderId: String(updatedOrder._id),
    });
  }

  return {
    reconciled: true,
    order: updatedOrder,
    emailDelivery: toPublicEmailDelivery(emailResult),
  };
};

const failUnpaidOrderAndReleaseReservation = async (orderId, paymentIntent) => {
  const failedOrder = await Order.findOneAndUpdate(
    {
      _id: orderId,
      paymentStatus: { $ne: 'paid' },
      inventoryDecrementedAt: null,
    },
    {
      $set: {
        paymentStatus: 'failed',
        status: 'cancelled',
      },
    },
    { new: true }
  );

  if (!failedOrder) {
    console.log('Ignoring stale failed/canceled payment event for paid/finalized order', {
      orderId,
      paymentIntentId: paymentIntent.id,
    });
    return { ignored: true };
  }

  await releaseInventoryReservation(failedOrder);
  return { ignored: false, order: failedOrder };
};

// Webhook to handle Stripe events (like successful payments)
const handleStripeWebhook = async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const payload = toStripePayloadBuffer(req.body);
  const endpointSecret = process.env.STRIPE_ORDER_WEBHOOK_SECRET;

  let event;

  try {
    if (!sig) {
      return res.status(400).send('Webhook Error: stripe-signature header is required');
    }

    if (!endpointSecret) {
      console.error('Stripe webhook secret is missing for /api/webhooks/stripe');
      return res.status(500).send('Stripe webhook secret is not configured');
    }

    if (!payload) {
      console.error('Stripe webhook received a non-raw body', {
        bodyType: typeof req.body,
        isBuffer: Buffer.isBuffer(req.body),
        contentType: req.headers['content-type'],
      });
      return res.status(400).send('Webhook Error: expected raw request body');
    }

    // Verify the webhook signature to ensure the event is from Stripe
    event = stripe.webhooks.constructEvent(payload, sig, endpointSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', {
      message: err.message,
      contentType: req.headers['content-type'],
      payloadLength: payload ? payload.length : 0,
      signaturePresent: Boolean(sig),
      endpointSecretPresent: Boolean(endpointSecret),
    });
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log('Order webhook received', {
    type: event.type,
    endpointSecretPresent: Boolean(endpointSecret),
  });

  // Handle the event based on its type
  switch (event.type) {
    case 'payment_intent.succeeded':
      const paymentIntent = event.data.object;
      const orderId = paymentIntent.metadata.orderId;
      console.log('Order payment succeeded event', {
        paymentIntentId: paymentIntent.id,
        orderId,
      });

      try {
        await reconcileSucceededOrderPayment(orderId, paymentIntent);
      } catch (error) {
        console.error(`Failed to update order ${orderId} after payment success:`, error);
        return res.status(500).send('Failed to update order status');
      }
      
      res.status(200).send({ received: true });
      break;

    case 'payment_intent.payment_failed':
      const failedPaymentIntent = event.data.object;
      const failedOrderId = failedPaymentIntent.metadata.orderId;
      console.log('Order payment failed event', {
        paymentIntentId: failedPaymentIntent.id,
        orderId: failedOrderId,
      });

      // A failed PaymentIntent is normally retryable. Cancel it before
      // releasing stock so the old client secret cannot later oversell.
      try {
        const cancellation = await cancelRetryablePaymentIntent(
          failedPaymentIntent
        );
        if (cancellation.status === 'succeeded') {
          await reconcileSucceededOrderPayment(
            failedOrderId,
            cancellation.paymentIntent
          );
        } else {
          const failureResult = await failUnpaidOrderAndReleaseReservation(
            failedOrderId,
            failedPaymentIntent
          );
          if (!failureResult.ignored) {
            console.log('Order marked failed from webhook', {
              orderId: failureResult.order._id.toString(),
              paymentStatus: failureResult.order.paymentStatus,
              status: failureResult.order.status,
            });
          }
        }
      } catch (error) {
        console.error(`Failed to update order ${failedOrderId} after payment failure:`, error);
        return res.status(500).send('Failed to update order status');
      }

      res.status(200).send({ received: true });
      break;

    case 'payment_intent.canceled':
      const canceledPaymentIntent = event.data.object;
      const canceledOrderId = canceledPaymentIntent.metadata.orderId;
      try {
        await failUnpaidOrderAndReleaseReservation(
          canceledOrderId,
          canceledPaymentIntent
        );
      } catch (error) {
        console.error(`Failed to release inventory for cancelled order ${canceledOrderId}:`, error);
        return res.status(500).send('Failed to release order inventory');
      }

      res.status(200).send({ received: true });
      break;

    // Handle additional events, for example, 'payment_intent.requires_action'
    case 'payment_intent.requires_action':
      const requiresActionPaymentIntent = event.data.object;
      const actionOrderId = requiresActionPaymentIntent.metadata.orderId;

      console.log(`Payment intent requires further action for order ${actionOrderId}.`);
      res.status(200).send({ received: true });
      break;

    // Handle charge refunded event
    case 'charge.refunded':
      const chargeRefunded = event.data.object;
      const refundedOrderId = chargeRefunded.metadata.orderId;
      console.log('Order refund event', {
        chargeId: chargeRefunded.id,
        orderId: refundedOrderId,
      });

      // Update order status to refunded
      try {
        const refundedOrder = await Order.findByIdAndUpdate(refundedOrderId, {
          paymentStatus: 'refunded',
          status: 'refunded',
        }, { new: true });

        if (!refundedOrder) {
          console.warn(`Order webhook could not find refunded order ${refundedOrderId} for charge ${chargeRefunded.id}.`);
        } else {
          console.log('Order marked refunded from webhook', {
            orderId: refundedOrder._id.toString(),
            paymentStatus: refundedOrder.paymentStatus,
            status: refundedOrder.status,
          });
        }
      } catch (error) {
        console.error(`Failed to update order ${refundedOrderId} after refund:`, error);
        return res.status(500).send('Failed to update order status');
      }

      res.status(200).send({ received: true });
      break;

    default:
      console.log(`Unhandled event type: ${event.type}`);
      res.status(200).send({ received: true });
  }
};

// Add to webhookController.js or create subscriptionWebhook.js
const handleSubscriptionWebhook = async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const payload = req.body;
  const endpointSecret = process.env.STRIPE_SUBSCRIPTION_WEBHOOK_SECRET;

  let event;

  try {
    if (!sig) {
      return res.status(400).send('Webhook Error: stripe-signature header is required');
    }

    if (!endpointSecret) {
      console.error('Stripe webhook secret is missing for /api/subscription/webhook');
      return res.status(500).send('Stripe webhook secret is not configured');
    }

    event = stripe.webhooks.constructEvent(payload, sig, endpointSecret);
  } catch (err) {
    console.error('Webhook error:', err);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log('🔹 Received Stripe event type:', event.type);
  switch (event.type) {
    case 'customer.created':
      console.log(`Ignoring Stripe event type: ${event.type}`);
      break;

    case 'invoice.payment_succeeded':
    case 'invoice.paid': {
      // Activate only from the subscription's own paid invoice, after Stripe
      // confirms the subscription itself is active.
      try {
        const result = await activateSubscriptionFromPaidInvoice({
          stripe,
          Subscription,
          invoice: event.data.object,
          onActivated: triggerTierWelcomeNotifications,
        });
        if (result.retryable) {
          return res.status(500).send({ received: false, retry: result.reason });
        }
      } catch (error) {
        console.error(`Error handling ${event.type}:`, error);
        return res.status(500).send({ received: false });
      }
      break;
    }

    case 'customer.subscription.updated': {
      // Backstop for ordering: when Stripe flips the subscription to active,
      // activate from its latest invoice if (and only if) that invoice is paid.
      const updatedSubscription = event.data.object;
      if (!ACTIVE_STRIPE_SUBSCRIPTION_STATUSES.has(updatedSubscription?.status)) break;
      const latestInvoiceId =
        typeof updatedSubscription.latest_invoice === 'string'
          ? updatedSubscription.latest_invoice
          : updatedSubscription.latest_invoice?.id;
      if (!latestInvoiceId) break;
      try {
        const latestInvoice = await stripe.invoices.retrieve(latestInvoiceId);
        await activateSubscriptionFromPaidInvoice({
          stripe,
          Subscription,
          invoice: latestInvoice,
          onActivated: triggerTierWelcomeNotifications,
        });
      } catch (error) {
        console.error(`Error handling ${event.type}:`, error);
        return res.status(500).send({ received: false });
      }
      break;
    }

    case 'invoice.payment_failed': {
      const failedInvoice = event.data.object;
      const failedStripeSubscriptionId = subscriptionIdFromInvoice(failedInvoice);

      if (!failedStripeSubscriptionId) {
        console.error('❌ Failed invoice has no subscription:', failedInvoice?.id);
        break;
      }

      const failedSub = await Subscription.findOne({
        stripeSubscriptionId: failedStripeSubscriptionId
      });

      if (!failedSub) {
        console.error('❌ Failed subscription not found for:', failedStripeSubscriptionId);
        break;
      }

      failedSub.paymentStatus = 'FAILED';
      // A declined FIRST invoice stays open and payable: keep the record
      // pending so checkout resumes the same invoice instead of creating a
      // second subscription (which could lead to two paid invoices).
      if (failedInvoice?.billing_reason !== 'subscription_create') {
        failedSub.status = 'cancelled';
      }
      await failedSub.save();
      console.log(`❌ Subscription payment failed: ${failedSub._id}`);
      break;
    }

    case 'charge.updated':
    case 'charge.succeeded':
    case 'payment_intent.succeeded':
      // A charge or PaymentIntent tagged with metadata.subscriptionId is not the
      // subscription's invoice (older checkout created a separate PaymentIntent).
      // It never activates a plan; invoice.paid / invoice.payment_succeeded do.
      if (event.data.object?.metadata?.subscriptionId) {
        console.log(
          `Ignoring ${event.type} for subscription ${event.data.object.metadata.subscriptionId}: activation requires the subscription invoice to be paid`
        );
      }
      break;

    default:
      console.log(`Unhandled event type: ${event.type}`);
  }

  res.status(200).send({ received: true });
};



module.exports = { handleStripeWebhook, handleSubscriptionWebhook };
