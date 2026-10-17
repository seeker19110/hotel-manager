// Điểm công khai của module `metering` (ARC-MOD-005): module khác chỉ import qua tệp này, không import tệp nội bộ.
export {
  acknowledgeAnomaly,
  importReading,
  installMeter,
  missingReadings,
  periodConsumptionText,
  priceAt,
  readingRoute,
  readPeriod,
  recordReading,
  replaceMeter,
  setServicePrice,
  unresolvedAnomalies,
} from "./meters.ts";
