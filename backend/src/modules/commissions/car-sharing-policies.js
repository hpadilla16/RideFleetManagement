/**
 * Ride Car Sharing — Complete Policy Configuration
 * Single source of truth for all fees, rules, and add-ons.
 */

// ═══════════════════════════════════
//  LATE RETURN
// ═══════════════════════════════════
export const LATE_RETURN_POLICY = {
  gracePeriodMinutes: 30,
  hourlyFee: 25,              // $25/hour after grace period
  fullDayThresholdHours: 2,   // After 2hr → charged full extra day
  noContactThresholdHours: 6, // After 6hr no contact → deposit forfeited + reported
  description: 'A 30-minute grace period is included. After that, you will be charged $25/hour. Returns more than 2 hours late are charged a full extra day at the daily rate. Returns more than 6 hours late with no communication may result in security deposit forfeiture and may be reported as unauthorized use.',
};

// ═══════════════════════════════════
//  MILEAGE
// ═══════════════════════════════════
export const MILEAGE_POLICY = {
  defaultDailyMiles: 200,
  hostOptions: [150, 200, 300, 'UNLIMITED'],
  excessRatePerMile: 0.35,    // $0.35/mile over limit
  hostCanCustomizeRate: true,  // host can set their own rate
  claimWindowHours: 48,
  description: 'Each trip includes 200 miles per day by default. The host may set a different limit on their listing. Miles driven beyond the included amount are charged at $0.35 per mile (or the host\'s posted rate). The host has 48 hours after trip end to submit a mileage overage claim.',
};

// ═══════════════════════════════════
//  CANCELLATION
// ═══════════════════════════════════
export const CANCELLATION_POLICY = {
  guest: {
    freeWindowHours: 48,          // Free cancel 48hr+ before pickup
    partialFeeWindowHours: 24,    // 24-48hr → 50% of first day
    partialFeePct: 50,
    lateFeeWindowHours: 0,        // Under 24hr → 100% of first day
    lateFeePct: 100,
    noShowCharge: 'FULL_TRIP',
    description: 'Free cancellation up to 48 hours before pickup. Cancellations 24-48 hours before pickup incur a fee of 50% of one day\'s rate. Cancellations less than 24 hours before pickup are charged 100% of one day\'s rate. No-shows are charged the full trip amount.',
  },
  host: {
    penalties: [
      { count: 1, fee: 0, action: 'WARNING', label: 'Warning email sent' },
      { count: 2, fee: 50, action: 'FEE', label: '$50 penalty fee' },
      { count: 3, fee: 100, action: 'FEE_AND_SUPPRESS', label: '$100 fee + 30-day search suppression' },
      { count: 4, fee: 100, action: 'REVIEW', label: 'Account review — may result in suspension' },
    ],
    windowDays: 90,  // rolling 90-day window for counting
    guestCompensation: {
      longTrip: 'ONE_DAY_RATE',      // 2+ day trips → guest gets 1 day
      shortTrip: 'HALF_DAY_RATE',    // 1 day trips → guest gets half day
    },
    description: 'Hosts who cancel confirmed bookings face escalating penalties: 1st = warning, 2nd in 90 days = $50, 3rd = $100 + search suppression, 4th+ = account review. Guests receive compensation: one day\'s rate for trips of 2+ days, or half a day for shorter trips.',
  },
};

// ═══════════════════════════════════
//  SECURITY DEPOSIT
// ═══════════════════════════════════
export const SECURITY_DEPOSIT_POLICY = {
  defaultAmount: 250,
  maxHostAmount: 500,
  luxuryMaxAmount: 500,
  holdTiming: 'AT_BOOKING',         // hold placed at booking
  releaseHours: 48,                 // released 48hr after clean return
  description: 'A $250 refundable security deposit hold is placed on your payment method at booking (host may set up to $500 for select vehicles). The hold is released within 48 hours of a clean return with no damage claims.',
};

// ═══════════════════════════════════
//  FUEL / EV
// ═══════════════════════════════════
export const FUEL_POLICY = {
  rule: 'RETURN_SAME_LEVEL',
  fuelRatePerGallon: 5.00,
  refuelingFee: 25,
  evRatePerKwh: 0.30,
  evChargingFee: 15,
  description: 'Return the vehicle with the same fuel or charge level as at pickup. If the fuel level is lower, you will be charged $5.00 per gallon plus a $25 refueling service fee. For electric vehicles: $0.30 per kWh plus a $15 charging fee. Fuel/charge level is documented in the pre-trip inspection photos.',
};

// ═══════════════════════════════════
//  CLEANING VIOLATIONS
// ═══════════════════════════════════
export const CLEANING_POLICY = {
  tiers: [
    { id: 'LIGHT', label: 'Light (trash, crumbs)', fee: 30 },
    { id: 'MEDIUM', label: 'Medium (stains, dirt)', fee: 75 },
    { id: 'HEAVY', label: 'Heavy (food, significant mess)', fee: 150 },
    { id: 'SEVERE', label: 'Severe (biohazard, vomit)', fee: 250 },
  ],
  smoking: { fee: 250, label: 'Smoking or vaping violation' },
  pets: { fee: 150, label: 'Unauthorized pet violation' },
  hostCanAllow: true,
  description: 'Cleaning fees apply when the vehicle is returned in worse condition than received. Smoking: $250. Unauthorized pets: $150. General cleaning: $30 (light) to $250 (severe). Hosts may allow smoking or pets in their listing settings.',
};

// ═══════════════════════════════════
//  ACCIDENT PROCEDURE
// ═══════════════════════════════════
export const ACCIDENT_PROCEDURE = {
  steps: [
    { order: 1, action: 'Ensure safety of all persons. Call 911 if anyone is injured.' },
    { order: 2, action: 'Move to a safe location if possible. Turn on hazard lights.' },
    { order: 3, action: 'Take photos of ALL vehicles involved, damage, license plates, and the scene.' },
    { order: 4, action: 'Exchange information with the other driver: name, phone, insurance, license plate.' },
    { order: 5, action: 'Report the incident in Trip Chat or Issue Center within 1 hour.' },
    { order: 6, action: 'File a police report if estimated damage exceeds $500.' },
    { order: 7, action: 'DO NOT admit fault or sign any documents at the scene.' },
    { order: 8, action: 'Contact your personal auto insurance provider within 24 hours.' },
  ],
  reportDeadlineHours: 1,
  policeReportThreshold: 500,
  description: 'In case of an accident: ensure safety, take photos, exchange info, report in Trip Chat within 1 hour, file police report if damage exceeds $500. Do NOT admit fault. Contact your personal insurer within 24 hours.',
};

// ═══════════════════════════════════
//  GUEST AGE & LICENSE
// ═══════════════════════════════════
export const GUEST_REQUIREMENTS = {
  minimumAge: 21,
  youngDriverAge: 24,         // 21-24 pays surcharge
  youngDriverSurchargePerDay: 15,
  licenseRequired: true,
  licenseUnrestricted: true,
  internationalAccepted: true,
  internationalRequiresPassport: true,
  description: 'Guests must be at least 21 years old with a valid, unrestricted driver\'s license. Guests aged 21-24 pay a $15/day young driver surcharge. International licenses are accepted with a valid passport. Expired, suspended, or restricted licenses are not accepted.',
};

// ═══════════════════════════════════
//  VEHICLE USE RESTRICTIONS
// ═══════════════════════════════════
export const VEHICLE_RESTRICTIONS = {
  rules: [
    'Only the registered guest may drive the vehicle',
    'No off-road driving',
    'No racing, towing, or commercial use (deliveries, rideshare)',
    'No smoking or vaping (unless listing permits)',
    'No pets (unless listing permits)',
    'No driving under the influence of alcohol or drugs',
    'Must comply with all traffic laws',
    'Must return at the agreed time and location',
    'Must report any accident, damage, or violation immediately',
  ],
  violationVoidsProtection: true,
  description: 'Violation of any vehicle use restriction immediately voids Trip Protection and may result in full financial liability, security deposit forfeiture, and account suspension.',
};

// ═══════════════════════════════════
//  OPTIONAL ADD-ONS (host decides to offer)
// ═══════════════════════════════════
export const OPTIONAL_ADDONS = {
  TIRE_PROTECTION: {
    id: 'TIRE_PROTECTION',
    label: 'Tire Protection',
    pricePerDay: 5,
    hostOffered: true,
    covers: ['Tire blowouts', 'Flat tires', 'Rim damage from road hazards'],
    doesNotCover: ['Pre-existing tire wear', 'Damage from off-road use', 'Cosmetic curb rash'],
    description: 'Covers tire and rim damage from road hazards during your trip. $5/day. Does not cover pre-existing wear or off-road damage.',
  },
  GLASS_PROTECTION: {
    id: 'GLASS_PROTECTION',
    label: 'Glass Protection',
    pricePerDay: 4,
    hostOffered: true,
    covers: ['Windshield chips and cracks', 'Side and rear window damage', 'Mirror glass damage'],
    doesNotCover: ['Pre-existing chips or cracks', 'Damage from intentional acts', 'Sunroof damage'],
    description: 'Covers windshield and window glass damage during your trip. $4/day. Does not cover pre-existing damage.',
  },
  ROADSIDE_ASSISTANCE: {
    id: 'ROADSIDE_ASSISTANCE',
    label: 'Roadside Assistance',
    pricePerDay: 6,
    hostOffered: true,
    covers: ['Towing up to 25 miles', 'Jump start', 'Flat tire change (spare must be available)', 'Lockout service', 'Fuel delivery (up to 2 gallons)'],
    doesNotCover: ['Mechanical repairs', 'Towing beyond 25 miles', 'Off-road recovery', 'Repeated calls (max 2 per trip)'],
    description: 'Roadside assistance including towing, jump start, flat change, lockout, and fuel delivery. $6/day. Max 2 calls per trip.',
  },
  TOLL_PASS: {
    id: 'TOLL_PASS',
    label: 'Toll Pass',
    pricePerDay: 3.50,
    hostOffered: true,
    covers: ['Unlimited toll usage on all toll roads', 'AutoExpreso (Puerto Rico)', 'SunPass (Florida)', 'E-ZPass (Northeast)', 'TxTag (Texas)'],
    doesNotCover: ['Parking fees', 'Traffic violations', 'Toll violations if pass is not activated'],
    description: 'Use the vehicle\'s toll transponder for all tolls during your trip. $3.50/day covers unlimited toll usage. If the vehicle does not have a toll pass, tolls are charged at the posted cash rate + a $5 admin fee per toll.',
    alternativePolicy: 'If the host\'s vehicle has no toll pass, the guest is responsible for tolls. Tolls may be charged to the guest after the trip based on plate-matching records. A $5 administrative fee applies per toll transaction processed after the trip.',
  },
};

// ═══════════════════════════════════
//  TOLL POLICY
// ═══════════════════════════════════
export const TOLL_POLICY = {
  withPass: {
    dailyRate: 3.50,
    unlimited: true,
    description: 'Vehicle has a toll pass. $3.50/day for unlimited toll usage.',
  },
  withoutPass: {
    adminFeePerToll: 5,
    matchingMethod: 'PLATE_MATCH',
    chargeWindow: 'UP_TO_90_DAYS',
    description: 'No toll pass in vehicle. Tolls are matched to your trip by license plate. You will be charged the posted toll rate + $5 admin fee per transaction. Toll charges may appear up to 90 days after your trip.',
  },
  hostResponsibility: 'Hosts should disclose whether their vehicle has an active toll pass in the listing. If the host provides a toll pass, the Toll Pass add-on covers usage fees.',
};

// ═══════════════════════════════════
//  DATA / CHAT USAGE NOTICE
// ═══════════════════════════════════
export const DATA_USAGE_NOTICE = 'All messages, photos, inspection images, GPS location data, and trip activity may be collected, stored, and used as evidence in damage claims, dispute resolution, and policy enforcement. By using the platform, you consent to this data usage as described in our Privacy Policy.';

// ═══════════════════════════════════
//  EXPORT ALL POLICIES
// ═══════════════════════════════════
export function getAllPolicies() {
  return {
    lateReturn: LATE_RETURN_POLICY,
    mileage: MILEAGE_POLICY,
    cancellation: CANCELLATION_POLICY,
    securityDeposit: SECURITY_DEPOSIT_POLICY,
    fuel: FUEL_POLICY,
    cleaning: CLEANING_POLICY,
    accidentProcedure: ACCIDENT_PROCEDURE,
    guestRequirements: GUEST_REQUIREMENTS,
    vehicleRestrictions: VEHICLE_RESTRICTIONS,
    addons: OPTIONAL_ADDONS,
    tolls: TOLL_POLICY,
    dataUsageNotice: DATA_USAGE_NOTICE,
  };
}
