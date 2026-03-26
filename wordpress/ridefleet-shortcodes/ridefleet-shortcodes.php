<?php
/**
 * Plugin Name: Ride Fleet Shortcodes
 * Description: Embeds Ride Fleet booking and vehicle class cards inside an existing WordPress site.
 * Version: 1.0.0
 * Author: Ride Fleet
 */

if (!defined('ABSPATH')) {
    exit;
}

function ridefleet_shortcode_defaults() {
    return array(
        'api_base' => 'https://ridefleetmanager.com',
        'booking_base' => 'https://ridefleetmanager.com/book',
    );
}

function ridefleet_booking_shortcode($atts = array()) {
    $defaults = ridefleet_shortcode_defaults();
    $atts = shortcode_atts(array(
        'tenant_slug' => '',
        'search_mode' => 'RENTAL',
        'height' => '1900',
        'title' => '',
    ), $atts, 'ridefleet_booking');

    $params = array(
        'embed' => '1',
        'searchMode' => strtoupper(trim($atts['search_mode'])) === 'CAR_SHARING' ? 'CAR_SHARING' : 'RENTAL',
    );

    if (!empty($atts['tenant_slug'])) {
        $params['tenantSlug'] = sanitize_text_field($atts['tenant_slug']);
    }

    $iframe_src = add_query_arg($params, trailingslashit($defaults['booking_base']));
    $height = max(900, intval($atts['height']));
    $title = trim($atts['title']) !== '' ? sanitize_text_field($atts['title']) : 'Ride Fleet Booking';

    ob_start();
    ?>
    <div class="ridefleet-booking-shortcode">
      <iframe
        src="<?php echo esc_url($iframe_src); ?>"
        title="<?php echo esc_attr($title); ?>"
        loading="lazy"
        referrerpolicy="strict-origin-when-cross-origin"
        style="width:100%;min-height:<?php echo esc_attr($height); ?>px;border:0;border-radius:24px;background:#ffffff;box-shadow:0 20px 45px rgba(37, 26, 68, 0.12);"
      ></iframe>
    </div>
    <?php
    return ob_get_clean();
}

function ridefleet_vehicle_classes_shortcode($atts = array()) {
    $defaults = ridefleet_shortcode_defaults();
    $atts = shortcode_atts(array(
        'tenant_slug' => '',
        'pickup_location_id' => '',
        'pickup_at' => '',
        'return_at' => '',
        'limit' => '6',
        'title' => 'Available Vehicle Classes',
        'cta_label' => 'Rent Now',
    ), $atts, 'ridefleet_vehicle_classes');

    $query = array(
        'limit' => max(1, min(24, intval($atts['limit']))),
    );
    if (!empty($atts['tenant_slug'])) {
        $query['tenantSlug'] = sanitize_text_field($atts['tenant_slug']);
    }
    if (!empty($atts['pickup_location_id'])) {
        $query['pickupLocationId'] = sanitize_text_field($atts['pickup_location_id']);
    }
    if (!empty($atts['pickup_at'])) {
        $query['pickupAt'] = sanitize_text_field($atts['pickup_at']);
    }
    if (!empty($atts['return_at'])) {
        $query['returnAt'] = sanitize_text_field($atts['return_at']);
    }

    $endpoint = add_query_arg($query, trailingslashit($defaults['api_base']) . 'api/public/booking/vehicle-classes');
    $cache_key = 'ridefleet_classes_' . md5(wp_json_encode($query));
    $payload = get_transient($cache_key);

    if ($payload === false) {
        $response = wp_remote_get($endpoint, array(
            'timeout' => 15,
            'headers' => array(
                'Accept' => 'application/json',
            ),
        ));

        if (is_wp_error($response)) {
            return '<div class="ridefleet-shortcode-error">Unable to load vehicle classes right now.</div>';
        }

        $status = wp_remote_retrieve_response_code($response);
        if ($status < 200 || $status >= 300) {
            return '<div class="ridefleet-shortcode-error">Vehicle classes are temporarily unavailable.</div>';
        }

        $payload = json_decode(wp_remote_retrieve_body($response), true);
        set_transient($cache_key, $payload, 5 * MINUTE_IN_SECONDS);
    }

    $rows = !empty($payload['classes']) && is_array($payload['classes']) ? $payload['classes'] : array();
    $title = sanitize_text_field($atts['title']);
    $cta = sanitize_text_field($atts['cta_label']);

    ob_start();
    ?>
    <section class="ridefleet-classes-shortcode" style="display:grid;gap:18px;">
      <?php if ($title !== '') : ?>
        <div style="display:grid;gap:6px;">
          <div style="font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:#7c3aed;font-weight:700;">Ride Fleet</div>
          <h2 style="margin:0;font-size:clamp(26px,4vw,38px);line-height:1.05;color:#241b41;"><?php echo esc_html($title); ?></h2>
        </div>
      <?php endif; ?>

      <?php if (empty($rows)) : ?>
        <div class="ridefleet-shortcode-empty" style="padding:18px 20px;border-radius:24px;background:linear-gradient(180deg,#ffffff,#f6f1ff);border:1px solid rgba(124,58,237,.12);color:#55456f;">
          No vehicle classes are available right now. Try again after updating rates or pickup dates.
        </div>
      <?php else : ?>
        <div class="ridefleet-classes-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:18px;">
          <?php foreach ($rows as $row) :
              $vehicle_type = !empty($row['vehicleType']) && is_array($row['vehicleType']) ? $row['vehicleType'] : array();
              $featured = !empty($row['featuredLocation']) && is_array($row['featuredLocation']) ? $row['featuredLocation'] : array();
              $rate = isset($row['advertisedDailyRate']) ? number_format((float) $row['advertisedDailyRate'], 2) : '0.00';
              $available_units = isset($row['availableUnits']) ? intval($row['availableUnits']) : 0;
              $image_url = !empty($vehicle_type['imageUrl']) ? esc_url($vehicle_type['imageUrl']) : '';
              $rent_now_url = !empty($row['rentNowUrl']) ? esc_url($row['rentNowUrl']) : esc_url(trailingslashit($defaults['booking_base']));
          ?>
            <article style="display:grid;gap:14px;padding:18px;border-radius:26px;background:linear-gradient(180deg,#ffffff,#f8f3ff);border:1px solid rgba(124,58,237,.12);box-shadow:0 20px 45px rgba(37,26,68,.08);">
              <?php if ($image_url) : ?>
                <img src="<?php echo $image_url; ?>" alt="<?php echo esc_attr($vehicle_type['name'] ?? 'Vehicle class'); ?>" style="width:100%;aspect-ratio:16/10;object-fit:cover;border-radius:18px;border:1px solid rgba(124,58,237,.1);" />
              <?php endif; ?>
              <div style="display:grid;gap:8px;">
                <div style="font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#7c3aed;font-weight:700;">
                  <?php echo esc_html($vehicle_type['code'] ?? 'Vehicle Class'); ?>
                </div>
                <h3 style="margin:0;font-size:24px;line-height:1.1;color:#241b41;"><?php echo esc_html($vehicle_type['name'] ?? 'Vehicle Class'); ?></h3>
                <?php if (!empty($vehicle_type['description'])) : ?>
                  <p style="margin:0;color:#55456f;line-height:1.55;"><?php echo esc_html($vehicle_type['description']); ?></p>
                <?php endif; ?>
              </div>
              <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;">
                <div style="padding:12px 14px;border-radius:16px;background:rgba(255,255,255,.75);border:1px solid rgba(124,58,237,.08);">
                  <div style="font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#7a6b98;">Daily Rate</div>
                  <strong style="display:block;margin-top:6px;font-size:22px;color:#241b41;">$<?php echo esc_html($rate); ?></strong>
                </div>
                <div style="padding:12px 14px;border-radius:16px;background:rgba(255,255,255,.75);border:1px solid rgba(124,58,237,.08);">
                  <div style="font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#7a6b98;">Available</div>
                  <strong style="display:block;margin-top:6px;font-size:22px;color:#241b41;"><?php echo esc_html((string) $available_units); ?></strong>
                </div>
              </div>
              <?php if (!empty($featured['label'])) : ?>
                <div style="font-size:13px;color:#6b5d84;">Pickup focus: <?php echo esc_html($featured['label']); ?></div>
              <?php endif; ?>
              <div>
                <a href="<?php echo $rent_now_url; ?>" style="display:inline-flex;align-items:center;justify-content:center;padding:12px 18px;border-radius:999px;background:linear-gradient(135deg,#7c3aed,#a855f7);color:#ffffff;text-decoration:none;font-weight:700;box-shadow:0 16px 30px rgba(124,58,237,.24);">
                  <?php echo esc_html($cta); ?>
                </a>
              </div>
            </article>
          <?php endforeach; ?>
        </div>
      <?php endif; ?>
    </section>
    <?php
    return ob_get_clean();
}

add_shortcode('ridefleet_booking', 'ridefleet_booking_shortcode');
add_shortcode('ridefleet_vehicle_classes', 'ridefleet_vehicle_classes_shortcode');
