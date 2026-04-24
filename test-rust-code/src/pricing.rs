use crate::domain::{CustomerTier, Order, PaymentMethod};

pub fn calculate_loyalty_discount(order: &Order) -> u64 {
    match order.tier {
        CustomerTier::Standard => 0,
        CustomerTier::Gold => order.subtotal() / 20,
        CustomerTier::Platinum => order.subtotal() / 10,
    }
}

pub fn seasonal_adjustment(order: &Order) -> i64 {
    if order
        .items
        .iter()
        .any(|item| item.sku.starts_with("WINTER-"))
    {
        -700
    } else if order
        .items
        .iter()
        .any(|item| item.sku.starts_with("LIMITED-"))
    {
        1_500
    } else {
        0
    }
}

pub fn shipping_cost(order: &Order) -> u64 {
    let base_weight_cost = order
        .items
        .iter()
        .map(|item| item.weight_grams as u64 * item.quantity as u64)
        .sum::<u64>()
        / 8;

    let fragile_surcharge = if order.items.iter().any(|item| item.is_fragile()) {
        1_200
    } else {
        0
    };

    base_weight_cost + fragile_surcharge
}

/// Produces the billable total using loyalty, seasonality, and shipping signals.
pub fn compute_order_total(order: &Order) -> u64 {
    let adjusted_subtotal = (order.subtotal() as i64 + seasonal_adjustment(order)).max(0) as u64;

    adjusted_subtotal
        .saturating_add(shipping_cost(order))
        .saturating_sub(calculate_loyalty_discount(order))
}

pub fn requires_manual_review(order: &Order, total_cents: u64) -> bool {
    total_cents >= 150_000
        || matches!(order.payment_method, PaymentMethod::Invoice) && total_cents >= 80_000
        || matches!(order.payment_method, PaymentMethod::WireTransfer) && order.is_priority()
        || order
            .notes
            .iter()
            .any(|note| note.to_ascii_lowercase().contains("manual"))
}

#[cfg(test)]
mod tests {
    use crate::domain::{CustomerTier, Order, OrderItem, PaymentMethod};

    use super::{compute_order_total, requires_manual_review};

    fn sample_order() -> Order {
        Order::new(
            "order-1",
            "customer-1",
            CustomerTier::Gold,
            PaymentMethod::Invoice,
            vec![OrderItem {
                sku: "WINTER-COAT".to_string(),
                quantity: 2,
                unit_price_cents: 50_000,
                weight_grams: 1_000,
                fragile: false,
            }],
        )
    }

    #[test]
    fn compute_total_applies_adjustments() {
        let order = sample_order();
        assert_eq!(compute_order_total(&order), 94_550);
    }

    #[test]
    fn invoice_order_can_require_review() {
        let order = sample_order();
        assert!(requires_manual_review(&order, compute_order_total(&order)));
    }
}
