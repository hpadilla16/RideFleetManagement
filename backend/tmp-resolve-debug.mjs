import { ratesService } from './src/modules/rates/rates.service.js';
const out = await ratesService.resolveForRental({
  vehicleTypeId: 'cmm0o55m90003mq5749i4gjeo',
  pickupLocationId: 'cmm0o55lt0000mq5765ffb1t3',
  pickupAt: '2026-02-27T22:19',
  returnAt: '2026-03-03T22:20'
});
console.log(out);
