const VENDOR_BUSINESS_PROFILE_ALLOWLIST = [
  'firstName',
  'lastName',
  'primaryEmail',
  'primaryPhone',
  'language',
  'hasBusinessLicense',
  'licenseNumber',
  'noLicenseComplianceConfirmed',
  'businessBio',
  'characterLimit',
  'businessProfileImage',
  'featureBanner',
  'businessEmail',
  'businessPhone',
  'alternatePhone',
  'website',
  'facebook',
  'instagram',
  'twitter',
  'linkedin',
  'tiktok',
  'refundPolicyDocument',
  'termsDocument',
  'googleReviewLink',
  'communityServiceLink',
];

const VENDOR_PROTECTED_ONBOARDING_FIELDS = [
  'verificationPayment',
  'status',
  'applicationId',
  'badge',
  'totalVerificationPoints',
  'verificationChecklist',
  'businessId',
  'submittedAt',
  'profileCompletionNotifiedAt',
  'onboardingReminderLog',
  'verificationNotificationLog',
  'userId',
  'trustScore',
  'trust_score',
  'isApproved',
  'isVerified',
  'role',
  'adminNotes',
  // Admin review metadata — set only by finalizeVerification
  'reviewDecision',
  'rejectionReason',
  'adminReviewNotes',
  'requiredNextAction',
  'reviewedBy',
  'reviewedAt',
  'verifiedAt',
  'rejectedAt',
];

const VENDOR_MEDIA_SUBDOC_FIELDS = new Set([
  'businessProfileImage',
  'featureBanner',
  'refundPolicyDocument',
  'termsDocument',
]);

const VENDOR_DOCUMENT_ARRAY_FIELDS = new Set([
  'minorityProofDocuments',
  'taxDocuments',
  'businessLicenseDocuments',
]);

function stripProtectedVendorFields(payload) {
  const cleaned = { ...payload };

  for (const field of VENDOR_PROTECTED_ONBOARDING_FIELDS) {
    delete cleaned[field];
  }

  return cleaned;
}

function sanitizeVendorMediaField(incoming, existing) {
  if (incoming === undefined) {
    return undefined;
  }

  const existingVerified = existing?.verified ?? false;

  if (incoming === null) {
    return { url: '', verified: existingVerified };
  }

  if (typeof incoming === 'string') {
    return { url: incoming, verified: existingVerified };
  }

  if (typeof incoming === 'object') {
    const url = typeof incoming.url === 'string' ? incoming.url : '';
    return { url, verified: existingVerified };
  }

  return existing ?? { url: '', verified: false };
}

function sanitizeVendorDocumentArray(items) {
  if (!Array.isArray(items)) {
    return items;
  }

  return items.map((item) => {
    if (typeof item === 'string') {
      return { url: item, verified: false };
    }

    if (item && typeof item === 'object') {
      return {
        url: typeof item.url === 'string' ? item.url : '',
        verified: false,
      };
    }

    return { url: '', verified: false };
  });
}

function applyVendorBusinessProfileFields(onboarding, payload) {
  for (const field of VENDOR_BUSINESS_PROFILE_ALLOWLIST) {
    if (payload[field] === undefined) {
      continue;
    }

    if (VENDOR_MEDIA_SUBDOC_FIELDS.has(field)) {
      onboarding[field] = sanitizeVendorMediaField(payload[field], onboarding[field]);
    } else {
      onboarding[field] = payload[field];
    }
  }
}

function applyVendorDraftField(onboarding, key, value) {
  if (VENDOR_MEDIA_SUBDOC_FIELDS.has(key)) {
    onboarding[key] = sanitizeVendorMediaField(value, onboarding[key]);
    return;
  }

  if (VENDOR_DOCUMENT_ARRAY_FIELDS.has(key)) {
    onboarding[key] = sanitizeVendorDocumentArray(value);
    return;
  }

  onboarding[key] = value;
}


// Optional Stage-1 select/number fields. The frontend sends "" for an
// untouched "Select" dropdown or an empty number input; Mongoose enum
// validation rejects "", so blank values mean "unset" on a draft save.
// Required-at-submit checks live in validateStage1Payload and are unchanged.
const OPTIONAL_DRAFT_ENUM_FIELDS = [
  'ownershipType',
  'yearsInBusiness',
  'businessType',
  'employeesCount',
];

const OPTIONAL_DRAFT_NUMBER_FIELDS = ['characterLimit'];

const OPTIONAL_DRAFT_ENUM_ARRAY_FIELDS = ['minorityCategories'];

function isBlankDraftValue(value) {
  return value === null || (typeof value === 'string' && value.trim() === '');
}

/**
 * Normalizes optional enum/number fields on an (already field-mapped) draft
 * payload. Blank values are removed from the payload and reported in
 * `clearedFields` so the caller can unset them on the stored record;
 * non-blank enum strings are trimmed; blank entries are dropped from enum
 * arrays. Non-numeric number values are reported in `invalidFields`
 * (the draft default-fill would otherwise mask Mongoose's cast error);
 * invalid enum values are left for schema validation. Both become a 400.
 */
function normalizeOptionalDraftFields(payload) {
  const normalized = { ...payload };
  const clearedFields = [];
  const invalidFields = [];

  for (const field of [...OPTIONAL_DRAFT_ENUM_FIELDS, ...OPTIONAL_DRAFT_NUMBER_FIELDS]) {
    if (!(field in normalized)) continue;
    const value = normalized[field];

    if (isBlankDraftValue(value)) {
      delete normalized[field];
      clearedFields.push(field);
    } else if (typeof value === 'string') {
      normalized[field] = value.trim();
    }
  }

  for (const field of OPTIONAL_DRAFT_NUMBER_FIELDS) {
    if (!(field in normalized)) continue;
    const value = normalized[field];
    const isNumeric =
      (typeof value === 'number' || typeof value === 'string') &&
      Number.isFinite(Number(value));
    if (!isNumeric) invalidFields.push(field);
  }

  for (const field of OPTIONAL_DRAFT_ENUM_ARRAY_FIELDS) {
    if (!(field in normalized)) continue;
    const value = normalized[field];

    if (isBlankDraftValue(value)) {
      normalized[field] = [];
    } else if (Array.isArray(value)) {
      normalized[field] = value
        .filter((item) => !isBlankDraftValue(item) && item !== undefined)
        .map((item) => (typeof item === 'string' ? item.trim() : item));
    }
  }

  return { payload: normalized, clearedFields, invalidFields };
}

module.exports = {
  VENDOR_BUSINESS_PROFILE_ALLOWLIST,
  VENDOR_PROTECTED_ONBOARDING_FIELDS,
  VENDOR_MEDIA_SUBDOC_FIELDS,
  VENDOR_DOCUMENT_ARRAY_FIELDS,
  stripProtectedVendorFields,
  sanitizeVendorMediaField,
  sanitizeVendorDocumentArray,
  applyVendorBusinessProfileFields,
  applyVendorDraftField,
  OPTIONAL_DRAFT_ENUM_FIELDS,
  OPTIONAL_DRAFT_NUMBER_FIELDS,
  OPTIONAL_DRAFT_ENUM_ARRAY_FIELDS,
  normalizeOptionalDraftFields,
};
