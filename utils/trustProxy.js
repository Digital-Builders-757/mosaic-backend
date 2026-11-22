'use strict';

/**
 * Number of reverse-proxy hops in front of the Node process.
 *
 * Elastic Beanstalk (LoadBalanced, application LB, nginx) forwards:
 *   client -> ALB (appends client IP to X-Forwarded-For)
 *          -> nginx ($proxy_add_x_forwarded_for appends the ALB node IP)
 *          -> node
 * With `trust proxy` = 1, Express takes the right-most X-Forwarded-For entry,
 * which is the ALB node's private IP, so every visitor shares one req.ip and
 * one rate-limit bucket. Two hops yields the real client IP. A larger value
 * would let clients spoof X-Forwarded-For, so values are capped.
 *
 * TRUST_PROXY_HOPS overrides the default (0..3). Invalid values fall back.
 */
const DEFAULT_TRUST_PROXY_HOPS = 2;
const MAX_TRUST_PROXY_HOPS = 3;

function resolveTrustProxyHops(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return DEFAULT_TRUST_PROXY_HOPS;
  }
  const value = String(raw).trim();
  if (!/^\d+$/.test(value)) return DEFAULT_TRUST_PROXY_HOPS;
  const hops = Number(value);
  if (hops > MAX_TRUST_PROXY_HOPS) return DEFAULT_TRUST_PROXY_HOPS;
  return hops;
}

module.exports = {
  DEFAULT_TRUST_PROXY_HOPS,
  MAX_TRUST_PROXY_HOPS,
  resolveTrustProxyHops,
};
