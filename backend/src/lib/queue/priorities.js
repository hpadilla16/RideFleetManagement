/**
 * BullMQ priority lanes for RideFleetManagement background jobs.
 *
 * BullMQ priority semantics: jobs are pulled from each queue in priority
 * order, where a LOWER numeric value = HIGHER priority. Jobs with no
 * priority (priority=0 or unset) are treated as the lowest priority and
 * always sit behind any prioritized job.
 *
 * Lanes:
 *   - HIGH   (1)  - autocharge after checkin. Time-sensitive: customer's
 *                   card-on-file authorization is being executed within
 *                   24h of checkin. Cannot be starved by bulk jobs.
 *   - NORMAL (5)  - email-invoice (and other transactional emails when
 *                   they migrate to BullMQ). Should run promptly but
 *                   tolerable behind autocharge.
 *   - LOW    (10) - scraper / sync jobs (toll syncs, vendor pulls). These
 *                   are bulk, retryable, and bandwidth-heavy; they must
 *                   never delay a HIGH or NORMAL job.
 *
 * NOTE: As of PR-4 only `reservation.autocharge-after-checkin` is on
 * BullMQ. Email and scraper run inline / via cron. The NORMAL and LOW
 * constants exist so the migration of those workloads can set priority
 * without re-deriving the lane table.
 *
 * @see https://docs.bullmq.io/guide/jobs/prioritized
 */

export const PRIORITY_HIGH = 1;
export const PRIORITY_NORMAL = 5;
export const PRIORITY_LOW = 10;

// Lane aliases - use these at enqueue sites for readability.
export const AUTOCHARGE_PRIORITY = PRIORITY_HIGH;
export const EMAIL_INVOICE_PRIORITY = PRIORITY_NORMAL;
export const SCRAPER_PRIORITY = PRIORITY_LOW;
