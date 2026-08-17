/**
 * The synthetic screens the public showcase draws.
 *
 * NOT the live application, and deliberately so. A page with no login must not
 * be a door into the product: anything that reads the database becomes public
 * attack surface, and one scoping mistake shows a real customer's name on a
 * marketing site. There is nothing here to leak because nothing here is
 * connected — every figure below is invented.
 *
 * The WORDS are not invented. Titles and body copy come from
 * lib/training/curriculum.js, the same file the tour and the training modules
 * render from, so the marketing narrative cannot drift away from what the
 * product actually teaches. This file only supplies the picture beside them.
 *
 * Every name, plate and amount is fictional. Keep it that way.
 */

export const SCREENS = {
  'the-workspace': {
    kind: 'dashboard',
    tiles: [
      { label: 'Fleet', value: '128' },
      { label: 'Available now', value: '41', tone: 'good' },
      { label: 'On rent', value: '84' },
      { label: 'Overdue', value: '3', tone: 'warn' },
    ],
    rows: [
      ['9:00 AM', 'Pickup', 'Marisol Vega', 'Compact SUV'],
      ['11:30 AM', 'Return', 'Andrés Colón', 'Economy'],
      ['1:15 PM', 'Pickup', 'Damaris Ruiz', 'Full-size SUV'],
      ['4:00 PM', 'Return', 'Joel Santiago', 'Minivan'],
    ],
  },

  'incoming-bookings': {
    kind: 'feed',
    sources: [
      { name: 'Economy', count: 42, state: 'matched' },
      { name: 'NU', count: 27, state: 'matched' },
      { name: 'TL International', count: 9, state: 'matched' },
      { name: 'Flexways', count: 5, state: 'review' },
    ],
    caption: 'Pulled overnight, matched to customers, checked for duplicates.',
  },

  'create-reservation': {
    kind: 'wizard',
    steps: ['Dates & locations', 'Vehicle class', 'Customer', 'Review'],
    active: 1,
    quote: [
      ['Compact SUV · 4 days', '$268.00'],
      ['Airport concession fee', '$32.16'],
      ['Estimated total', '$300.16'],
    ],
  },

  'check-out': {
    kind: 'inspection',
    label: 'Handover',
    angles: ['Front', 'Rear', 'Left', 'Right', 'F. Seat', 'R. Seat', 'Dash', 'Trunk'],
    captured: 8,
    caption: 'Agreement signed, payment taken, eight angles on the record.',
  },

  'check-in': {
    kind: 'fees',
    lines: [
      ['Fuel · 3/8 short', '$41.25'],
      ['Mileage · 62 over', '$18.60'],
      ['Late return · 1 hr', '$25.00'],
      ['Balance due', '$84.85'],
    ],
    caption: 'Computed from the readings as the agent types them.',
  },

  'overdue-returns': {
    kind: 'alert',
    title: '2 overdue vehicles outside their locations',
    rows: [
      ['RES-041577', 'Jeep Wrangler · ABC-123', '12.4 km from SJU'],
      ['RES-812940', 'Toyota Corolla · XYZ-987', '36.8 km from SJU'],
    ],
  },

  'market-pricing': {
    kind: 'market',
    rows: [
      ['Economy', '$38.50', '$41.00', 'below'],
      ['Compact SUV', '$62.00', '$59.75', 'above'],
      ['Standard SUV', '$74.25', '$78.00', 'below'],
      ['Full-size SUV', '$91.00', '$89.50', 'above'],
    ],
    caption: 'Your rate beside the market, refreshed every night.',
  },

  'shuttle-tracker': {
    kind: 'tracker',
    badge: 'EN VIVO',
    location: 'Miami International Airport',
    headway: 'Pasa aproximadamente cada 8 minutos',
    instructions: 'Espera en la columna 4, nivel de llegadas.',
    distance: 'Estás a ~180 m del punto de espera',
    cta: 'Solicitar el shuttle',
  },
};
