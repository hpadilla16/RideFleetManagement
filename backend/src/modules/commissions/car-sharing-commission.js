/**
 * Car Sharing Commission Structure
 *
 * Host Tiers:
 *   STARTER: Host keeps 85%, platform takes 15%
 *   PRO:     Host keeps 80%, platform takes 20%
 *   ELITE:   Host keeps 75%, platform takes 25%
 *
 * Guest Fees:
 *   Service fee: 10% of trip price
 *   Trip Protection: Basic ($0), Standard ($12/day), Premium ($22/day)
 *   Under 25 surcharge: $15/day
 *   Delivery fee: set by host
 */

export const HOST_TIERS = {
  STARTER: {
    id: 'STARTER',
    label: 'Starter',
    hostKeepsPct: 85,
    platformTakesPct: 15,
    features: ['Basic listing', 'Trip chat', 'Earnings dashboard'],
  },
  PRO: {
    id: 'PRO',
    label: 'Pro',
    hostKeepsPct: 80,
    platformTakesPct: 20,
    features: ['Priority in search', 'Analytics', 'Instant book badge', 'All Starter features'],
  },
  ELITE: {
    id: 'ELITE',
    label: 'Elite',
    hostKeepsPct: 75,
    platformTakesPct: 25,
    features: ['Featured placement', 'AI pricing suggestions', 'Dedicated support', 'All Pro features'],
  },
};

export const GUEST_SERVICE_FEE_PCT = 10;
export const UNDER_25_SURCHARGE_PER_DAY = 15;

export const TRIP_PROTECTION_TIERS = {
  BASIC: {
    id: 'BASIC',
    label: 'Basic',
    pricePerDay: 0,
    deductibleReimbursementMax: 0,
    roadsideAssistance: false,
    description: 'No deductible reimbursement. Guest pays for all damages. Host files with own insurer.',
  },
  STANDARD: {
    id: 'STANDARD',
    label: 'Standard',
    pricePerDay: 12,
    deductibleReimbursementMax: 1000,
    roadsideAssistance: false,
    description: 'Ride reimburses host insurance deductible up to $1,000.',
  },
  PREMIUM: {
    id: 'PREMIUM',
    label: 'Premium',
    pricePerDay: 22,
    deductibleReimbursementMax: 2500,
    roadsideAssistance: false,
    description: 'Ride reimburses host insurance deductible up to $2,500.',
  },
};

/**
 * What Trip Protection DOES NOT cover — excluded from ALL tiers.
 */
export const PROTECTION_EXCLUSIONS = [
  'Tire damage, blowouts, or flat tires',
  'Windshield and glass damage (chips, cracks, breaks)',
  'Normal wear and tear',
  'Mechanical breakdown or engine failure',
  'Interior damage from normal use (stains, odors)',
  'Personal property left in the vehicle',
  'Liability for bodily injury or death',
  'Damage to third-party vehicles or property',
  'Damage caused by unauthorized drivers',
  'Damage from off-road use, racing, or illegal activity',
  'Pre-existing damage not documented in pre-trip inspection',
  'Loss of use or diminished value',
];

/**
 * Optional add-ons — sold separately at checkout.
 * Host can choose which add-ons to offer on their listing.
 */
export const OPTIONAL_ADDONS = {
  TIRE_PROTECTION: {
    id: 'TIRE_PROTECTION',
    label: 'Tire Protection',
    pricePerDay: 5,
    description: 'Covers tire damage including blowouts, flats, and rim damage during the trip.',
    hostOffered: true,
  },
  GLASS_PROTECTION: {
    id: 'GLASS_PROTECTION',
    label: 'Glass Protection',
    pricePerDay: 4,
    description: 'Covers windshield and window glass damage including chips and cracks.',
    hostOffered: true,
  },
  ROADSIDE_ASSISTANCE: {
    id: 'ROADSIDE_ASSISTANCE',
    label: 'Roadside Assistance',
    pricePerDay: 6,
    description: 'Towing, jump start, flat tire change, lockout, and fuel delivery.',
    hostOffered: true,
  },
};

/**
 * Calculate full commission breakdown for a car sharing trip.
 */
export function calculateCarSharingCommission({
  baseDailyRate,
  days,
  hostTier = 'STARTER',
  protectionTier = 'BASIC',
  deliveryFee = 0,
  cleaningFee = 0,
  guestAge = 25,
}) {
  const tier = HOST_TIERS[hostTier] || HOST_TIERS.STARTER;
  const protection = TRIP_PROTECTION_TIERS[protectionTier] || TRIP_PROTECTION_TIERS.BASIC;

  const tripSubtotal = Number(baseDailyRate || 0) * Number(days || 1);
  const hostGross = tripSubtotal + Number(cleaningFee || 0);

  // Host commission
  const platformCommission = round(hostGross * (tier.platformTakesPct / 100));
  const hostEarnings = round(hostGross - platformCommission);

  // Guest fees
  const guestServiceFee = round(tripSubtotal * (GUEST_SERVICE_FEE_PCT / 100));
  const protectionFee = round(protection.pricePerDay * Number(days || 1));
  const under25Surcharge = Number(guestAge || 25) < 25 ? round(UNDER_25_SURCHARGE_PER_DAY * Number(days || 1)) : 0;
  const deliveryTotal = round(Number(deliveryFee || 0));

  // Guest total
  const guestTotal = round(tripSubtotal + guestServiceFee + protectionFee + under25Surcharge + deliveryTotal + Number(cleaningFee || 0));

  // Platform revenue
  const platformRevenue = round(platformCommission + guestServiceFee);
  const protectionFundContribution = protectionFee;

  return {
    // Trip
    baseDailyRate: round(baseDailyRate),
    days: Number(days || 1),
    tripSubtotal: round(tripSubtotal),

    // Host
    hostTier: tier.id,
    hostTierLabel: tier.label,
    hostKeepsPct: tier.hostKeepsPct,
    hostGross: round(hostGross),
    platformCommission: round(platformCommission),
    hostEarnings: round(hostEarnings),

    // Guest breakdown
    guestServiceFee: round(guestServiceFee),
    guestServiceFeePct: GUEST_SERVICE_FEE_PCT,
    protectionTier: protection.id,
    protectionTierLabel: protection.label,
    protectionFee: round(protectionFee),
    protectionPerDay: protection.pricePerDay,
    under25Surcharge: round(under25Surcharge),
    deliveryFee: round(deliveryTotal),
    cleaningFee: round(cleaningFee),
    guestTotal: round(guestTotal),

    // Platform
    platformRevenue: round(platformRevenue),
    protectionFundContribution: round(protectionFundContribution),
    totalPlatformIncome: round(platformRevenue + protectionFundContribution),

    // Protection details
    deductibleReimbursementMax: protection.deductibleReimbursementMax,
    roadsideAssistance: protection.roadsideAssistance,
  };
}

function round(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}
